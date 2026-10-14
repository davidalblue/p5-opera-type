import { parse, type Font } from 'opentype.js'

// Glyph outlines in font units, y pointing up, baseline at 0
type Cmd =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' }

export interface Glyph {
  cmds: Cmd[]
  advance: number
  // Horizontal bands the glyph is sliced into. Thin bands hold horizontal strokes
  // (serifs, crossbars, the top and bottom of bowls) and are "locked": they keep their
  // weight while the glyph stretches, so only the stems and bowls get taller.
  breaks: number[]
  locked: boolean[]
}

/** How much a glyph grows: sy scales the cap height, sx the width (and the weight of horizontal strokes). */
export interface Stretch {
  sx: number
  sy: number
}

/** Where a glyph lands on screen, in pixels. */
export interface Placement {
  x: number // left edge of the advance box
  baseline: number
  scale: number // px per font unit
  pivot: number // y of the line the slant pivots around
  slant: number // tan of the italic angle
}

// Bands thinner than this share of the cap height count as horizontal strokes
const LOCK_THRESHOLD = 0.12

export class TypeEngine {
  readonly capHeight: number
  private cache = new Map<string, Glyph>()
  private font: Font

  private constructor(font: Font) {
    this.font = font
    this.capHeight = font.tables.os2?.sCapHeight || font.charToGlyph('H').getBoundingBox().y2
  }

  static async load(url: string) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Could not load font ${url} (${res.status})`)
    return new TypeEngine(parse(await res.arrayBuffer()))
  }

  glyph(ch: string): Glyph {
    let g = this.cache.get(ch)
    if (!g) {
      g = this.analyze(ch)
      this.cache.set(ch, g)
    }
    return g
  }

  has(ch: string) {
    return ch === ' ' || this.font.charToGlyph(ch).index > 0
  }

  kerning(a: string, b: string) {
    return this.font.getKerningValue(this.font.charToGlyph(a), this.font.charToGlyph(b))
  }

  private analyze(ch: string): Glyph {
    const glyph = this.font.charToGlyph(ch)
    const upm = this.font.unitsPerEm
    const cmds = glyph.getPath(0, 0, upm).commands.map(flipY)
    const C = this.capHeight

    const edges: number[] = []
    let px = 0
    let py = 0
    let sx = 0
    let sy = 0
    const line = (x: number, y: number) => {
      if (Math.abs(x - px) > 4 && Math.abs(y - py) <= 0.1 * Math.abs(x - px)) edges.push((y + py) / 2)
    }
    const flat = (cx: number, cy: number, x: number, y: number) => {
      if (Math.abs(cx - x) > 1 && Math.abs(cy - y) < 1.5) edges.push(y)
    }
    let minY = 0
    let maxY = C
    for (const c of cmds) {
      if (c.type === 'Z') {
        line(sx, sy)
        px = sx
        py = sy
        continue
      }
      if (c.type === 'M') {
        sx = c.x
        sy = c.y
      } else if (c.type === 'L') {
        line(c.x, c.y)
      } else if (c.type === 'Q') {
        flat(c.x1, c.y1, px, py)
        flat(c.x1, c.y1, c.x, c.y)
      } else {
        flat(c.x1, c.y1, px, py)
        flat(c.x2, c.y2, c.x, c.y)
      }
      px = c.x
      py = c.y
      minY = Math.min(minY, c.y)
      maxY = Math.max(maxY, c.y)
    }
    edges.push(minY, maxY)

    // 0 and the cap height are always breaks, so the baseline and cap line map exactly
    const breaks = [0, C]
    for (const y of edges.sort((a, b) => a - b)) {
      if (breaks.every((b) => Math.abs(b - y) > 2)) breaks.push(y)
    }
    breaks.sort((a, b) => a - b)
    const locked = breaks.slice(1).map((b, i) => b - breaks[i] < LOCK_THRESHOLD * C)
    return { cmds, advance: glyph.advanceWidth ?? 0, breaks, locked }
  }

  /**
   * Vertical remap for a stretched glyph: locked bands grow like the width (sx),
   * free bands between baseline and cap height absorb the rest so the cap height becomes C·sy.
   * Anything outside baseline–cap height (overshoots, descenders) grows like the width too.
   */
  private yMap(g: Glyph, { sx, sy }: Stretch) {
    const { breaks, locked } = g
    const C = this.capHeight
    const inside = (i: number) => breaks[i] >= 0 && breaks[i + 1] <= C
    let lockedLen = 0
    let freeLen = 0
    for (let i = 0; i < locked.length; i++) {
      if (!inside(i)) continue
      const len = breaks[i + 1] - breaks[i]
      if (locked[i]) lockedLen += len
      else freeLen += len
    }
    if (freeLen < 1) return (y: number) => y * sy

    const k = (C * sy - sx * lockedLen) / freeLen
    const rate = (i: number) => (inside(i) && !locked[i] ? k : sx)
    const mapped: number[] = new Array(breaks.length)
    const zero = breaks.indexOf(0)
    mapped[zero] = 0
    for (let i = zero; i < breaks.length - 1; i++) mapped[i + 1] = mapped[i] + (breaks[i + 1] - breaks[i]) * rate(i)
    for (let i = zero - 1; i >= 0; i--) mapped[i] = mapped[i + 1] - (breaks[i + 1] - breaks[i]) * rate(i)

    const last = breaks.length - 1
    return (y: number) => {
      if (y <= breaks[0]) return mapped[0] + (y - breaks[0]) * sx
      if (y >= breaks[last]) return mapped[last] + (y - breaks[last]) * sx
      let i = 0
      while (breaks[i + 1] < y) i++
      return mapped[i] + (y - breaks[i]) * rate(i)
    }
  }

  /** SVG path data for a stretched, slanted glyph — usable in <path d> and new Path2D(). */
  path(g: Glyph, stretch: Stretch, at: Placement) {
    const f = this.yMap(g, stretch)
    const pt = (x: number, y: number) => {
      const Y = at.baseline - f(y) * at.scale
      const X = at.x + x * stretch.sx * at.scale + (at.pivot - Y) * at.slant
      return `${X.toFixed(2)} ${Y.toFixed(2)}`
    }
    let d = ''
    for (const c of g.cmds) {
      if (c.type === 'Z') d += 'Z'
      else if (c.type === 'M' || c.type === 'L') d += `${c.type}${pt(c.x, c.y)}`
      else if (c.type === 'Q') d += `Q${pt(c.x1, c.y1)} ${pt(c.x, c.y)}`
      else d += `C${pt(c.x1, c.y1)} ${pt(c.x2, c.y2)} ${pt(c.x, c.y)}`
    }
    return d
  }
}

function flipY(c: { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }): Cmd {
  switch (c.type) {
    case 'M':
    case 'L':
      return { type: c.type as 'M' | 'L', x: c.x!, y: -c.y! } as Cmd
    case 'Q':
      return { type: 'Q', x1: c.x1!, y1: -c.y1!, x: c.x!, y: -c.y! }
    case 'C':
      return { type: 'C', x1: c.x1!, y1: -c.y1!, x2: c.x2!, y2: -c.y2!, x: c.x!, y: -c.y! }
    default:
      return { type: 'Z' }
  }
}
