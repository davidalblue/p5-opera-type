import type { TypeEngine } from './engine'
import { layoutWord, type Letter } from './layout'
import {
  HEIGHT_CURVES,
  MAX_ITALIC,
  randomizeEverything,
  randomizeHeight,
  reset,
  state,
  type Baseline,
  type HeightMode,
  type ItalicMode,
} from './state'

type NumberKey = 'minHeight' | 'maxHeight' | 'minItalic' | 'maxItalic' | 'weight' | 'stroke'
type Range = [number, number]

const HEIGHT_MODES: HeightMode[] = ['up', 'valley', 'easeUp', 'down', 'peak', 'easeDown']
const ITALIC_MODES: ItalicMode[] = ['upright', 'italic', 'ramp', 'rampReverse']
const SVG = 'http://www.w3.org/2000/svg'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

let onChange = () => {}
let panelEngine: TypeEngine

/** Wires up the control panel. `changed` runs after every edit to the shared state. */
export function initPanel(engine: TypeEngine, changed: () => void) {
  onChange = () => {
    changed()
    syncPanel()
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-baseline]')) {
    button(b, () => (state.baseline = b.dataset.baseline as Baseline))
  }

  const heightModes = $('#height-modes')
  for (const mode of HEIGHT_MODES) {
    const b = el('button', { class: 'tile', 'data-height': mode, 'aria-label': `Height curve: ${mode}` })
    b.append(curveSvg(mode))
    heightModes.append(button(b, () => (state.heightMode = mode)))
  }

  const italicModes = $('#italic-modes')
  for (const mode of ITALIC_MODES) {
    const b = el('button', { class: 'tile', 'data-italic': mode, 'aria-label': `Italic: ${mode}` })
    italicModes.append(button(b, () => (state.italicMode = mode)))
  }

  const percent = (): Range => [0, 100]
  const italic = (): Range => [0, MAX_ITALIC]
  $('#weight-slider').append(
    slider('Weight', 'weight', () => panelEngine.weightRange),
    slider('Stroke', 'stroke', percent),
  )
  $('#height-sliders').append(slider('Min Height', 'minHeight', percent), slider('Max Height', 'maxHeight', percent))
  $('#italic-sliders').append(slider('Min Italic', 'minItalic', italic), slider('Max Italic', 'maxItalic', italic))

  button($('#randomize-all'), randomizeEverything)
  button($('#randomize-height'), randomizeHeight)
  button($('#reset'), reset)

  setPanelFont(engine)
  syncPanel()
}

/** Redraws the parts of the panel that are set in the current font: the wordmark and italic icons. */
export function setPanelFont(engine: TypeEngine) {
  panelEngine = engine
  const w = state.weight
  $('#logo').replaceChildren(wordSvg(engine, logoLetters(), 180, 52, 3, w))
  for (const b of document.querySelectorAll<HTMLElement>('[data-italic]')) {
    b.replaceChildren(wordSvg(engine, italicIcon(engine, b.dataset.italic as ItalicMode), 54, 26, 1.9, w))
  }
}

/** Reflects the state in the panel: selected buttons and slider positions. */
export function syncPanel() {
  const active = (sel: string, on: (b: HTMLElement) => boolean) => {
    for (const b of document.querySelectorAll<HTMLElement>(sel)) b.classList.toggle('is-active', on(b))
  }
  active('[data-baseline]', (b) => b.dataset.baseline === state.baseline)
  active('[data-height]', (b) => b.dataset.height === state.heightMode)
  active('[data-italic]', (b) => b.dataset.italic === state.italicMode)
  for (const s of document.querySelectorAll<HTMLElement>('.slider')) (s as SliderEl).sync()
}

function button(b: HTMLElement, action: () => void) {
  b.addEventListener('click', (e) => {
    action()
    onChange()
    // mouse clicks shouldn't leave focus on the button, so Space keeps typing into the word
    if (e.detail > 0) b.blur()
  })
  return b
}

type SliderEl = HTMLElement & { sync: () => void }

/** A slider over `range()`; it's disabled while `range()` is null (e.g. weight on a single-weight font). */
function slider(label: string, key: NumberKey, range: () => Range | null) {
  const row = el('div', { class: 'slider' }) as SliderEl
  const track = el('div', { class: 'track', role: 'slider', tabindex: '0', 'aria-label': label })
  const thumb = el('div', { class: 'thumb' })
  track.append(thumb)
  row.append(el('span', { class: 'label' }, label), track)

  const set = (v: number) => {
    const r = range()
    if (!r) return
    v = Math.round(Math.min(r[1], Math.max(r[0], v)))
    // min can't pass max and vice versa
    if (key === 'minHeight') v = Math.min(v, state.maxHeight)
    if (key === 'maxHeight') v = Math.max(v, state.minHeight)
    if (key === 'minItalic') v = Math.min(v, state.maxItalic)
    if (key === 'maxItalic') v = Math.max(v, state.minItalic)
    if (v === state[key]) return
    state[key] = v
    onChange()
  }
  const fromPointer = (e: PointerEvent) => {
    const r = range()
    if (!r) return
    const box = track.getBoundingClientRect()
    const w = thumb.offsetWidth
    set(r[0] + ((e.clientX - box.left - w / 2) / (box.width - w)) * (r[1] - r[0]))
  }

  track.addEventListener('pointerdown', (e) => {
    track.setPointerCapture(e.pointerId)
    fromPointer(e)
  })
  track.addEventListener('pointermove', (e) => {
    if (track.hasPointerCapture(e.pointerId)) fromPointer(e)
  })
  track.addEventListener('keydown', (e) => {
    const r = range()
    if (!r) return
    const unit = r[1] - r[0] > 200 ? 10 : 1
    const step = e.shiftKey ? unit * 10 : unit
    const delta = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key]
    if (delta === undefined) return
    e.preventDefault()
    set(state[key] + delta)
  })

  row.sync = () => {
    const r = range()
    row.classList.toggle('is-disabled', !r)
    track.tabIndex = r ? 0 : -1
    track.setAttribute('aria-disabled', String(!r))
    if (!r) {
      thumb.textContent = '–'
      thumb.style.left = '0px'
      return
    }
    const v = state[key]
    thumb.textContent = String(v)
    thumb.style.left = `calc((100% - var(--thumb-w)) * ${(v - r[0]) / (r[1] - r[0])})`
    track.setAttribute('aria-valuemin', String(r[0]))
    track.setAttribute('aria-valuemax', String(r[1]))
    track.setAttribute('aria-valuenow', String(v))
  }
  return row
}

function curveSvg(mode: HeightMode) {
  const pts: string[] = []
  for (let i = 0; i <= 40; i++) {
    const t = i / 40
    pts.push(`${(6 + t * 88).toFixed(1)},${(26 - HEIGHT_CURVES[mode](t, 0.5) * 22).toFixed(1)}`)
  }
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 100 30')
  svg.setAttribute('class', 'curve')
  const line = document.createElementNS(SVG, 'polyline')
  line.setAttribute('points', pts.join(' '))
  svg.append(line)
  return svg
}

/** Renders letters with the same engine as the canvas, as an inline SVG. */
function wordSvg(engine: TypeEngine, letters: Letter[], w: number, h: number, maxStretch: number, weight: number) {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  svg.setAttribute('aria-hidden', 'true')
  for (const d of layoutWord(engine, letters, { x: 0, y: 0, w, h }, maxStretch, weight).paths) {
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

function italicIcon(engine: TypeEngine, mode: ItalicMode): Letter[] {
  const A = (italic: number): Letter => ({ ch: 'A', height: 1, italic, anchor: 0, dx: 0, dy: 0 })
  // not every font (e.g. trial cuts) has an en dash
  const dash: Letter = { ch: ['–', '-'].find((c) => engine.has(c)) ?? ' ', height: 1, italic: 0, anchor: 0, dx: 0, dy: 0 }
  if (mode === 'upright') return [A(0)]
  if (mode === 'italic') return [A(32)]
  if (mode === 'ramp') return [A(0), dash, A(32)]
  return [A(32), dash, A(0)]
}

// Wordmark in the panel header, set with the tool itself: tall outer letters, small ones hanging from the top
function logoLetters(): Letter[] {
  return [...'OPERA'].map((ch, i, all) => ({
    ch,
    height: i === 0 || i === all.length - 1 ? 1 : 0,
    italic: 0,
    anchor: 1,
    dx: 0,
    dy: 0,
  }))
}

function el(tag: string, attrs: Record<string, string>, text?: string) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  if (text) node.textContent = text
  return node
}
