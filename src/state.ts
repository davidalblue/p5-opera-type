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
  random: { height: number[]; italic: number[]; anchor: number[] }
}

export const state: State = {
  text: 'MOZART',
  baseline: 'bottom',
  heightMode: null,
  italicMode: null,
  ...DEFAULTS,
  random: { height: [], italic: [], anchor: [] },
}

/** Per-letter targets: height 0–1, italic in degrees, anchor 0 (bottom) – 1 (top). */
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
  }
}

const coin = () => (Math.random() < 0.5 ? 0 : 1)

/** Keep the random arrays as long as the text, without rerolling existing letters. */
export function fillRandom() {
  const r = state.random
  while (r.height.length < state.text.length) {
    r.height.push(Math.random())
    r.italic.push(coin() * Math.random())
    r.anchor.push(coin())
  }
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

export function reset() {
  Object.assign(state, DEFAULTS, { baseline: 'bottom', heightMode: null, italicMode: null })
}
