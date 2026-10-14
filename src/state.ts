export type HeightMode = 'up' | 'valley' | 'easeUp' | 'down' | 'peak' | 'easeDown'
export type ItalicMode = 'upright' | 'italic' | 'ramp' | 'rampReverse'
export type Baseline = 'bottom' | 'top'

// Exponent of the two eased curves; matches the falloff in the reference tool
const EASE = 2.5

const valley = (t: number, c: number) => (t < c ? 1 - t / c : t > c ? (t - c) / (1 - c) : 0)

/** Height curves over the word: t is the letter's position (0–1), c the position of the middle letter. */
export const HEIGHT_CURVES: Record<HeightMode, (t: number, c: number) => number> = {
  up: (t) => t,
  valley,
  easeUp: (t) => t ** EASE,
  down: (t) => 1 - t,
  peak: (t, c) => 1 - valley(t, c),
  easeDown: (t) => (1 - t) ** EASE,
}

export const ITALIC_CURVES: Record<ItalicMode, (t: number) => number> = {
  upright: () => 0,
  italic: () => 1,
  ramp: (t) => t,
  rampReverse: (t) => 1 - t,
}

export const DEFAULTS = { minHeight: 0, maxHeight: 100, minItalic: 0, maxItalic: 40 }
export const MAX_ITALIC = 40

export interface State {
  text: string
  // 'random' and null mean no button is selected: random values per letter, or the minimum
  baseline: Baseline | 'random'
  heightMode: HeightMode | 'random' | null
  italicMode: ItalicMode | 'random' | null
  minHeight: number
  maxHeight: number
  minItalic: number
  maxItalic: number
  weight: number // applies to fonts with a weight axis; not touched by Reset Selection
  stroke: number // 0–100: how much strokes thicken as letters grow (0 keeps the font's thickness)
  random: { height: number[]; italic: number[]; anchor: number[] }
  // Where each letter has been dragged to, relative to its place in the word (in box heights)
  offsets: { x: number; y: number }[]
}

export const state: State = {
  text: 'MOZART',
  baseline: 'bottom',
  heightMode: null,
  italicMode: null,
  ...DEFAULTS,
  weight: 400,
  stroke: 0,
  random: { height: [], italic: [], anchor: [] },
  offsets: [],
}

/** Per-letter targets: height 0–1, italic in degrees, anchor 0 (bottom) – 1 (top), drag offset. */
export function target(i: number, n: number) {
  const s = state
  const t = n > 1 ? i / (n - 1) : 0.5
  const c = n > 1 ? Math.floor((n - 1) / 2) / (n - 1) : 0.5

  const h =
    s.heightMode === 'random' ? s.random.height[i] : s.heightMode ? HEIGHT_CURVES[s.heightMode](t, c) : 0
  const it =
    s.italicMode === 'random' ? s.random.italic[i] : s.italicMode ? ITALIC_CURVES[s.italicMode](t) : 0
  const anchor = s.baseline === 'random' ? s.random.anchor[i] : s.baseline === 'top' ? 1 : 0

  return {
    height: (s.minHeight + (s.maxHeight - s.minHeight) * h) / 100,
    italic: s.minItalic + (s.maxItalic - s.minItalic) * it,
    anchor,
    dx: s.offsets[i]?.x ?? 0,
    dy: s.offsets[i]?.y ?? 0,
  }
}

const coin = () => (Math.random() < 0.5 ? 0 : 1)

/** Keep the per-letter arrays as long as the text, without rerolling existing letters. */
export function fillRandom() {
  const r = state.random
  while (r.height.length < state.text.length) {
    r.height.push(Math.random())
    r.italic.push(coin() * Math.random())
    r.anchor.push(coin())
  }
  while (state.offsets.length < state.text.length) state.offsets.push({ x: 0, y: 0 })
}

/**
 * Replaces `remove` characters at `index` with `insert`, moving the per-letter random values
 * and drag offsets along so every letter keeps its own.
 */
export function spliceText(index: number, remove: number, insert: string) {
  const s = state
  const n = insert.length
  s.text = s.text.slice(0, index) + insert + s.text.slice(index + remove)
  s.random.height.splice(index, remove, ...Array.from({ length: n }, Math.random))
  s.random.italic.splice(index, remove, ...Array.from({ length: n }, () => coin() * Math.random()))
  s.random.anchor.splice(index, remove, ...Array.from({ length: n }, coin))
  s.offsets.splice(index, remove, ...Array.from({ length: n }, () => ({ x: 0, y: 0 })))
}

export function randomizeHeight() {
  state.random.height = []
  fillRandom()
  state.heightMode = 'random'
}

export function randomizeEverything() {
  state.random = { height: [], italic: [], anchor: [] }
  fillRandom()
  state.heightMode = 'random'
  state.italicMode = 'random'
  state.baseline = 'random'
}

/** Back to the starting look, including undoing any dragging. Keeps the text, font and weight. */
export function reset() {
  Object.assign(state, DEFAULTS, { baseline: 'bottom', heightMode: null, italicMode: null })
  state.offsets = state.offsets.map(() => ({ x: 0, y: 0 }))
}
