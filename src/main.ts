import p5 from 'p5'
import './style.css'
import { TypeEngine } from './engine'
import { layoutWord, type Letter } from './layout'
import { fillRandom, state, target } from './state'
import { initPanel } from './ui'

// Swap in any .otf/.ttf placed in public/fonts (e.g. a licensed ABC Arizona)
const FONT_URL = `${import.meta.env.BASE_URL}fonts/SourceSerif4Display-Semibold.otf`
const MAX_LENGTH = 24
// A full-height letter is this many times its resting cap height
const MAX_STRETCH = 6
// Time constant of the easing between states, in ms
const EASE_MS = 90

TypeEngine.load(FONT_URL).then(start)

function start(engine: TypeEngine) {
  const stage = document.getElementById('stage')!
  const letters: Letter[] = []

  // Match the animated letters to the text; new letters appear at their target straight away
  const syncLetters = () => {
    fillRandom()
    const n = state.text.length
    letters.length = Math.min(letters.length, n)
    for (let i = 0; i < n; i++) {
      const ch = state.text[i]
      if (letters[i]) letters[i].ch = ch
      else letters[i] = { ch, ...settled(i, n) }
    }
  }
  const settled = (i: number, n: number) => {
    const t = target(i, n)
    return { height: t.height, italic: t.italic, anchor: t.anchor }
  }

  syncLetters()
  initPanel(engine, syncLetters)

  new p5((p: p5) => {
    p.setup = () => {
      p.createCanvas(stage.clientWidth, stage.clientHeight)
      new ResizeObserver(() => p.resizeCanvas(stage.clientWidth, stage.clientHeight)).observe(stage)
      window.addEventListener('keydown', (e) => onKey(e, p))
    }

    p.draw = () => {
      const k = 1 - Math.exp(-p.deltaTime / EASE_MS)
      letters.forEach((l, i) => {
        const t = target(i, letters.length)
        l.height += (t.height - l.height) * k
        l.italic += (t.italic - l.italic) * k
        l.anchor += (t.anchor - l.anchor) * k
      })

      p.background(0)
      const ctx = p.drawingContext as CanvasRenderingContext2D
      ctx.fillStyle = '#fff'
      const box = { x: p.width * 0.06, y: p.height * 0.22, w: p.width * 0.88, h: p.height * 0.51 }
      for (const d of layoutWord(engine, letters, box, MAX_STRETCH)) ctx.fill(new Path2D(d))
    }
  }, stage)

  function onKey(e: KeyboardEvent, p: p5) {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      p.saveCanvas(state.text.trim() || 'type', 'png')
      return
    }
    // Space and Enter belong to whichever button has keyboard focus
    if (document.activeElement instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return

    if (e.key === 'Backspace') {
      state.text = mod || e.altKey ? '' : state.text.slice(0, -1)
    } else if (!mod && e.key.length === 1 && state.text.length < MAX_LENGTH && engine.has(e.key.toUpperCase())) {
      state.text += e.key.toUpperCase()
    } else {
      return
    }
    e.preventDefault()
    syncLetters()
  }
}
