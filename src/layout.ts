import type { Rows, Stretch, TypeEngine } from './engine'

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
// Resolution of the collision check between neighbours
const ROWS = 120

/**
 * A letter at full height is `maxStretch` times its resting cap height, but less than three times
 * as wide, which gives tall letters their condensed look. `growth` (0–1) is how much its strokes
 * thicken along with it: 0 keeps the font's own stroke thickness, 1 lets strokes grow as much as
 * the letter widens (like the reference). Straight horizontal strokes keep their thickness either way.
 */
export function stretchFor(height: number, maxStretch: number, growth = 0): Stretch {
  const sy = 1 + (maxStretch - 1) * height
  const sx = sy ** 0.55
  return { sx, sy, w: 1 + (sx - 1) * growth }
}

/**
 * Lays out a word inside `box`: the top and bottom of the box are the two lines letters
 * hang from or sit on, and a full-height letter spans the whole box. The word is centred
 * and shrunk to fit if it is too wide. `weight` only affects fonts with a weight axis; `growth` is
 * how much strokes thicken as letters grow (see stretchFor); `slant` (degrees) leans every letter
 * on top of its own italic.
 *
 * Letters keep the font's spacing unless their stretched, slanted shapes would come closer
 * than MIN_GAP at some height, in which case the later letter is pushed right just enough.
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
  const placed = letters.map((l, i) => {
    const stretch = stretchFor(l.height, maxStretch, growth)
    // Stretching sx times wider would make stems sx times thicker, so take the letter from the
    // lighter weight whose stems end up as thick as they should be (fonts with a weight axis only)
    const drawn = engine.weightFor(weight, stretch.w / stretch.sx)
    // the font's own slant axis covers what it can; the rest is a geometric shear
    const italic = l.italic + slant
    const g = engine.glyph(l.ch, drawn, Math.min(italic, engine.maxSlant))
    const capPx = C * stretch.sy * unit
    const at = {
      x: 0,
      baseline: box.h + (capPx - box.h) * l.anchor,
      pivot: box.h * (1 - l.anchor),
      slant: Math.tan((italic * Math.PI) / 180),
      scale: unit,
    }
    const advance = engine.advance(g, stretch) * unit

    // push right until the letter clears everything before it by at least the gap
    const { left, right } = engine.profile(g, stretch, at, rows)
    const gap = MIN_GAP * C * unit * (i ? (prevSx + stretch.sx) / 2 : 0)
    let ink = [Infinity, -Infinity]
    for (let r = 0; r < ROWS; r++) {
      if (left[r] === Infinity) continue
      ink = [Math.min(ink[0], left[r]), Math.max(ink[1], right[r])]
      if (reach[r] > -Infinity) x = Math.max(x, reach[r] + gap - left[r])
    }
    for (let r = 0; r < ROWS; r++) if (right[r] > -Infinity) reach[r] = Math.max(reach[r], x + right[r])
    // letters without ink (spaces) take up their advance
    const span = ink[0] === Infinity ? { left: x, right: x + advance } : { left: x + ink[0], right: x + ink[1] }
    minX = Math.min(minX, span.left)
    maxX = Math.max(maxX, span.right)

    const result = { g, stretch, at: { ...at, x }, span }
    x += advance
    const next = letters[i + 1]
    if (next) {
      const sx = (stretch.sx + stretchFor(next.height, maxStretch, growth).sx) / 2
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
