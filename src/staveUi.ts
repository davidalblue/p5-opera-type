import type { LoopMode } from './loops'
import { canShape, newMelody, resetStave, stave, staveSvg, toggleLoop, togglePlay, type Melody } from './stave'
import { state } from './state'
import { addSync, barsSvg, button, slider, type Bind } from './ui'

const MELODIES: { mode: Melody; label: string }[] = [
  { mode: 'wave', label: 'Wave' },
  { mode: 'scale', label: 'Scale' },
  { mode: 'random', label: 'Random' },
  { mode: 'unison', label: 'Unison' },
]

const LOOPS: LoopMode[] = ['wave', 'breathe', 'ripple', 'sweep']

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

type Key = 'range' | 'tempo' | 'rhythm' | 'cascade' | 'bounce' | 'squash' | 'flip' | 'accent' | 'size' | 'spacing' | 'reach' | 'hold' | 'snap' | 'stick' | 'loopSpeed' | 'loopHeight'
const bind = (key: Key): Bind => ({ get: () => stave[key], set: (v) => (stave[key] = v) })
const between = (min: number, max: number) => () => [min, max] as [number, number]

/** Builds the Stave tool's panel: melody, rhythm, motion, stave layout and quick actions. */
export function initStavePanel() {
  const melodies = $('#stave-melody')
  for (const { mode, label } of MELODIES) {
    const b = document.createElement('button')
    b.className = 'tile'
    b.dataset.melody = mode
    b.textContent = label
    melodies.append(button(b, () => (stave.melody = mode)))
  }
  $('#stave-melody-sliders').append(slider('Range', bind('range'), between(2, 12)))
  const percent = between(0, 100)
  $('#stave-rhythm').append(
    slider('Tempo', bind('tempo'), between(60, 180)),
    slider('Rhythm', bind('rhythm'), percent),
    slider('Cascade', bind('cascade'), percent),
  )
  $('#stave-motion').append(
    slider('Bounce', bind('bounce'), percent),
    slider('Squash', bind('squash'), percent),
    slider('Flip', bind('flip'), percent),
    slider('Accent', bind('accent'), percent),
  )
  // Warp's sliders are greyed out while it's switched off
  const whenWarping = () => (stave.warp ? ([0, 100] as [number, number]) : null)
  $('#stave-warp').append(
    slider('Reach', bind('reach'), whenWarping),
    slider('Hold', bind('hold'), whenWarping),
    slider('Snap', bind('snap'), whenWarping),
    slider('Stick', bind('stick'), whenWarping),
  )
  button($('#warp-switch'), () => (stave.warp = !stave.warp))

  // Animate Height: each button plays its loop (while playing) in place of the melody until it's pressed again
  const loops = $('#loop-modes')
  for (const mode of LOOPS) {
    const b = document.createElement('button')
    b.className = 'tile'
    b.dataset.loop = mode
    b.setAttribute('aria-label', `Animate height: ${mode}`)
    b.append(barsSvg())
    loops.append(button(b, () => toggleLoop(mode)))
  }
  $('#loop-sliders').append(slider('Speed', bind('loopSpeed'), percent), slider('Height', bind('loopHeight'), percent))

  $('#stave-layout').append(slider('Size', bind('size'), percent), slider('Spacing', bind('spacing'), percent))

  button($('#stave-lines'), () => (stave.lines = !stave.lines))
  button($('#stave-new'), newMelody)
  button($('#stave-play'), togglePlay)
  button($('#stave-reset'), resetStave)
  // while paused, the letters (and stave lines, if shown) as they stand, as vectors
  button($('#stave-svg'), () => {
    if (stave.playing) return
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([staveSvg()], { type: 'image/svg+xml' }))
    link.download = `${state.text.trim() || 'type'}.svg`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  })

  addSync(() => {
    for (const b of document.querySelectorAll<HTMLElement>('[data-melody]')) {
      b.classList.toggle('is-active', b.dataset.melody === stave.melody)
    }
    const lines = $('#stave-lines')
    lines.classList.toggle('is-active', stave.lines)
    lines.setAttribute('aria-pressed', String(stave.lines))
    $('#stave-play').textContent = stave.playing ? 'Pause' : 'Play'
    $('#shape-note').hidden = !canShape()
    $<HTMLButtonElement>('#stave-svg').disabled = stave.playing
    for (const b of document.querySelectorAll<HTMLElement>('[data-loop]')) {
      b.classList.toggle('is-active', b.dataset.loop === stave.loop)
      b.setAttribute('aria-pressed', String(b.dataset.loop === stave.loop))
    }
    const warp = $('#warp-switch')
    warp.classList.toggle('is-on', stave.warp)
    warp.setAttribute('aria-checked', String(stave.warp))
  })
}
