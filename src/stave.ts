import type { AxisValues, Glyph, TypeEngine } from './engine'
import { easeInOut, loopRate, loopSpan, snapEase, type LoopMode } from './loops'
import { state } from './state'

/**
 * The Stave tool: letters are noteheads on a five-line stave. Like real notes, each one is a space
 * tall and sits on a fixed position — centred on a line, or filling the space between two lines.
 *
 * Motion is kept snappy and musical: every hop is quick and lands exactly on the beat grid, then
 * the letter holds still on its note. Letters play rhythms taken from music (steady, dotted,
 * syncopated, with rests), can come in one after another in sixteenths, flip in the air, and
 * bars start with an accent.
 */

export type Melody = 'wave' | 'scale' | 'random' | 'unison'

export const stave = {
  melody: 'wave' as Melody,
  range: 8, // how far the melody spreads, in stave steps (a line to the next space is one step)
  tempo: 108, // beats per minute
  rhythm: 40, // 0–100: from steady beats to busier, syncopated rhythms with rests
  cascade: 25, // 0–100: letters come in one after another, up to a beat apart (in sixteenths)
  bounce: 0, // 0–100: height of the hop between notes
  squash: 0, // 0–100: crouch before a hop and squash on landing
  flip: 0, // 0–100: how often letters flip in the air
  accent: 0, // 0–100: bold pop on the first beat of each bar (and lighter on the third)
  size: 50, // 0–100: size of the stave, and the noteheads with it
  spacing: 25, // 0–100: distance between letters, up to 1.5 noteheads
  // warp: instead of hopping, a letter stretches from its old note to its new one, then snaps back
  warp: false,
  reach: 100, // 0–100: how far towards its new note the letter stretches before letting go
  hold: 30, // 0–100: how long it stays stretched before snapping back
  snap: 40, // 0–100: from a smooth settle to an elastic snap
  stick: 0, // 0–100: how close each letter settles to the letters beside it
  // Animate Height: while one is on, the melody stops and the letters stretch up from the bottom
  // line in a loop, like Warp
  loop: null as LoopMode | null,
  loopSpeed: 50, // 0–100
  loopHeight: 50, // 0–100: how far up the stave the letters climb (50: the middle line, 100: the top line)
  loopTime: 0, // seconds since the loop was switched on (only while playing)
  loopPhase: 0, // how far the loop has run, in cycles
  lines: true,
  playing: false, // starts paused, with every letter on the bottom line, until Play is pressed
  time: 0, // seconds of music played so far
  seed: 1,
}

/** A letter's bottom and top edges, in stave steps (a resting notehead spans its note ± 1). */
type Span = [number, number]

// Letters shaped by hand while paused, until Play or Reset
let shaped: Record<number, Span> = {}
// Shapes let go when Play is pressed, snapping back into the music
let letGo: { spans: Record<number, Span>; time: number } | null = null

/** Back to the start: every letter waits on the bottom line until Play is pressed again. */
export function resetStave() {
  stave.time = 0
  stave.loopTime = 0
  stave.loopPhase = 0
  stave.playing = false
  shaped = {}
  letGo = null
}

/** Play or pause. Letters shaped by hand snap back into the music when it plays. */
export function togglePlay() {
  stave.playing = !stave.playing
  if (stave.playing && Object.keys(shaped).length) {
    letGo = { spans: shaped, time: 0 }
    shaped = {}
  }
}

/** Letters can be shaped by hand while paused, with Warp on and no Animate Height loop. */
export const canShape = () => !stave.playing && stave.warp && !stave.loop

/**
 * Switches an Animate Height loop on (from its start) or, pressed again, off. Off, the melody starts
 * again from the bottom line, so the letters hop up into it rather than jumping.
 */
export function toggleLoop(mode: LoopMode) {
  if (stave.loop === mode) {
    stave.loop = null
    stave.time = 0
    return
  }
  if (!stave.loop) stave.loopTime = 0
  stave.loop = mode
  stave.loopPhase = 0
}

/** Moves the Stave on by `seconds` of play: the melody, or while a loop is on, only the loop. */
export function advanceStave(seconds: number) {
  if (!stave.playing) return
  if (letGo && (letGo.time += seconds) > SETTLE) letGo = null
  if (!stave.loop) {
    stave.time += seconds
    return
  }
  stave.loopTime += seconds
  // the loop starts once the letters have settled on the bottom line
  if (stave.loopTime > SETTLE) stave.loopPhase += seconds * loopRate(stave.loopSpeed)
}

/** New random choices for the melody and rhythm. */
export function newMelody() {
  stave.seed = (stave.seed * 7919 + 13) % 100003
}

// Space between stave lines at the smallest and largest Size, as a share of the canvas height
const GAP_MIN = 0.045
const GAP_MAX = 0.12
// The stave's lines are at steps −4, −2, 0, 2, 4 (0 = middle line); beyond them notes get ledger lines
const STAFF_EDGE = 4
const BAR = 4
// Timing of a hop, in seconds, whatever the tempo: the crouch before it, the flight, the landing
const CROUCH = 0.06
const FLIGHT = 0.2
const LAND = 0.14
// Timing of a warp, in seconds: reaching out, the longest hold (Hold at 100), and snapping back
const REACH = 0.16
const MAX_HOLD = 0.4
const RELEASE = 0.16
// Highest a loop's top note goes (Height at 100), in stave steps above the bottom line: the top line
const MAX_LOOP_STEPS = 8
// Seconds the letters take to snap down onto the bottom line when a loop is switched on
const SETTLE = 0.25
// Most extra space between letters (Spacing at 100), as a share of the notehead height
const MAX_TRACKING = 1.5

/**
 * Rhythms for one bar, from steady to busy: note lengths in beats, negative for a rest. Rhythm
 * picks among the first few patterns, more of them (and busier ones) as it goes up.
 */
const PATTERNS: number[][] = [
  [1, 1, 1, 1],
  [2, 1, 1],
  [1, 1, 2],
  [1, 1, 0.5, 0.5, 1],
  [1.5, 0.5, 1, 1], // dotted
  [1, -1, 1, 1], // with a rest
  [0.5, 1, 0.5, 1, 1], // syncopated
  [1, 0.5, 0.5, -1, 1],
  [0.5, 0.5, 1, 0.5, 0.5, 1],
  [1.5, 1.5, 1], // tresillo-like
  [0.5, 1, 1, 0.5, 1],
  [-0.5, 0.5, 1, 0.5, 0.5, 1], // pickup
]

// Deterministic pseudo-random number in [0, 1) for a letter, a moment and the seed
function hash(i: number, moment: number, salt = 0) {
  let h = (i * 374761393 + moment * 668265263 + (stave.seed + salt) * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** The melody's note for letter i of n at a moment (in beats): a whole stave step. */
function melodyNote(i: number, n: number, moment: number) {
  const half = Math.max(1, Math.round(stave.range / 2))
  const span = half * 2
  const eighth = Math.round(moment * 2)
  switch (stave.melody) {
    case 'wave':
      return Math.round(half * Math.sin((i / Math.max(n, 4)) * Math.PI * 1.6 + moment * 0.9 + stave.seed))
    case 'scale':
      return ((((i + eighth + stave.seed) % (span + 1)) + span + 1) % (span + 1)) - half
    case 'random':
      return Math.round(hash(i, eighth, 1) * span) - half
    case 'unison':
      return Math.round(hash(0, eighth, 1) * span) - half
  }
}

/** A note in a letter's rhythm: its bar, place in the bar, start and length (beats), and whether it's a rest. */
interface Note {
  bar: number
  index: number
  start: number
  length: number
  rest: boolean
}

/** Letter i's notes in a bar, from a pattern chosen with Rhythm. */
function barNotes(i: number, bar: number): Note[] {
  const choices = 1 + Math.round((stave.rhythm / 100) * (PATTERNS.length - 1))
  const pattern = PATTERNS[Math.floor(hash(i * 31, bar, 2) * choices)]
  let at = 0
  return pattern.map((length, index) => {
    const note = { bar, index, start: at, length: Math.abs(length), rest: length < 0 }
    at += Math.abs(length)
    return note
  })
}

function previous(i: number, note: Note): Note {
  if (note.index > 0) return barNotes(i, note.bar)[note.index - 1]
  const before = barNotes(i, note.bar - 1)
  return before[before.length - 1]
}

function next(i: number, note: Note): Note {
  const bar = barNotes(i, note.bar)
  return note.index < bar.length - 1 ? bar[note.index + 1] : barNotes(i, note.bar + 1)[0]
}

/**
 * The stave step letter i sits on during `note` (a rest keeps the note before it). Before the music
 * starts every letter waits on the bottom line, so pressing Play sends them up into the melody.
 */
function pitch(i: number, n: number, note: Note, depth = 0): number {
  if (note.bar * BAR + note.start < 0) return -STAFF_EDGE
  if (note.rest && depth < 8) return pitch(i, n, previous(i, note), depth + 1)
  return melodyNote(i, n, note.bar * BAR + note.start)
}

/** Cascade: letter i comes in up to a beat after the one before it, in sixteenths. */
const cascadeOffset = (i: number) => (Math.round((stave.cascade / 100) * 4) / 4) * i

/** The note letter i is on at a moment of its own rhythm (in beats). */
function noteAt(i: number, beats: number): Note {
  const bar = Math.floor(beats / BAR)
  const into = beats - bar * BAR
  const notes = barNotes(i, bar)
  let note = notes[0]
  for (const candidate of notes) if (candidate.start <= into) note = candidate
  return note
}

/** With Warp's Stick, the most stave steps between neighbouring letters (null: no limit). */
function stickGap(): number | null {
  if (!stave.warp || stave.stick === 0) return null
  const span = 2 * Math.max(1, Math.round(stave.range / 2))
  return Math.max(1, Math.round(span * (1 - stave.stick / 100)))
}

/**
 * The stave step letter i settles on for `note`. With Stick, it's kept within a few steps of the
 * letters beside it as they are when the note starts: the word is reined in from each end in turn
 * and the two are averaged, so neither end leads. Letters still only move on their own notes.
 */
function settle(i: number, n: number, note: Note, depth = 0): number {
  const gap = stickGap()
  if (gap === null) return pitch(i, n, note)
  if (note.rest && depth < 8) return settle(i, n, previous(i, note), depth + 1)
  const moment = note.bar * BAR + note.start + cascadeOffset(i)
  const raw = Array.from({ length: n }, (_, j) => (j === i ? pitch(i, n, note) : pitch(j, n, noteAt(j, moment - cascadeOffset(j)))))
  const near = (value: number, to: number) => Math.min(to + gap, Math.max(to - gap, value))
  let fromStart = raw[0]
  for (let j = 1; j <= i; j++) fromStart = near(raw[j], fromStart)
  let fromEnd = raw[n - 1]
  for (let j = n - 2; j >= i; j--) fromEnd = near(raw[j], fromEnd)
  return Math.round((fromStart + fromEnd) / 2)
}


interface Motion {
  pos: number // stave steps (whole while holding)
  squash: number // 1 = none, above stretched tall, below squashed
  angle: number // radians of flip
  accent: number // 0–1, a freshly landed accented note
  // while warping: the letter's bottom and top edges, in stave steps (a resting notehead spans pos ± 1)
  span?: [number, number]
}

/** Overshooting ease for the snap back: 0 settles smoothly, higher values spring past and back. */

/**
 * Where letter i is in its rhythm at time t (seconds). A hop starts on its note's beat, takes
 * FLIGHT seconds and lands exactly on the next note position; the rest of the note it holds still.
 */
function motion(i: number, n: number, t: number): Motion {
  const beatLength = 60 / stave.tempo
  const beats = t / beatLength - cascadeOffset(i)
  const note = noteAt(i, beats)
  const since = (beats - (note.bar * BAR + note.start)) * beatLength // seconds into the note
  const length = note.length * beatLength
  const squash = stave.squash / 100

  const to = settle(i, n, note)
  const from = settle(i, n, previous(i, note))
  const accentStrength = (stave.accent / 100) * (note.index === 0 ? 1 : note.start === 2 ? 0.5 : 0)
  const flight = Math.min(FLIGHT, length * 0.6)

  // warping from the last note to this one: the leading edge reaches out, holds, then the
  // trailing edge lets go and the letter snaps back to its normal height on the new note
  if (stave.warp && !note.rest && from !== to) {
    const hold = (stave.hold / 100) * MAX_HOLD
    const fit = Math.min(1, (length * 0.85) / (REACH + hold + RELEASE))
    const [reachT, holdT, releaseT] = [REACH * fit, hold * fit, RELEASE * fit]
    if (since < reachT + holdT + releaseT) {
      const up = to > from
      const goal = from + (to - from) * (stave.reach / 100)
      // in steps: [bottom, top] of the letter
      const start: [number, number] = [from - 1, from + 1]
      const reached: [number, number] = up ? [from - 1, goal + 1] : [goal - 1, from + 1]
      const end: [number, number] = [to - 1, to + 1]
      let span: [number, number]
      if (since < reachT) {
        const u = easeInOut(since / reachT)
        span = [start[0] + (reached[0] - start[0]) * u, start[1] + (reached[1] - start[1]) * u]
      } else if (since < reachT + holdT) {
        span = reached
      } else {
        const u = snapEase((since - reachT - holdT) / releaseT, stave.snap / 100)
        span = [reached[0] + (end[0] - reached[0]) * u, reached[1] + (end[1] - reached[1]) * u]
      }
      return { pos: (span[0] + span[1]) / 2, squash: 1, angle: 0, accent: 0, span }
    }
  }

  // flying from the last note to this one
  if (!stave.warp && !note.rest && since < flight) {
    const u = since / flight
    const lift = (stave.bounce / 100) * (1 + Math.abs(to - from) * 0.5)
    const pos = from + (to - from) * easeInOut(u) + lift * Math.sin(Math.PI * u)
    let angle = 0
    if (hash(i * 13, Math.round((note.bar * BAR + note.start) * 4), 4) < stave.flip / 100) {
      const direction = to > from ? -1 : 1
      angle = direction * Math.PI * 2 * easeInOut(u)
    }
    // stretched at take-off and just before landing
    return { pos, squash: 1 + squash * 0.3 * Math.abs(Math.cos(Math.PI * u)), angle, accent: 0 }
  }

  // holding the note: a firm landing squash that settles quickly, and a quick crouch before the next hop
  let s = 1
  const travel = stave.warp && from !== to
    ? Math.min(length * 0.85, REACH + (stave.hold / 100) * MAX_HOLD + RELEASE)
    : flight
  const landed = note.rest ? Infinity : since - travel
  if (landed < LAND) {
    const v = landed / LAND
    s -= squash * 0.35 * (1 - v) * Math.cos(v * Math.PI * 1.5)
  }
  const untilNext = length - since
  if (!next(i, note).rest && untilNext < CROUCH) s -= squash * 0.15 * (1 - untilNext / CROUCH)
  const accent = landed < 0.4 ? accentStrength * (1 - landed / 0.4) : 0
  return { pos: to, squash: s, angle: 0, accent }
}

/**
 * Draws the stave and the word on it at time t (seconds of play), on a canvas `width` × `height` CSS px.
 */
export function drawStave(ctx: CanvasRenderingContext2D, engine: TypeEngine, width: number, height: number, t: number) {
  const text = state.text
  const n = text.length

  // the letters at rest (for spacing); each is a notehead, as tall as one space of the stave
  const C = engine.capHeight
  const width0 = engine.widthFor(0)
  const slant = Math.min(state.slant, engine.maxSlant)
  const axes: AxisValues = width0 === null ? {} : { wdth: width0 }
  const glyphs = [...text].map((ch) => engine.glyph(ch, state.weight, slant, axes))
  const kerns = glyphs.map((_, i) => (i < n - 1 ? engine.kerning(text[i], text[i + 1]) : 0))
  const tracking = (stave.spacing / 100) * MAX_TRACKING
  const wordUnits = glyphs.reduce((sum, g, i) => sum + g.advance + kerns[i], 0) + tracking * C * Math.max(0, n - 1)

  // stave size from the Size slider, smaller if the word wouldn't fit across
  const usable = width * 0.84
  const wanted = height * (GAP_MIN + (GAP_MAX - GAP_MIN) * (stave.size / 100))
  const gap = Math.min(wanted, (usable / Math.max(1, wordUnits)) * C) // space between lines = notehead height
  const step = gap / 2
  const middle = height * 0.5
  const unit = gap / C
  const faint = 'rgb(255 255 255 / 0.4)'
  const line = Math.max(1, gap * 0.04)

  picture = { width, height, rules: [], letters: [] }
  // a stave or ledger line, kept for saving as SVG too
  const rule = (x: number, y: number, w: number, h: number) => {
    ctx.fillRect(x, y, w, h)
    picture.rules.push([x, y, w, h])
  }

  if (stave.lines) {
    ctx.fillStyle = faint
    for (let k = -STAFF_EDGE; k <= STAFF_EDGE; k += 2) rule(width * 0.04, middle - k * step - line / 2, width * 0.92, line)
  }
  if (!n) return

  // set like a word, with Spacing's air between notes, centred
  const advances = glyphs.map((g, i) => (g.advance + kerns[i]) * unit + (i < n - 1 ? tracking * gap : 0))
  const total = advances.reduce((a, b) => a + b, 0)
  let x = (width - total) / 2
  const xs = advances.map((a) => {
    const here = x
    x += a
    return here
  })

  drawn = { middle, step, limit: Math.max(STAFF_EDGE + 1, Math.floor(height / 2 / step) - 1), letters: [] }
  const middleLetter = n > 1 ? Math.floor((n - 1) / 2) / (n - 1) : 0.5
  const range = engine.weightRange
  const heaviest = range ? range[1] : state.weight

  for (let i = 0; i < n; i++) {
    const g0 = glyphs[i]
    if (text[i] === ' ' || !g0.contours.length) continue
    let m = motion(i, n, t)
    // shaped by hand while paused, or snapping from that shape back into the music after Play
    const own = shaped[i]
    const was = letGo?.spans[i]
    if (own) m = { pos: (own[0] + own[1]) / 2, squash: 1, angle: 0, accent: 0, span: own }
    else if (was && letGo) {
      const k = snapEase(Math.min(1, letGo.time / SETTLE), 0.4)
      const [bottom, top] = m.span ?? [m.pos - 1, m.pos + 1]
      const span: Span = [was[0] + (bottom - was[0]) * k, was[1] + (top - was[1]) * k]
      m = { ...m, pos: (span[0] + span[1]) / 2, span }
    }
    // while a loop is on the melody holds still and each letter snaps down onto the bottom line
    if (stave.loop) {
      const k = snapEase(Math.min(1, stave.loopTime / SETTLE), 0.4)
      const [bottom, top] = m.span ?? [m.pos - 1, m.pos + 1]
      const span: [number, number] = [bottom + (-STAFF_EDGE - 1 - bottom) * k, top + (-STAFF_EDGE + 1 - top) * k]
      m = { pos: (span[0] + span[1]) / 2, squash: 1, angle: m.angle * (1 - k), accent: 0, span }
    }
    const centre = middle - m.pos * step
    const w = g0.advance * unit

    // ledger lines, as in notation: every line position between the stave and the note
    const resting = Math.round(m.pos)
    if (stave.lines && Math.abs(resting) > STAFF_EDGE) {
      ctx.fillStyle = faint
      const dir = Math.sign(resting)
      for (let k = STAFF_EDGE + 2; k <= Math.abs(resting); k += 2) {
        rule(xs[i] - w * 0.2, middle - dir * k * step - line / 2, w * 1.4, line)
      }
    }

    // an accent pops the letter bolder and a little bigger (weight in steps of 10)
    const weight = Math.round((state.weight + (heaviest - state.weight) * m.accent) / 10) * 10
    const g: Glyph = weight === state.weight ? g0 : engine.glyph(text[i], weight, slant, axes)
    const grow = 1 + 0.15 * m.accent

    // the notehead: cap height centred on its line or space; squash, flips and accents all happen
    // about that centre, so it never leaves its note
    let baseline = centre + gap / 2
    let stretch = { sx: 1, sy: 1, w: 1 }
    // Animate Height moves the letter's edges up towards its top note (a whole step, so it sits on a
    // line or in a space up there) and back
    const climb = Math.round((stave.loopHeight / 100) * MAX_LOOP_STEPS)
    const [up0, up1] = stave.loop
      ? loopSpan(stave.loop, n > 1 ? i / (n - 1) : 0.5, middleLetter, stave.loopPhase, 1 / loopRate(stave.loopSpeed))
      : [0, 0]
    const [bottom, top] = m.span ?? [m.pos - 1, m.pos + 1]
    const edges: Span = [bottom + up0 * climb, top + up1 * climb]
    if (m.span || up0 !== 0 || up1 !== 0) {
      // stretched (strokes keeping their thickness) between its bottom and top edges
      baseline = middle - edges[0] * step
      stretch = { sx: 1, sy: Math.max(0.2, (edges[1] - edges[0]) / 2), w: 1 }
    }
    drawn.letters[i] = { x: xs[i], w, span: edges }
    const cx = xs[i] + w / 2
    ctx.save()
    ctx.translate(cx, centre)
    ctx.rotate(m.angle)
    ctx.scale(grow / Math.sqrt(m.squash), grow * m.squash)
    ctx.translate(-cx, -centre)
    ctx.fillStyle = '#fff'
    // the heavier glyph is wider: keep it centred on the same spot
    const shift = ((g0.advance - g.advance) * unit) / 2
    const d = engine.path(g, stretch, {
      x: xs[i] + shift,
      baseline,
      scale: unit,
      pivot: centre,
      // the glyph comes back with the font's own slant removed, so lean it by the whole angle
      slant: Math.tan((state.slant * Math.PI) / 180),
    })
    ctx.fill(new Path2D(d))
    ctx.restore()
    const sx = grow / Math.sqrt(m.squash)
    const sy = grow * m.squash
    const turned = m.angle !== 0 || sx !== 1 || sy !== 1
    picture.letters.push({
      d,
      transform: turned
        ? `translate(${cx} ${centre}) rotate(${(m.angle * 180) / Math.PI}) scale(${sx} ${sy}) translate(${-cx} ${-centre})`
        : undefined,
    })
  }
}

// Where each letter was last drawn, for shaping by hand: canvas px for the stave's middle line and
// one step, the furthest step the canvas shows, and each letter's left edge, width and edges in steps
let drawn: { middle: number; step: number; limit: number; letters: ({ x: number; w: number; span: Span } | undefined)[] } = {
  middle: 0,
  step: 1,
  limit: 0,
  letters: [],
}

export type Grip = 'top' | 'bottom' | 'middle'

/** The letter under canvas point (x, y), and whether it's held by its top, bottom or middle. */
export function shapeTarget(x: number, y: number): { index: number; grip: Grip } | null {
  if (!canShape()) return null
  const { middle, step } = drawn
  for (let i = drawn.letters.length - 1; i >= 0; i--) {
    const l = drawn.letters[i]
    if (!l) continue
    const top = middle - l.span[1] * step
    const bottom = middle - l.span[0] * step
    const pad = step * 0.4
    if (x < l.x - pad || x > l.x + l.w + pad || y < top - pad || y > bottom + pad) continue
    // the edges are a band about a third of a notehead deep (less on a squashed letter)
    const band = Math.min((bottom - top) * 0.3, step * 0.9)
    return { index: i, grip: y < top + band ? 'top' : y > bottom - band ? 'bottom' : 'middle' }
  }
  return null
}

let grab: { index: number; grip: Grip; from: Span; y: number } | null = null

/** Takes hold of the letter at (x, y), if there's one to shape; returns whether it did. */
export function startShaping(x: number, y: number) {
  const target = shapeTarget(x, y)
  const l = target && drawn.letters[target.index]
  if (!target || !l) return false
  grab = { ...target, from: [Math.round(l.span[0]), Math.round(l.span[1])], y }
  return true
}

/**
 * Follows the pointer to canvas height y: a held top or bottom edge goes to the line or space
 * there (at least a step from the other edge); a letter held by the middle moves whole.
 */
export function shapeTo(y: number) {
  if (!grab) return
  const moved = (grab.y - y) / drawn.step
  const limit = drawn.limit
  let [bottom, top] = grab.from
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  if (grab.grip === 'top') top = clamp(Math.round(top + moved), bottom + 1, limit)
  else if (grab.grip === 'bottom') bottom = clamp(Math.round(bottom + moved), -limit, top - 1)
  else {
    const by = clamp(Math.round(moved), -limit - bottom, limit - top)
    bottom += by
    top += by
  }
  shaped[grab.index] = [bottom, top]
}

export function stopShaping() {
  grab = null
}

export const isShaping = () => grab !== null

// What was last drawn, in canvas px, for saving as SVG: the stave and ledger lines (x, y, width,
// height) and each letter's outline with the squash, flip or accent it was drawn with
let picture: { width: number; height: number; rules: number[][]; letters: { d: string; transform?: string }[] } = {
  width: 0,
  height: 0,
  rules: [],
  letters: [],
}

/** The Stave as it's showing, as an SVG file: background, stave lines and letters in their own groups. */
export function staveSvg() {
  const { width, height, rules, letters } = picture
  const num = (v: number) => String(Math.round(v * 100) / 100)
  const lines = rules.map(([x, y, w, h]) => `    <rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"/>`)
  const shapes = letters.map(({ d, transform }) => `    <path d="${d}"${transform ? ` transform="${transform}"` : ''}/>`)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <rect id="background" width="${width}" height="${height}" fill="#000"/>`,
    ...(lines.length ? ['  <g id="stave" fill="#fff" fill-opacity="0.4">', ...lines, '  </g>'] : []),
    '  <g id="letters" fill="#fff">',
    ...shapes,
    '  </g>',
    '</svg>',
    '',
  ].join('\n')
}
