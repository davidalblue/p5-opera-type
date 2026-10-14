import { parse, type Font } from 'opentype.js'
import type opentype from 'opentype.js'

// Glyph outlines in font units, y pointing up, baseline at 0
interface Pt {
  x: number
  y: number
}

/** One piece of a closed contour, starting where the previous piece ends. Quadratics are stored as cubics. */
interface Segment {
  line: boolean
  c1: Pt // control points; unused for lines
  c2: Pt
  to: Pt
  // When a curve continues a straight line, the y at that line's far end. The curve's handle is
  // then stretched exactly like the line, so the join stays smooth.
  lineIn?: number
  lineOut?: number
}

interface Contour {
  start: Pt
  segs: Segment[]
}

export interface Glyph {
  contours: Contour[]
  advance: number
  // Horizontal bands the glyph is sliced into. Thin bands hold horizontal strokes
  // (serifs, crossbars, the top and bottom of bowls) and are "locked": they keep their
  // weight while the glyph stretches, so only the stems and bowls get taller.
  breaks: number[]
  locked: boolean[]
  // Per band: how far (font units) the stretch takes to ease in from each edge, so curves
  // crossing from a locked band into a stretching one bend smoothly instead of kinking
  ramps: [number, number][]
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

/** A band of horizontal rows used to measure glyph profiles. */
export interface Rows {
  top: number
  bottom: number
  count: number
}

// Bands thinner than this share of the cap height count as horizontal strokes
const LOCK_THRESHOLD = 0.12
// Distance over which the stretch eases in at the edge of a stretching band, as a share of the cap height.
// Long enough that stretched bowls (O, P, D…) stay oval; shorter values give them boxy shoulders.
const EASE_IN = 0.25
// Glyph cache entries kept before the cache is cleared (variable fonts add an entry per weight/slant)
const CACHE_LIMIT = 4000

/** Values for a variable font's axes, by tag (wght, slnt, …). */
export type AxisValues = Record<string, number>

interface Axis {
  min: number
  max: number
  default: number
}

// The parts of opentype.js 2's variable-font support that its typings don't cover
interface Variable {
  tables: { gvar?: { glyphVariations: unknown[] } }
  variation: { process: { applyTupleVariationStore(data: unknown, points: Point[], coords: AxisValues, flavor: 'gvar', args: object): Point[] } }
}
interface Point {
  x: number
  y: number
  onCurve: boolean
  lastPointOfContour: boolean
}

export class TypeEngine {
  readonly capHeight: number
  private cache = new Map<string, Glyph>()
  private font: Font
  private axes: Record<string, Axis>
  private pinned: AxisValues

  /** `pinned` fixes axes this family doesn't expose, e.g. { CNTR: 100 } for GT Ultra Fine. */
  private constructor(font: Font, pinned: AxisValues) {
    this.font = font
    this.pinned = pinned
    const fvar = font.tables.fvar as { axes?: { tag: string; minValue: number; maxValue: number; defaultValue: number }[] } | undefined
    this.axes = Object.fromEntries(
      (fvar?.axes ?? []).map((a) => [a.tag, { min: a.minValue, max: a.maxValue, default: a.defaultValue }]),
    )
    this.capHeight = font.tables.os2?.sCapHeight || font.charToGlyph('H').getBoundingBox().y2
  }

  static async load(url: string, pinned: AxisValues = {}) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Could not load font ${url} (${res.status})`)
    return TypeEngine.fromBuffer(await res.arrayBuffer(), pinned)
  }

  /** Parses .otf, .ttf or .woff data (opentype.js can't read .woff2). */
  static fromBuffer(data: ArrayBuffer, pinned: AxisValues = {}) {
    const engine = new TypeEngine(parse(data), pinned)
    if (!engine.has('A')) throw new Error('This font has no Latin capitals')
    return engine
  }

  /** The font's own name, if its name table has one. */
  get name(): string | undefined {
    // opentype.js 2 groups names by platform; 1.x kept them flat
    type Names = { fullName?: { en?: string } }
    const all = this.font.names as unknown as Names & Record<string, Names>
    for (const n of [all, all.windows, all.macintosh, all.unicode]) {
      if (n?.fullName?.en) return n.fullName.en
    }
  }

  /** [min, max] of the weight axis, or null when the font has a single weight. */
  get weightRange(): [number, number] | null {
    const a = this.axes.wght
    return a ? [a.min, a.max] : null
  }

  /** How far (in degrees, leaning right) the font's own slant axis goes; 0 if it has none. */
  get maxSlant() {
    const a = this.axes.slnt
    return a ? Math.max(Math.abs(a.min), Math.abs(a.max)) : 0
  }

  /**
   * The glyph for `ch` at a weight and native slant (both ignored by static fonts).
   * Slanted outlines come back with the slant sheared out again, so stretching works on
   * upright shapes and the caller applies the whole italic angle itself.
   */
  glyph(ch: string, weight = 400, slant = 0): Glyph {
    const coords = this.coords(weight, slant)
    const key = coords ? `${ch}|${coords.wght ?? ''}|${coords.slnt ?? ''}` : ch
    let g = this.cache.get(key)
    if (!g) {
      if (this.cache.size > CACHE_LIMIT) this.cache.clear()
      g = this.analyze(ch, coords)
      this.cache.set(key, g)
    }
    return g
  }

  has(ch: string) {
    return ch === ' ' || this.font.charToGlyph(ch).index > 0
  }

  kerning(a: string, b: string) {
    return this.font.getKerningValue(this.font.charToGlyph(a), this.font.charToGlyph(b))
  }

  private coords(weight: number, slant: number): AxisValues | null {
    if (!Object.keys(this.axes).length) return null
    const c: AxisValues = {}
    for (const [tag, a] of Object.entries(this.axes)) c[tag] = a.default
    Object.assign(c, this.pinned)
    const { wght, slnt } = this.axes
    if (wght) c.wght = Math.round(Math.min(wght.max, Math.max(wght.min, weight)))
    if (slnt) {
      // half-degree steps keep the cache small; the difference isn't visible
      const n = Math.round(Math.min(this.maxSlant, Math.max(0, slant)) * 2) / 2
      // spec-following fonts use negative slnt for a right lean, some (GT Ultra) use positive
      c.slnt = slnt.max > 0 ? n : -n
    }
    return c
  }

  private analyze(ch: string, coords: AxisValues | null): Glyph {
    const glyph = this.font.charToGlyph(ch)
    const upm = this.font.unitsPerEm
    const path = coords
      ? (glyph.getPath as (...a: unknown[]) => opentype.Path)(0, 0, upm, { variation: coords }, this.font)
      : glyph.getPath(0, 0, upm)
    const contours = toContours(path.commands)
    if (coords?.slnt) unshear(contours, Math.tan((Math.abs(coords.slnt) * Math.PI) / 180))
    const advance = coords ? this.variedAdvance(glyph, coords) : (glyph.advanceWidth ?? 0)
    const C = this.capHeight

    // y positions of horizontal edges: flat lines, and curves leaving or arriving horizontally
    const edges: number[] = []
    let minY = 0
    let maxY = C
    for (const { start, segs } of contours) {
      let p = start
      for (const seg of segs) {
        const { to } = seg
        if (seg.line) {
          const dx = Math.abs(to.x - p.x)
          if (dx > 4 && Math.abs(to.y - p.y) <= 0.1 * dx) edges.push((to.y + p.y) / 2)
        } else {
          if (Math.abs(seg.c1.x - p.x) > 1 && Math.abs(seg.c1.y - p.y) < 1.5) edges.push(p.y)
          if (Math.abs(seg.c2.x - to.x) > 1 && Math.abs(seg.c2.y - to.y) < 1.5) edges.push(to.y)
        }
        minY = Math.min(minY, to.y)
        maxY = Math.max(maxY, to.y)
        p = to
      }
    }
    edges.push(minY, maxY)

    // 0 and the cap height are always breaks, so the baseline and cap line map exactly
    const breaks = [0, C]
    for (const y of edges.sort((a, b) => a - b)) {
      if (breaks.every((b) => Math.abs(b - y) > 2)) breaks.push(y)
    }
    breaks.sort((a, b) => a - b)
    const locked = breaks.slice(1).map((b, i) => b - breaks[i] < LOCK_THRESHOLD * C)

    // Bands that stretch: between baseline and cap height and not locked. Their stretch eases in
    // from the edges that border a non-stretching band.
    const stretches = (i: number) => i >= 0 && i < locked.length && breaks[i] >= 0 && breaks[i + 1] <= C && !locked[i]
    const ramps = locked.map((_, i): [number, number] => {
      if (!stretches(i)) return [0, 0]
      const w = Math.min(EASE_IN * C, (breaks[i + 1] - breaks[i]) / 2)
      return [stretches(i - 1) ? 0 : w, stretches(i + 1) ? 0 : w]
    })

    // Split curves wherever the stretch changes character, so every piece maps cleanly
    const levels = new Set(breaks)
    ramps.forEach(([l, r], i) => {
      if (l) [breaks[i] + l / 2, breaks[i] + l].forEach((y) => levels.add(y))
      if (r) [breaks[i + 1] - r, breaks[i + 1] - r / 2].forEach((y) => levels.add(y))
    })
    for (const contour of contours) contour.segs = contour.segs.flatMap((seg, i) => splitAtLevels(seg, i ? contour.segs[i - 1].to : contour.start, [...levels]))
    markLineJoins(contours)

    return { contours, advance, breaks, locked, ramps }
  }

  /**
   * Vertical remap for a stretched glyph: locked bands grow like the width (sx), stretching bands
   * absorb the rest so the cap height becomes C·sy. Anything outside baseline–cap height
   * (overshoots, descenders) grows like the width too. The growth rate eases in over each
   * stretching band's ramps, which keeps the remap smooth (no sudden change of rate).
   */
  private yMap(g: Glyph, { sx, sy }: Stretch) {
    const { breaks, locked, ramps } = g
    const C = this.capHeight
    const stretches = (i: number) => breaks[i] >= 0 && breaks[i + 1] <= C && !locked[i]
    let fixedLen = 0 // grows at sx: locked bands plus half of every ramp
    let freeLen = 0 // grows at k
    for (let i = 0; i < locked.length; i++) {
      if (breaks[i] < 0 || breaks[i + 1] > C) continue
      const len = breaks[i + 1] - breaks[i]
      if (!stretches(i)) fixedLen += len
      else {
        const half = (ramps[i][0] + ramps[i][1]) / 2
        fixedLen += half
        freeLen += len - half
      }
    }
    if (freeLen < 1) return { f: (y: number) => y * sy, slope: () => sy }
    const k = (C * sy - sx * fixedLen) / freeLen

    // growth rate d units into band i, and its integral
    const rate = (i: number, d: number) => {
      if (i < 0 || i >= locked.length || !stretches(i)) return sx
      const [l, r] = ramps[i]
      const len = breaks[i + 1] - breaks[i]
      if (d < l) return sx + ((k - sx) * d) / l
      if (d > len - r) return k - ((k - sx) * (d - (len - r))) / r
      return k
    }
    const integral = (i: number, d: number) => {
      if (i < 0 || i >= locked.length || !stretches(i)) return sx * d
      const [l, r] = ramps[i]
      const len = breaks[i + 1] - breaks[i]
      const a = Math.min(d, l)
      let sum = sx * a + (l ? ((k - sx) * a * a) / (2 * l) : 0)
      if (d > l) sum += k * (Math.min(d, len - r) - l)
      if (d > len - r) {
        const t = d - (len - r)
        sum += k * t - ((k - sx) * t * t) / (2 * r)
      }
      return sum
    }

    const mapped: number[] = new Array(breaks.length)
    const zero = breaks.indexOf(0)
    mapped[zero] = 0
    for (let i = zero; i < breaks.length - 1; i++) mapped[i + 1] = mapped[i] + integral(i, breaks[i + 1] - breaks[i])
    for (let i = zero - 1; i >= 0; i--) mapped[i] = mapped[i + 1] - integral(i, breaks[i + 1] - breaks[i])

    const last = breaks.length - 1
    const band = (y: number) => {
      let i = 0
      while (i < last - 1 && breaks[i + 1] < y) i++
      return i
    }
    return {
      f: (y: number) => {
        if (y <= breaks[0]) return mapped[0] + (y - breaks[0]) * sx
        if (y >= breaks[last]) return mapped[last] + (y - breaks[last]) * sx
        const i = band(y)
        return mapped[i] + integral(i, y - breaks[i])
      },
      /** How fast f grows at y. */
      slope: (y: number) => {
        if (y <= breaks[0] || y >= breaks[last]) return sx
        const i = band(y)
        return rate(i, y - breaks[i])
      },
    }
  }

  /** SVG path data for a stretched, slanted glyph — usable in <path d> and new Path2D(). */
  path(g: Glyph, stretch: Stretch, at: Placement) {
    const { point, handle } = this.mapper(g, stretch, at)
    const xy = ([x, y]: [number, number]) => `${x.toFixed(2)} ${y.toFixed(2)}`
    let d = ''
    for (const { start, segs } of g.contours) {
      d += `M${xy(point(start))}`
      let p = start
      for (const seg of segs) {
        if (seg.line) d += `L${xy(point(seg.to))}`
        else d += `C${xy(handle(p, seg.c1, seg.lineIn))} ${xy(handle(seg.to, seg.c2, seg.lineOut))} ${xy(point(seg.to))}`
        p = seg.to
      }
      d += 'Z'
    }
    return d
  }

  /**
   * Where the glyph's ink sits in each horizontal row of `rows`, in the same space as `at`:
   * left[r] / right[r] are its leftmost and rightmost x, or ±Infinity where the row is empty.
   */
  profile(g: Glyph, stretch: Stretch, at: Placement, rows: Rows) {
    const { point, handle } = this.mapper(g, stretch, at)
    const left = new Float64Array(rows.count).fill(Infinity)
    const right = new Float64Array(rows.count).fill(-Infinity)
    const rowH = (rows.bottom - rows.top) / rows.count
    const add = (X: number, Y: number) => {
      const r = Math.floor((Y - rows.top) / rowH)
      if (r < 0 || r >= rows.count) return
      if (X < left[r]) left[r] = X
      if (X > right[r]) right[r] = X
    }
    // Sample each (already mapped) segment finely enough that samples are under half a row apart
    const sample = (pts: [number, number][]) => {
      let reach = 0
      for (let i = 1; i < pts.length; i++) reach += Math.abs(pts[i][1] - pts[i - 1][1])
      const n = Math.min(256, Math.ceil(reach / (rowH / 2)) + 1)
      for (let i = 0; i <= n; i++) {
        const t = i / n
        const u = 1 - t
        if (pts.length === 2) add(u * pts[0][0] + t * pts[1][0], u * pts[0][1] + t * pts[1][1])
        else {
          const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
          add(
            a * pts[0][0] + b * pts[1][0] + c * pts[2][0] + d * pts[3][0],
            a * pts[0][1] + b * pts[1][1] + c * pts[2][1] + d * pts[3][1],
          )
        }
      }
    }
    for (const { start, segs } of g.contours) {
      let p = start
      let P = point(p)
      for (const seg of segs) {
        const Q = point(seg.to)
        sample(seg.line ? [P, Q] : [P, handle(p, seg.c1, seg.lineIn), handle(seg.to, seg.c2, seg.lineOut), Q])
        p = seg.to
        P = Q
      }
    }
    return { left, right }
  }

  /**
   * Maps outline points (font units) into the space of `at`: stretched, scaled, slanted and placed.
   * On-curve points go through the vertical remap; each control point instead moves with its
   * on-curve point, scaled by how fast the remap grows right there (or like the straight segment
   * the curve continues). Both handles of a smooth join are then scaled alike and stay aligned,
   * so curves don't pick up corners where they cross from one band into another.
   */
  private mapper(g: Glyph, stretch: Stretch, at: Placement) {
    const { f, slope } = this.yMap(g, stretch)
    const place = (X: number, Y: number): [number, number] => {
      const y = at.baseline - Y * at.scale
      return [at.x + X * at.scale + (at.pivot - y) * at.slant, y]
    }
    const point = (p: Pt) => place(p.x * stretch.sx, f(p.y))
    const handle = (p: Pt, h: Pt, lineY?: number) => {
      const s = lineY !== undefined && Math.abs(lineY - p.y) > 1 ? (f(lineY) - f(p.y)) / (lineY - p.y) : slope(p.y)
      return place(h.x * stretch.sx, f(p.y) + (h.y - p.y) * s)
    }
    return { point, handle }
  }

  /**
   * Advance width at the given axis values. opentype.js doesn't vary advances without an
   * HVAR table, so run the four gvar "phantom points" (whose x deltas move the advance) through it.
   */
  private variedAdvance(glyph: opentype.Glyph, coords: AxisValues) {
    const font = this.font as unknown as Variable
    const g = glyph as opentype.Glyph & { points?: Point[]; isComposite?: boolean; xMin?: number; leftSideBearing?: number }
    const data = font.tables.gvar?.glyphVariations[glyph.index]
    const advance = glyph.advanceWidth ?? 0
    if (!data || !g.points?.length || g.isComposite) return advance
    const origin = (g.xMin ?? 0) - (g.leftSideBearing ?? 0)
    const phantom = [origin, origin + advance, 0, 0].map((x) => ({ x, y: 0, onCurve: true, lastPointOfContour: true }))
    const out = font.variation.process.applyTupleVariationStore(data, [...g.points, ...phantom], coords, 'gvar', { glyph })
    const n = g.points.length
    return out[n + 1].x - out[n].x
  }
}

/** Removes a right-leaning slant in place (shears around the baseline). */
function unshear(contours: Contour[], tan: number) {
  const fix = (p: Pt) => (p.x -= p.y * tan)
  for (const { start, segs } of contours) {
    fix(start)
    // a line's c1/c2 are its neighbours' points, which get fixed through them
    for (const seg of segs) (seg.line ? [seg.to] : [seg.c1, seg.c2, seg.to]).forEach(fix)
  }
}

type PathCommand = { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }

/**
 * Turns opentype.js path commands (y down) into closed contours with y up. Quadratic curves
 * become the equivalent cubics, so every curve has one handle per end.
 */
function toContours(commands: PathCommand[]): Contour[] {
  const contours: Contour[] = []
  let cur: Contour | null = null
  let p: Pt = { x: 0, y: 0 }
  const close = () => {
    if (cur && (Math.abs(p.x - cur.start.x) > 0.01 || Math.abs(p.y - cur.start.y) > 0.01)) {
      cur.segs.push({ line: true, c1: p, c2: cur.start, to: { ...cur.start } })
    }
    if (cur) p = cur.start
    cur = null
  }
  for (const c of commands) {
    if (c.type === 'M') {
      close()
      cur = { start: { x: c.x!, y: -c.y! }, segs: [] }
      contours.push(cur)
      p = { ...cur.start }
      continue
    }
    if (c.type === 'Z') {
      close()
      continue
    }
    if (!cur) continue
    const to = { x: c.x!, y: -c.y! }
    if (c.type === 'L') {
      if (Math.abs(to.x - p.x) > 0.01 || Math.abs(to.y - p.y) > 0.01) cur.segs.push({ line: true, c1: p, c2: to, to })
    } else if (c.type === 'Q') {
      const q = { x: c.x1!, y: -c.y1! }
      const c1 = { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) }
      const c2 = { x: to.x + (2 / 3) * (q.x - to.x), y: to.y + (2 / 3) * (q.y - to.y) }
      cur.segs.push({ line: false, c1, c2, to })
    } else if (c.type === 'C') {
      cur.segs.push({ line: false, c1: { x: c.x1!, y: -c.y1! }, c2: { x: c.x2!, y: -c.y2! }, to })
    }
    p = to
  }
  close()

  return contours.filter((c) => c.segs.length)
}

/** Notes which curves continue a straight line, so their handles can follow that line. */
function markLineJoins(contours: Contour[]) {
  for (const { start, segs } of contours) {
    const n = segs.length
    const from = (i: number) => (i === 0 ? start : segs[i - 1].to)
    segs.forEach((seg, i) => {
      if (seg.line) return
      const prev = (i - 1 + n) % n
      const next = (i + 1) % n
      seg.lineIn = segs[prev].line ? from(prev).y : undefined
      seg.lineOut = segs[next].line ? segs[next].to.y : undefined
    })
  }
}

/** Splits a curve (starting at `from`) wherever it crosses one of the horizontal `levels`. Lines are left whole. */
function splitAtLevels(seg: Segment, from: Pt, levels: number[]): Segment[] {
  if (seg.line) return [seg]
  const pts = [from, seg.c1, seg.c2, seg.to]
  const y = (t: number) => {
    const u = 1 - t
    return u * u * u * pts[0].y + 3 * u * u * t * pts[1].y + 3 * u * t * t * pts[2].y + t * t * t * pts[3].y
  }
  const lo = Math.min(...pts.map((p) => p.y))
  const hi = Math.max(...pts.map((p) => p.y))
  const ts: number[] = []
  const STEPS = 32
  for (const level of levels) {
    if (level <= lo || level >= hi) continue
    for (let i = 0; i < STEPS; i++) {
      let a = i / STEPS
      let b = (i + 1) / STEPS
      if ((y(a) - level) * (y(b) - level) > 0) continue
      for (let n = 0; n < 40; n++) {
        const m = (a + b) / 2
        if ((y(a) - level) * (y(m) - level) <= 0) b = m
        else a = m
      }
      const t = (a + b) / 2
      if (t > 1e-4 && t < 1 - 1e-4 && ts.every((s) => Math.abs(s - t) > 1e-4)) ts.push(t)
    }
  }
  if (!ts.length) return [seg]
  ts.sort((a, b) => a - b)

  // de Casteljau, cutting off one piece at a time
  const out: Segment[] = []
  let [p0, p1, p2, p3] = pts
  let done = 0
  for (const t of ts) {
    const u = (t - done) / (1 - done)
    const lerp = (a: Pt, b: Pt) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u })
    const a = lerp(p0, p1)
    const b = lerp(p1, p2)
    const c = lerp(p2, p3)
    const d = lerp(a, b)
    const e = lerp(b, c)
    const mid = lerp(d, e)
    out.push({ line: false, c1: a, c2: d, to: mid })
    ;[p0, p1, p2, p3] = [mid, e, c, p3]
    done = t
  }
  out.push({ line: false, c1: p1, c2: p2, to: seg.to })
  return out
}
