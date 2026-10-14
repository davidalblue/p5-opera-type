import type { Stretch, TypeEngine } from './engine'

export interface Letter {
  ch: string
  height: number // 0–1
  italic: number // degrees
  anchor: number // 0 = sits on the bottom line, 1 = hangs from the top line
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A letter at full height is `maxStretch` times its resting cap height, but only grows
 * about half as fast in width, which is what gives the tall letters their condensed look.
 */
export function stretchFor(height: number, maxStretch: number): Stretch {
  const sy = 1 + (maxStretch - 1) * height
  return { sx: sy ** 0.55, sy }
}

/**
 * Lays out a word inside `box`: the top and bottom of the box are the two lines letters
 * hang from or sit on, and a full-height letter spans the whole box. The word is centred
 * (slant included) and shrunk to fit if it is too wide. Returns SVG path data per letter.
 */
export function layoutWord(engine: TypeEngine, letters: Letter[], box: Box, maxStretch: number) {
  const C = engine.capHeight
  const unit = box.h / maxStretch / C

  let x = 0
  let minX = Infinity
  let maxX = -Infinity
  const placed = letters.map((l, i) => {
    const g = engine.glyph(l.ch)
    const stretch = stretchFor(l.height, maxStretch)
    const capPx = C * stretch.sy * unit
    const baseline = box.h + (capPx - box.h) * l.anchor
    const pivot = box.h * (1 - l.anchor)
    const slant = Math.tan((l.italic * Math.PI) / 180)
    const advance = g.advance * stretch.sx * unit

    const shifts = [(pivot - baseline) * slant, (pivot - baseline + capPx) * slant]
    minX = Math.min(minX, x + Math.min(...shifts))
    maxX = Math.max(maxX, x + advance + Math.max(...shifts))

    const at = { x, baseline, pivot, slant, stretch }
    x += advance
    const next = letters[i + 1]
    if (next) {
      const sx = (stretch.sx + stretchFor(next.height, maxStretch).sx) / 2
      x += engine.kerning(l.ch, next.ch) * unit * sx
    }
    return { g, ...at }
  })

  const fit = Math.min(1, box.w / Math.max(1, maxX - minX))
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const midX = (minX + maxX) / 2
  const midY = box.h / 2
  return placed.map((p) =>
    engine.path(p.g, p.stretch, {
      x: cx + (p.x - midX) * fit,
      baseline: cy + (p.baseline - midY) * fit,
      pivot: cy + (p.pivot - midY) * fit,
      scale: unit * fit,
      slant: p.slant,
    }),
  )
}
