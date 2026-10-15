import p5 from 'p5'
import './style.css'
import type { TypeEngine } from './engine'
import { layoutWord, type Laid, type Letter } from './layout'
import { fillRandom, spliceText, state, target } from './state'
import { initFontPicker, loadDefaultFont } from './fontPicker'
import { buildFontAxes, initPanel, setPanelFont } from './ui'

const MAX_LENGTH = 24
// A full-height letter is this many times its resting cap height
const MAX_STRETCH = 6
// Time constant of the easing between states, in ms
const EASE_MS = 90
// How far the pointer must move before a press on a letter becomes a drag, in px
const DRAG_THRESHOLD = 4
// Extra grab margin around letters, so thin strokes are easy to pick up, in px
const GRAB_MARGIN = 10

loadDefaultFont().then(({ key, engine }) => start(key, engine))

function start(initialKey: string, initial: TypeEngine) {
  let engine = initial
  const stage = document.getElementById('stage')!
  const word = document.querySelector<HTMLInputElement>('#word')!

  // Animated copy of the targets in state, one per character
  fillRandom()
  const letters: Letter[] = [...state.text].map((ch, i) => ({ ch, ...settled(i) }))
  function settled(i: number) {
    const { height, italic, anchor, dx, dy } = target(i, state.text.length)
    return { height, italic, anchor, dx, dy }
  }

  // Editing the word on the canvas: a caret between letters while `editing`
  let editing = false
  let caret = state.text.length
  let blinkFrom = 0
  // Last frame's layout and letter shapes, for hit-testing and drawing the caret
  let laid: Laid | null = null
  let shapes: Path2D[] = []
  let drag: { index: number; x: number; y: number; from: { x: number; y: number }; moved: boolean } | null = null
  let saveNextFrame = false

  /** All text changes go through here so letters keep their own offsets, random values and animation. */
  const edit = (index: number, remove: number, insert: string) => {
    insert = [...insert].filter((ch) => engine.has(ch)).join('')
    insert = insert.slice(0, Math.max(0, MAX_LENGTH - (state.text.length - remove)))
    spliceText(index, remove, insert)
    letters.splice(index, remove, ...[...insert].map((ch) => ({ ch, ...settled(index) })))
    // new letters start where they're headed instead of animating in
    for (let i = index; i < index + insert.length; i++) Object.assign(letters[i], settled(i))
    caret = index + insert.length
    blinkFrom = performance.now()
    if (word.value !== state.text) word.value = state.text
  }

  // Word bar: work out what changed and apply it as one edit
  word.maxLength = MAX_LENGTH
  word.value = state.text
  word.addEventListener('focus', () => (editing = false))
  word.addEventListener('input', () => {
    const a = state.text
    const b = word.value
    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start++
    let end = 0
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
    edit(start, a.length - start - end, b.slice(start, b.length - end))
  })
  word.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') word.blur()
  })

  // A newly picked font starts from its own axis defaults; the weight is kept where the font allows
  const adoptFont = () => {
    const range = engine.weightRange
    if (range) state.weight = Math.min(range[1], Math.max(range[0], state.weight))
    state.slant = Math.min(state.slant, engine.maxSlant)
    state.axes = {}
    for (const a of engine.axisList) if (a.tag !== 'wght' && a.tag !== 'slnt') state.axes[a.tag] = a.default
    engine.setAxes(state.axes)
  }
  adoptFont()

  // the panel's wordmark and italic icons are set in the font, so redraw them when its look changes
  const look = () => JSON.stringify([state.weight, state.axes])
  let drawnLook = look()
  initPanel(engine, () => {
    engine.setAxes(state.axes)
    if (look() !== drawnLook) {
      drawnLook = look()
      setPanelFont(engine)
    }
  })
  initFontPicker(initialKey, engine, (picked) => {
    engine = picked
    adoptFont()
    drawnLook = look()
    setPanelFont(picked)
    buildFontAxes(picked)
  })

  new p5((p: p5) => {
    p.setup = () => {
      p.createCanvas(stage.clientWidth, stage.clientHeight)
      new ResizeObserver(() => p.resizeCanvas(stage.clientWidth, stage.clientHeight)).observe(stage)
      window.addEventListener('keydown', (e) => onKey(e))
      stage.addEventListener('pointerdown', onPointerDown)
      stage.addEventListener('pointermove', onPointerMove)
      stage.addEventListener('pointerup', onPointerUp)
      stage.addEventListener('pointercancel', () => (drag = null))
    }

    p.draw = () => {
      const k = 1 - Math.exp(-p.deltaTime / EASE_MS)
      letters.forEach((l, i) => {
        const t = target(i, letters.length)
        l.height += (t.height - l.height) * k
        l.italic += (t.italic - l.italic) * k
        l.anchor += (t.anchor - l.anchor) * k
        // a letter being dragged follows the pointer exactly
        const follow = drag?.moved && drag.index === i ? 1 : k
        l.dx += (t.dx - l.dx) * follow
        l.dy += (t.dy - l.dy) * follow
      })

      p.background(0)
      const ctx = p.drawingContext as CanvasRenderingContext2D
      ctx.fillStyle = '#fff'
      const box = { x: p.width * 0.06, y: p.height * 0.22, w: p.width * 0.88, h: p.height * 0.51 }
      laid = layoutWord(engine, letters, box, MAX_STRETCH, state.weight, state.stroke / 100, state.slant)
      shapes = laid.paths.map((d) => new Path2D(d))
      // the letter being dragged is drawn on top
      const order = shapes.map((_, i) => i)
      if (drag) order.push(...order.splice(drag.index, 1))
      for (const i of order) ctx.fill(shapes[i])

      const blinkOn = (performance.now() - blinkFrom) % 1000 < 600
      if (editing && blinkOn && !saveNextFrame) {
        ctx.fillStyle = 'rgb(255 255 255 / 0.85)'
        ctx.fillRect(caretX(caret) - 0.75, laid.top, 1.5, laid.bottom - laid.top)
      }
      if (saveNextFrame) {
        saveNextFrame = false
        p.saveCanvas(state.text.trim() || 'type', 'png')
      }
    }
  }, stage)

  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      // saved at the end of the next frame, which is drawn without the caret
      saveNextFrame = true
      return
    }
    // Keys already handled by a control (sliders), the word bar's own typing, and Space/Enter on a button
    const focused = document.activeElement
    if (e.defaultPrevented || focused === word) return
    if (focused instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return

    const n = state.text.length
    // Typing anywhere starts editing at the end of the word
    const begin = () => {
      if (!editing) caret = n
      editing = true
    }
    if (!mod && e.key.length === 1) {
      begin()
      edit(caret, 0, e.key)
    } else if (e.key === 'Backspace') {
      begin()
      if (mod || e.altKey) edit(0, caret, '')
      else if (caret > 0) edit(caret - 1, 1, '')
    } else if (e.key === 'Delete' && editing) {
      if (caret < n) edit(caret, 1, '')
    } else if (editing && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      if (e.key === 'ArrowLeft') caret = mod ? 0 : Math.max(0, caret - 1)
      if (e.key === 'ArrowRight') caret = mod ? n : Math.min(n, caret + 1)
      if (e.key === 'Home') caret = 0
      if (e.key === 'End') caret = n
      blinkFrom = performance.now()
    } else if (editing && (e.key === 'Escape' || e.key === 'Enter')) {
      editing = false
    } else {
      return
    }
    e.preventDefault()
  }

  // Pressing a letter and moving drags it; pressing without moving places the caret there.
  // Pressing empty canvas stops editing.
  function onPointerDown(e: PointerEvent) {
    if (e.target === word) return
    word.blur()
    const { x, y } = local(e)
    const index = hit(x, y)
    if (index < 0) {
      editing = false
      return
    }
    e.preventDefault()
    stage.setPointerCapture(e.pointerId)
    drag = { index, x: e.clientX, y: e.clientY, from: { ...state.offsets[index] }, moved: false }
  }

  function onPointerMove(e: PointerEvent) {
    if (e.target === word) return
    if (!drag) {
      const { x, y } = local(e)
      stage.style.cursor = hit(x, y) >= 0 ? 'grab' : ''
      return
    }
    const mx = e.clientX - drag.x
    const my = e.clientY - drag.y
    if (!drag.moved && Math.hypot(mx, my) < DRAG_THRESHOLD) return
    drag.moved = true
    stage.style.cursor = 'grabbing'
    const px = laid?.boxPx || 1
    state.offsets[drag.index] = { x: drag.from.x + mx / px, y: drag.from.y + my / px }
  }

  function onPointerUp(e: PointerEvent) {
    if (!drag) return
    if (!drag.moved) {
      editing = true
      caret = nearestCaret(local(e).x)
      blinkFrom = performance.now()
    }
    drag = null
    stage.style.cursor = 'grab'
  }

  const local = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  /** Index of the topmost letter under (x, y), allowing a small margin around thin strokes; -1 if none. */
  function hit(x: number, y: number) {
    const ctx = stage.querySelector('canvas')?.getContext('2d')
    if (!ctx || !laid) return -1
    const d = window.devicePixelRatio || 1
    ctx.save()
    ctx.setTransform(d, 0, 0, d, 0, 0)
    ctx.lineWidth = GRAB_MARGIN * 2
    let found = -1
    const order = shapes.map((_, i) => i).reverse()
    if (drag) order.unshift(...order.splice(order.indexOf(drag.index), 1))
    for (const i of order) {
      if (ctx.isPointInPath(shapes[i], x * d, y * d) || ctx.isPointInStroke(shapes[i], x * d, y * d)) {
        found = i
        break
      }
    }
    ctx.restore()
    return found
  }

  /** x of the caret before letter `i` (after the last letter when i = length). */
  function caretX(i: number) {
    const spans = laid?.spans ?? []
    const pad = 8
    if (!spans.length) return stage.clientWidth / 2
    if (i <= 0) return spans[0].left - pad
    if (i >= spans.length) return spans[spans.length - 1].right + pad
    return (spans[i - 1].right + spans[i].left) / 2
  }

  function nearestCaret(x: number) {
    let best = 0
    for (let i = 1; i <= state.text.length; i++) {
      if (Math.abs(caretX(i) - x) < Math.abs(caretX(best) - x)) best = i
    }
    return best
  }
}
