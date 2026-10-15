import type { Glyph, Rows, Stretch, TypeEngine } from './engine'

export interface Letter {
  ch: string
  height: number // 0–1
  italic: number // degrees
  anchor: number // 0 = sits on the bottom line, 1 = hangs from the top line
  dx: number // drag offset, in box heights
  dy: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Laid {
  paths: string[]
  /** Each letter's ink from left to right on screen, before any drag offset (for placing a caret). */
  spans: { left: number; right: number }[]
  /** Screen px per box height (drag offsets are stored in box heights). */
  boxPx: number
  top: number // screen y of the line letters hang from
  bottom: number // screen y of the line letters sit on
}

// Minimum gap kept between neighbouring letters, as a share of the resting cap height
// (scaled up with the letters' width so tall letters get a proportionally larger gap)
const MIN_GAP = 0.08
// When balancing spacing, open space reaching more than this share of the cap height beyond the
// pair's closest point (inside a slant's triangle, under an L or T) only counts up to it, so one
// deep void doesn't decide the spacing
const DEPTH = 0.25
// For fonts drawn at their own condensed widths, how much of the usual widening tall letters still
// get (as a power: 0 none, 1 all of it)
const DESIGNED_WIDEN = 0.5
// Resolution of the collision check between neighbours
const ROWS = 120

/**
 * A letter at full height is `maxStretch` times its resting cap height, but less than three times
 * as wide, which gives tall letters their condensed look. `growth` (0–1) is how much its strokes
 * thicken along with it: 0 keeps the font's own stroke thickness, 1 lets strokes grow as much as
 * the letter widens (like the reference). Straight horizontal strokes keep their thickness either way.
 *
 * With `designedWidth` (fonts with a width axis) tall letters use the font's own condensed drawings
 * (see TypeEngine.widthFor) and are only widened part of the way (DESIGNED_WIDEN), which keeps
 * them full rather than slender while their shapes stay the font's own.
 */
export function stretchFor(height: number, maxStretch: number, growth = 0, designedWidth = false): Stretch {
  const sy = 1 + (maxStretch - 1) * height
  const widen = sy ** 0.55
  return { sx: designedWidth ? widen ** DESIGNED_WIDEN : widen, sy, w: 1 + (widen - 1) * growth }
}

/**
 * Lays out a word inside `box`: the top and bottom of the box are the two lines letters
 * hang from or sit on, and a full-height letter spans the whole box. The word is centred
 * and shrunk to fit if it is too wide. `weight` only affects fonts with a weight axis; `growth` is
 * how much strokes thicken as letters grow (see stretchFor); `slant` (degrees) leans every letter
 * on top of its own italic.
 *
 * Spacing is balanced optically: the open space between each pair of neighbours, averaged over
 * their height (with voids deeper than DEPTH beyond the closest point capped), is kept equal to that
 * pair's space in the font at rest — its own spacing and kerning — scaled with the letters' size.
 * So a word at rest is spaced exactly as the font designs it, and stays evenly spaced as letters
 * stretch and lean. No pair ever comes closer than MIN_GAP.
 */
export function layoutWord(
  engine: TypeEngine,
  letters: Letter[],
  box: Box,
  maxStretch: number,
  weight = 400,
  growth = 0,
  slant = 0,
): Laid {
  const C = engine.capHeight
  const unit = box.h / maxStretch / C
  const rows: Rows = { top: -0.4 * box.h, bottom: 1.4 * box.h, count: ROWS }
  // rightmost ink so far in each row, across all placed letters
  const reach = new Float64Array(ROWS).fill(-Infinity)

  let x = 0
  let minX = Infinity
  let maxX = -Infinity
  let prevSx = 0
  let prev: Neighbour | null = null
  const placed = letters.map((l, i) => {
    const width = engine.widthFor(l.height)
    const stretch = stretchFor(l.height, maxStretch, growth, width !== null)
    // Stems should end up w times as thick as the font's: draw the letter from the weight that
    // gets them there after it's widened sx times — lighter when widened geometrically, heavier
    // when strokes should grow but the font's own narrower width is used (weight axis only)
    const drawn = engine.weightFor(weight, stretch.w / stretch.sx)
    // the font's own slant axis covers what it can; the rest is a geometric shear
    const italic = l.italic + slant
    const g = engine.glyph(l.ch, drawn, Math.min(italic, engine.maxSlant), width === null ? {} : { wdth: width })
    const capPx = C * stretch.sy * unit
    const at = {
      x: 0,
      baseline: box.h + (capPx - box.h) * l.anchor,
      pivot: box.h * (1 - l.anchor),
      slant: Math.tan((italic * Math.PI) / 180),
      scale: unit,
    }
    const advance = engine.advance(g, stretch) * unit
    const { left, right } = engine.profile(g, stretch, at, rows)
    let ink = [Infinity, -Infinity]
    for (let r = 0; r < ROWS; r++) if (left[r] < Infinity) ink = [Math.min(ink[0], left[r]), Math.max(ink[1], right[r])]

    // the letter at rest, and how much bigger it is now (for scaling its space)
    const rest = engine.glyph(l.ch, weight, Math.min(slant, engine.maxSlant), width === null ? {} : { wdth: engine.widthFor(0)! })
    const size = rest.advance > 0 ? (g.advance * stretch.sx) / rest.advance : stretch.sx
    const span: [number, number] = [at.baseline - capPx, at.baseline]
    const self: Neighbour = { ch: l.ch, g, stretch, at, x: 0, ink, rest, size, span, lean: italic }

    // balance the space to the previous letter (spaces keep the font's own spacing)
    let gap = MIN_GAP * C * unit * (i ? (prevSx + stretch.sx) / 2 : 0)
    if (prev && ink[0] < Infinity && prev.ink[0] < Infinity) {
      const scale = (prev.size + size) / 2
      const pair = restSpace(engine, prev.rest, rest, engine.kerning(prev.ch, l.ch))
      x = balance(engine, prev, self, pair.space * unit * scale, DEPTH * C * unit * scale, x)
      // the minimum gap is never stricter than how close the font itself sets this pair
      gap = Math.min(gap, pair.closest * unit * scale)
    }

    // never closer than the minimum gap to anything before it
    for (let r = 0; r < ROWS; r++) {
      if (left[r] < Infinity && reach[r] > -Infinity) x = Math.max(x, reach[r] + gap - left[r])
    }
    for (let r = 0; r < ROWS; r++) if (right[r] > -Infinity) reach[r] = Math.max(reach[r], x + right[r])
    // letters without ink (spaces) take up their advance
    const extent = ink[0] === Infinity ? { left: x, right: x + advance } : { left: x + ink[0], right: x + ink[1] }
    minX = Math.min(minX, extent.left)
    maxX = Math.max(maxX, extent.right)

    const result = { g, stretch, at: { ...at, x }, span: extent }
    prev = { ...self, x }
    x += advance
    const next = letters[i + 1]
    if (next) {
      const sx = (stretch.sx + stretchFor(next.height, maxStretch, growth, width !== null).sx) / 2
      x += engine.kerning(l.ch, next.ch) * unit * sx
    }
    prevSx = stretch.sx
    return result
  })

  const fit = Math.min(1, box.w / Math.max(1, maxX - minX))
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const midX = (minX + maxX) / 2
  const midY = box.h / 2
  const toX = (x: number) => cx + (x - midX) * fit
  const toY = (y: number) => cy + (y - midY) * fit
  return {
    paths: placed.map((p, i) => {
      const { dx, dy } = letters[i]
      return engine.path(p.g, p.stretch, {
        x: toX(p.at.x + dx * box.h),
        baseline: toY(p.at.baseline + dy * box.h),
        pivot: toY(p.at.pivot + dy * box.h),
        scale: unit * fit,
        slant: p.at.slant,
      })
    }),
    spans: placed.map((p) => ({ left: toX(p.span.left), right: toX(p.span.right) })),
    boxPx: box.h * fit,
    top: toY(0),
    bottom: toY(box.h),
  }
}

/** A placed letter, as needed to measure the space next to it. */
interface Neighbour {
  ch: string
  g: Glyph
  stretch: Stretch
  at: { x: number; baseline: number; pivot: number; slant: number; scale: number }
  x: number
  ink: number[]
  rest: Glyph
  size: number
  span: [number, number] // top and bottom of its cap height, in layout space
  lean: number // italic angle, degrees
}

// Rows each pair of neighbours is measured with: spread over just those two letters' height,
// so a short letter is measured as finely as a tall one, and a pair at rest exactly as in the font
const PAIR_ROWS = 96
// How far beyond a short letter a neighbour's overhang still counts, as a share of the pair's height,
// and how much those rows weigh against rows where both letters have ink
const OVERHANG = 0.12
const OVERHANG_WEIGHT = 1
// Leaning letters' bodies hang over their neighbours by nature; past this lean (degrees) a pair's
// overhangs aren't counted, or italic words would open up holes
const OVERHANG_MAX_LEAN = 15
const pairRows = (a: [number, number], b: [number, number]): Rows => {
  const top = Math.min(a[0], b[0])
  const bottom = Math.max(a[1], b[1])
  const margin = (bottom - top) * 0.15
  return { top: top - margin, bottom: bottom + margin, count: PAIR_ROWS }
}

/**
 * The open space between two profiles (in each row, how far right's ink is from left's), averaged
 * over the rows both have ink, plus the rows just above or below one letter where only the other
 * reaches (within OVERHANG of the pair's height): there the shorter letter counts as a straight
 * wall at its outer edge, so it doesn't slide in under a neighbour's arm right above it. Overhangs
 * farther away (the top of a much taller letter) don't count. Space more than `cap` beyond the
 * closest row counts only up to that. Returns the average for the letters placed `offset` apart,
 * or NaN if they share no rows.
 */
function meanSpace(right: Float64Array, left: Float64Array, offset: number, cap: number, overhangs = true) {
  let wallRight = -Infinity
  let wallLeft = Infinity
  for (let r = 0; r < left.length; r++) {
    wallRight = Math.max(wallRight, right[r])
    wallLeft = Math.min(wallLeft, left[r])
  }
  if (wallRight === -Infinity || wallLeft === Infinity) return NaN
  const n = left.length
  const reach = Math.round(OVERHANG * n)
  const near = (has: (r: number) => boolean, r: number) => {
    if (!overhangs) return false
    for (let k = Math.max(0, r - reach); k <= Math.min(n - 1, r + reach); k++) if (has(k)) return true
    return false
  }
  const hasRight = (r: number) => right[r] > -Infinity
  const hasLeft = (r: number) => left[r] < Infinity
  // [gap, weight]: overhang rows count half as much as rows where both letters have ink
  const gaps: [number, number][] = []
  for (let r = 0; r < n; r++) {
    if (hasRight(r) && hasLeft(r)) gaps.push([left[r] - right[r], 1])
    else if (hasRight(r) && near(hasLeft, r)) gaps.push([wallLeft - right[r], OVERHANG_WEIGHT])
    else if (hasLeft(r) && near(hasRight, r)) gaps.push([left[r] - wallRight, OVERHANG_WEIGHT])
  }
  if (!gaps.length) return NaN
  const closest = Math.min(...gaps.filter(([, w]) => w === 1).map(([g]) => g), Infinity)
  const base = Number.isFinite(closest) ? closest : Math.min(...gaps.map(([g]) => g))
  lastClosest = offset + base
  let sum = 0
  let total = 0
  for (const [g, w] of gaps) {
    sum += Math.min(g, base + cap) * w
    total += w
  }
  return offset + sum / total
}
// the closest approach found by the last meanSpace call (where the letters nearly touch)
let lastClosest = NaN

// The open space between two letters at rest, and how close they come, per pair of resting glyphs (font units)
const restSpaces = new WeakMap<Glyph, WeakMap<Glyph, { space: number; closest: number }>>()

/**
 * The average open space between glyphs a and b set at rest (upright, unstretched, the font's own
 * spacing and kerning), over the heights where both have ink, with deep voids capped at DEPTH.
 */
function restSpace(engine: TypeEngine, a: Glyph, b: Glyph, kern: number) {
  let byB = restSpaces.get(a)
  if (!byB) restSpaces.set(a, (byB = new WeakMap()))
  const known = byB.get(b)
  if (known !== undefined) return known

  const C = engine.capHeight
  const plain = { sx: 1, sy: 1, w: 1 }
  const at = { x: 0, baseline: C, scale: 1, pivot: C, slant: 0 }
  const rows = pairRows([0, C], [0, C])
  const pa = engine.profile(a, plain, at, rows)
  const pb = engine.profile(b, plain, at, rows)
  let space = meanSpace(pa.right, pb.left, a.advance + kern, DEPTH * C)
  let closest = lastClosest
  if (Number.isNaN(space)) space = closest = a.advance + kern
  const result = { space, closest: Math.max(0, closest) }
  byB.set(b, result)
  return result
}

/**
 * Where to put `cur` so the average open space to `prev` (see meanSpace) equals `target`. The
 * space grows one for one with x, so this is a direct calculation.
 */
function balance(engine: TypeEngine, prev: Neighbour, cur: Neighbour, target: number, cap: number, fallback: number) {
  const rows = pairRows(prev.span, cur.span)
  const right = engine.profile(prev.g, prev.stretch, { ...prev.at, x: prev.x }, rows).right
  const left = engine.profile(cur.g, cur.stretch, { ...cur.at, x: 0 }, rows).left
  const upright = Math.max(Math.abs(prev.lean), Math.abs(cur.lean)) <= OVERHANG_MAX_LEAN
  const space = meanSpace(right, left, 0, cap, upright)
  return Number.isNaN(space) ? fallback : target - space
}
