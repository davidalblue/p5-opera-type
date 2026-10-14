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
  // When a curve continues a straight line, that line's far end. The curve's handle is then
  // stretched exactly like the line, so the join stays smooth.
  lineIn?: Pt
  lineOut?: Pt
}

type XY = [number, number]

interface Contour {
  start: Pt
  segs: Segment[]
}

/**
 * A glyph sliced into horizontal bands at its horizontal stroke edges. Thin bands are strokes
 * (crossbars, serifs, the tops and bottoms of bowls) and are "locked": they keep their thickness.
 * Only the open bands in between stretch.
 */
interface Bands {
  breaks: number[]
  locked: boolean[]
  // Per band: a straight horizontal stroke (crossbar, arm, serif — bounded by a flat line), which
  // keeps its thickness exactly, as opposed to the curved top or bottom of a bowl, which grows
  // with the letter like the rest of its strokes so bowls stay round
  flat: boolean[]
  // Per band: how far (font units) the stretch takes to ease in from each edge, so curves
  // crossing from a stroke into an open band bend smoothly instead of kinking
  ramps: [number, number][]
  // The span that's stretched to its target size: baseline to cap height
  lo: number
  hi: number
}

export interface Glyph {
  contours: Contour[]
  advance: number
  bands: Bands
}

/**
 * How much a glyph grows: sy scales its cap height and sx its width. Strokes get w times thicker
 * (1 keeps the font's own thickness): stems by drawing the glyph from a lighter weight (see
 * TypeEngine.weightFor), the curved tops and bottoms of bowls through the band remap. Straight
 * horizontal strokes (crossbars, arms, serifs) always keep the font's thickness.
 */
export interface Stretch {
  sx: number
  sy: number
  w: number
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

// A band counts as a stroke when it's thinner than this many times the font's own stem
// (vertical) or crossbar (horizontal) thickness at the current weight…
const STROKE_FACTOR = 1.5
// …or, for horizontal strokes, thinner than this share of the cap height
const MIN_STROKE = 0.12
// Flat lines shorter than this share of the cap height (the inside of an A's apex, the point of
// a V) are corners, not the edges of horizontal strokes
const MIN_FLAT = 0.05
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
  private strokes = new Map<string, { stem: number; bar: number }>()
  private stems: { weight: number; stem: number }[] | null = null
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

  /**
   * The weight whose stems are `ratio` times as thick as those at `weight` — how condensed and
   * extended styles keep their colour. A letter stretched sx times wider is drawn from
   * weightFor(weight, 1 / sx), so after stretching its stems are as thick as the font's own.
   * Clamped to the weight axis; fonts without one just get `weight` back.
   */
  weightFor(weight: number, ratio: number) {
    const range = this.weightRange
    if (!range || Math.abs(ratio - 1) < 1e-3) return weight
    // stem thickness across the weight axis, measured once
    this.stems ??= Array.from({ length: 33 }, (_, i) => {
      const w = range[0] + ((range[1] - range[0]) * i) / 32
      return { weight: w, stem: this.strokeSizes(this.coords(w, 0)).stem }
    })
    const curve = this.stems
    const at = (w: number) => {
      const i = Math.min(curve.length - 2, Math.max(0, Math.floor(((w - range[0]) / (range[1] - range[0])) * 32)))
      const a = curve[i]
      const b = curve[i + 1]
      return a.stem + ((b.stem - a.stem) * (w - a.weight)) / (b.weight - a.weight)
    }
    const target = at(Math.min(range[1], Math.max(range[0], weight))) * ratio
    if (target <= curve[0].stem) return range[0]
    if (target >= curve[curve.length - 1].stem) return range[1]
    for (let i = 0; i < curve.length - 1; i++) {
      const a = curve[i]
      const b = curve[i + 1]
      if (target >= a.stem && target <= b.stem) {
        return b.stem === a.stem ? a.weight : a.weight + ((b.weight - a.weight) * (target - a.stem)) / (b.stem - a.stem)
      }
    }
    return weight
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

  /** Outline of `ch` at the axis values, as contours with y up and any native slant removed. */
  private outline(ch: string, coords: AxisValues | null) {
    const glyph = this.font.charToGlyph(ch)
    const upm = this.font.unitsPerEm
    const path = coords
      ? (glyph.getPath as (...a: unknown[]) => opentype.Path)(0, 0, upm, { variation: coords }, this.font)
      : glyph.getPath(0, 0, upm)
    const contours = toContours(path.commands)
    if (coords?.slnt) unshear(contours, Math.tan((Math.abs(coords.slnt) * Math.PI) / 180))
    return { glyph, contours }
  }

  /**
   * The font's stem and crossbar thickness at these axis values, measured across the middle of
   * "I" and "H". Used to tell strokes (keep their thickness) from open space (stretches).
   */
  private strokeSizes(coords: AxisValues | null) {
    const key = coords ? `${coords.wght ?? ''}|${coords.slnt ?? ''}` : ''
    let sizes = this.strokes.get(key)
    if (!sizes) {
      const C = this.capHeight
      const run = (ch: string, axis: 'x' | 'y', at: number) => {
        if (!this.has(ch)) return 0
        const hits = crossings(this.outline(ch, coords).contours, axis, at)
        return hits.length >= 2 ? hits[1] - hits[0] : 0
      }
      const h = this.outline('H', coords).contours
      const xs = h.flatMap((c) => [c.start.x, ...c.segs.map((s) => s.to.x)])
      const mid = (Math.min(...xs) + Math.max(...xs)) / 2
      sizes = { stem: run('I', 'y', C / 2) || 0.1 * C, bar: run('H', 'x', mid) || 0.05 * C }
      this.strokes.set(key, sizes)
    }
    return sizes
  }

  private analyze(ch: string, coords: AxisValues | null): Glyph {
    const { glyph, contours } = this.outline(ch, coords)
    const advance = coords ? this.variedAdvance(glyph, coords) : (glyph.advanceWidth ?? 0)
    const C = this.capHeight
    const { bar } = this.strokeSizes(coords)

    // Horizontal stroke edges: flat lines, and curves leaving or arriving horizontally
    // (the tops and bottoms of bowls)
    const yEdges: Edge[] = []
    let minY = 0
    let maxY = C
    for (const { start, segs } of contours) {
      let p = start
      for (const seg of segs) {
        const { to } = seg
        const dx = Math.abs(to.x - p.x)
        if (seg.line) {
          if (dx > MIN_FLAT * C && Math.abs(to.y - p.y) <= 0.1 * dx) yEdges.push({ y: (to.y + p.y) / 2, flat: true })
        } else {
          if (Math.abs(seg.c1.x - p.x) > 1 && Math.abs(seg.c1.y - p.y) < 1.5) yEdges.push({ y: p.y, flat: false })
          if (Math.abs(seg.c2.x - to.x) > 1 && Math.abs(seg.c2.y - to.y) < 1.5) yEdges.push({ y: to.y, flat: false })
        }
        for (const q of seg.line ? [to] : [seg.c1, seg.c2, to]) {
          minY = Math.min(minY, q.y)
          maxY = Math.max(maxY, q.y)
        }
        p = to
      }
    }
    yEdges.push({ y: minY, flat: false }, { y: maxY, flat: false })

    // 0 and the cap height are always breaks, so the baseline and cap line map exactly
    // the heights curves span, so ease-ins are only added where a curve passes through
    const curves: [number, number][] = []
    for (const { start, segs } of contours) {
      segs.forEach((seg, i) => {
        if (seg.line) return
        const ys = [(i ? segs[i - 1].to : start).y, seg.c1.y, seg.c2.y, seg.to.y]
        curves.push([Math.min(...ys), Math.max(...ys)])
      })
    }
    const bands = makeBands(yEdges, 0, C, Math.max(MIN_STROKE * C, STROKE_FACTOR * bar), C, curves)

    // Split curves wherever the stretch changes character, so every piece maps cleanly
    const levels = levelsOf(bands)
    for (const contour of contours) {
      contour.segs = contour.segs.flatMap((seg, i) => splitAtLevels(seg, i ? contour.segs[i - 1].to : contour.start, levels))
    }
    markLineJoins(contours)

    return { contours, advance, bands }
  }

  /** Advance width of the stretched glyph. */
  advance(g: Glyph, stretch: Stretch) {
    return g.advance * stretch.sx
  }

  /** SVG path data for a stretched, slanted glyph — usable in <path d> and new Path2D(). */
  path(g: Glyph, stretch: Stretch, at: Placement) {
    const xy = ([x, y]: XY) => `${x.toFixed(2)} ${y.toFixed(2)}`
    let d = ''
    for (const { start, segs } of this.transform(g, stretch, at)) {
      d += `M${xy(start)}`
      for (const seg of segs) d += seg.line ? `L${xy(seg.to)}` : `C${xy(seg.c1)} ${xy(seg.c2)} ${xy(seg.to)}`
      d += 'Z'
    }
    return d
  }

  /**
   * Where the glyph's ink sits in each horizontal row of `rows`, in the same space as `at`:
   * left[r] / right[r] are its leftmost and rightmost x, or ±Infinity where the row is empty.
   */
  profile(g: Glyph, stretch: Stretch, at: Placement, rows: Rows) {
    const left = new Float64Array(rows.count).fill(Infinity)
    const right = new Float64Array(rows.count).fill(-Infinity)
    const rowH = (rows.bottom - rows.top) / rows.count
    const add = (X: number, Y: number) => {
      const r = Math.floor((Y - rows.top) / rowH)
      if (r < 0 || r >= rows.count) return
      if (X < left[r]) left[r] = X
      if (X > right[r]) right[r] = X
    }
    // Sample each segment finely enough that samples are under half a row apart
    const sample = (pts: XY[]) => {
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
    for (const { start, segs } of this.transform(g, stretch, at)) {
      let p = start
      for (const seg of segs) {
        sample(seg.line ? [p, seg.to] : [p, seg.c1, seg.c2, seg.to])
        p = seg.to
      }
    }
    return { left, right }
  }

  /**
   * The glyph's outline stretched, scaled, slanted and placed into the space of `at`. Points are
   * scaled across by sx and go through the band remap up, which stretches the open bands while
   * horizontal strokes keep their thickness. Control points move with their on-curve point,
   * scaled by how fast the remap grows right there (or like the straight segment the curve
   * continues), so smooth joins stay smooth.
   */
  private transform(g: Glyph, stretch: Stretch, at: Placement) {
    const Y = bandMap(g.bands, stretch.sy, stretch.w)
    const place = (px: number, py: number): XY => {
      const y = at.baseline - py * at.scale
      return [at.x + px * stretch.sx * at.scale + (at.pivot - y) * at.slant, y]
    }
    return g.contours.map(({ start, segs }) => {
      const point = (p: Pt) => place(p.x, Y.f(p.y))
      const handle = (p: Pt, h: Pt, line?: Pt) => {
        const sy = line && Math.abs(line.y - p.y) > 1 ? (Y.f(line.y) - Y.f(p.y)) / (line.y - p.y) : Y.slope(p.y)
        return place(h.x, Y.f(p.y) + (h.y - p.y) * sy)
      }
      return {
        start: point(start),
        segs: segs.map((seg, i) => {
          const from = i ? segs[i - 1].to : start
          return {
            line: seg.line,
            c1: seg.line ? ([0, 0] as XY) : handle(from, seg.c1, seg.lineIn),
            c2: seg.line ? ([0, 0] as XY) : handle(seg.to, seg.c2, seg.lineOut),
            to: point(seg.to),
          }
        }),
      }
    })
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
      seg.lineIn = segs[prev].line ? from(prev) : undefined
      seg.lineOut = segs[next].line ? segs[next].to : undefined
    })
  }
}

/** A horizontal edge of the outline: a flat line, or a curve leaving or arriving horizontally. */
interface Edge {
  y: number
  flat: boolean
}

/**
 * Slices a glyph at its horizontal stroke edges. Bands thinner than `lockBelow` are strokes, and
 * `flat` ones when bounded by a flat line. Open bands inside lo–hi stretch, easing in over up to
 * EASE_IN·C from edges next to a stroke — but only where one of the `curves` (their y ranges) passes
 * through, since the ease-in is there to keep curves smooth. Straight lines need none, and stay
 * exactly consistent without it (an A's apex).
 */
function makeBands(edges: Edge[], lo: number, hi: number, lockBelow: number, C: number, curves: [number, number][]): Bands {
  const marks: Edge[] = [
    { y: lo, flat: false },
    { y: hi, flat: false },
  ]
  for (const e of [...edges].sort((a, b) => a.y - b.y)) {
    const near = marks.find((m) => Math.abs(m.y - e.y) <= 2)
    if (near) near.flat ||= e.flat
    else marks.push({ ...e })
  }
  marks.sort((a, b) => a.y - b.y)
  const breaks = marks.map((m) => m.y)
  const locked = breaks.slice(1).map((b, i) => b - breaks[i] < lockBelow)
  const flat = locked.map((_, i) => marks[i].flat || marks[i + 1].flat)
  const stretches = (i: number) => i >= 0 && i < locked.length && breaks[i] >= lo && breaks[i + 1] <= hi && !locked[i]
  const crossed = (a: number, b: number) => curves.some(([c0, c1]) => c0 < b && c1 > a)
  const ramps = locked.map((_, i): [number, number] => {
    if (!stretches(i)) return [0, 0]
    const w = Math.min(EASE_IN * C, (breaks[i + 1] - breaks[i]) / 2)
    const bottom = breaks[i]
    const top = breaks[i + 1]
    return [
      stretches(i - 1) || !crossed(bottom, bottom + w) ? 0 : w,
      stretches(i + 1) || !crossed(top - w, top) ? 0 : w,
    ]
  })
  return { breaks, locked, flat, ramps, lo, hi }
}

/** Where the stretch changes character along this direction: band edges and the middles and ends of ramps. */
function levelsOf({ breaks, ramps }: Bands) {
  const levels = new Set(breaks)
  ramps.forEach(([l, r], i) => {
    if (l) [breaks[i] + l / 2, breaks[i] + l].forEach((v) => levels.add(v))
    if (r) [breaks[i + 1] - r, breaks[i + 1] - r / 2].forEach((v) => levels.add(v))
  })
  return [...levels]
}

/**
 * Vertical remap: lo–hi (baseline to cap height) grows to (hi − lo)·scale. Straight horizontal
 * strokes keep their size; curved stroke bands and everything outside lo–hi grow by `base`; the
 * open bands absorb the rest, easing in from their neighbours' rate over their ramps so the remap
 * has no sudden change of rate. f(lo) = lo keeps the baseline put.
 */
function bandMap({ breaks, locked, flat, ramps, lo, hi }: Bands, scale: number, base: number) {
  const uniform = { f: (v: number) => lo + (v - lo) * scale, slope: () => scale }
  const n = locked.length
  const stretches = (i: number) => i >= 0 && i < n && breaks[i] >= lo && breaks[i + 1] <= hi && !locked[i]
  // growth rate of a band that doesn't stretch freely
  const fixed = (i: number) => (i >= 0 && i < n && locked[i] && flat[i] && breaks[i] >= lo && breaks[i + 1] <= hi ? 1 : base)
  const edgeRate = (i: number) => (stretches(i) ? NaN : fixed(i))

  // total length = k · free + known, solved for k
  let free = 0
  let known = 0
  for (let i = 0; i < n; i++) {
    if (breaks[i] < lo || breaks[i + 1] > hi) continue
    const len = breaks[i + 1] - breaks[i]
    if (!stretches(i)) {
      known += fixed(i) * len
      continue
    }
    const [l, r] = ramps[i]
    free += len - l / 2 - r / 2
    known += (l ? (edgeRate(i - 1) * l) / 2 : 0) + (r ? (edgeRate(i + 1) * r) / 2 : 0)
  }
  if (free < 1) return uniform
  const k = Math.max(base, ((hi - lo) * scale - known) / free)

  // growth rate d units into band i, and its integral
  const rate = (i: number, d: number) => {
    if (!stretches(i)) return fixed(i)
    const [l, r] = ramps[i]
    const len = breaks[i + 1] - breaks[i]
    if (d < l) return edgeRate(i - 1) + ((k - edgeRate(i - 1)) * d) / l
    if (d > len - r) return k - ((k - edgeRate(i + 1)) * (d - (len - r))) / r
    return k
  }
  const integral = (i: number, d: number) => {
    if (!stretches(i)) return fixed(i) * d
    const [l, r] = ramps[i]
    const len = breaks[i + 1] - breaks[i]
    const a = Math.min(d, l)
    const r0 = l ? edgeRate(i - 1) : k
    const r1 = r ? edgeRate(i + 1) : k
    let sum = l ? r0 * a + ((k - r0) * a * a) / (2 * l) : 0
    if (d > l) sum += k * (Math.min(d, len - r) - l)
    if (d > len - r) {
      const t = d - (len - r)
      sum += k * t - ((k - r1) * t * t) / (2 * r)
    }
    return sum
  }

  const mapped: number[] = new Array(breaks.length)
  const anchor = breaks.indexOf(lo)
  mapped[anchor] = lo
  for (let i = anchor; i < breaks.length - 1; i++) mapped[i + 1] = mapped[i] + integral(i, breaks[i + 1] - breaks[i])
  for (let i = anchor - 1; i >= 0; i--) mapped[i] = mapped[i + 1] - integral(i, breaks[i + 1] - breaks[i])

  const last = breaks.length - 1
  const band = (v: number) => {
    let i = 0
    while (i < last - 1 && breaks[i + 1] < v) i++
    return i
  }
  return {
    f: (v: number) => {
      if (v <= breaks[0]) return mapped[0] + (v - breaks[0]) * base
      if (v >= breaks[last]) return mapped[last] + (v - breaks[last]) * base
      const i = band(v)
      return mapped[i] + integral(i, v - breaks[i])
    },
    /** How fast f grows at v. */
    slope: (v: number) => {
      if (v <= breaks[0] || v >= breaks[last]) return base
      const i = band(v)
      return rate(i, v - breaks[i])
    },
  }
}

/** Sorted positions where the outline crosses the line axis = at (x = at when axis is 'x'). */
function crossings(contours: Contour[], axis: 'x' | 'y', at: number) {
  const other = axis === 'x' ? 'y' : 'x'
  const hits: number[] = []
  for (const { start, segs } of contours) {
    let p = start
    for (const seg of segs) {
      const pts = seg.line ? [p, seg.to] : [p, seg.c1, seg.c2, seg.to]
      const n = seg.line ? 1 : 32
      let prev = pts[0]
      for (let i = 1; i <= n; i++) {
        const t = i / n
        const u = 1 - t
        const q = seg.line
          ? seg.to
          : {
              x: u * u * u * pts[0].x + 3 * u * u * t * pts[1].x + 3 * u * t * t * pts[2].x + t * t * t * pts[3].x,
              y: u * u * u * pts[0].y + 3 * u * u * t * pts[1].y + 3 * u * t * t * pts[2].y + t * t * t * pts[3].y,
            }
        if ((prev[axis] - at) * (q[axis] - at) < 0) {
          const f = (at - prev[axis]) / (q[axis] - prev[axis])
          hits.push(prev[other] + (q[other] - prev[other]) * f)
        }
        prev = q
      }
      p = seg.to
    }
  }
  return hits.sort((a, b) => a - b)
}

/** Splits a curve (starting at `from`) wherever it crosses one of the horizontal `levels`. Lines are left whole. */
function splitAtLevels(seg: Segment, from: Pt, levels: number[]): Segment[] {
  if (seg.line) return [seg]
  const pts = [from, seg.c1, seg.c2, seg.to]
  const ts: number[] = []
  const STEPS = 32
  for (const axis of ['y'] as const) {
    const v = (t: number) => {
      const u = 1 - t
      return u * u * u * pts[0][axis] + 3 * u * u * t * pts[1][axis] + 3 * u * t * t * pts[2][axis] + t * t * t * pts[3][axis]
    }
    const lo = Math.min(...pts.map((p) => p[axis]))
    const hi = Math.max(...pts.map((p) => p[axis]))
    for (const level of levels) {
      if (level <= lo || level >= hi) continue
      for (let i = 0; i < STEPS; i++) {
        let a = i / STEPS
        let b = (i + 1) / STEPS
        if ((v(a) - level) * (v(b) - level) > 0) continue
        for (let n = 0; n < 40; n++) {
          const m = (a + b) / 2
          if ((v(a) - level) * (v(m) - level) <= 0) b = m
          else a = m
        }
        const t = (a + b) / 2
        if (t > 1e-4 && t < 1 - 1e-4 && ts.every((s) => Math.abs(s - t) > 1e-4)) ts.push(t)
      }
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
