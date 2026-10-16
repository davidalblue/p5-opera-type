import { newMelody, stave, type Melody } from './stave'
import { addSync, button, slider, type Bind } from './ui'

const MELODIES: { mode: Melody; label: string }[] = [
  { mode: 'wave', label: 'Wave' },
  { mode: 'scale', label: 'Scale' },
  { mode: 'random', label: 'Random' },
  { mode: 'unison', label: 'Unison' },
]

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

type Key = 'range' | 'tempo' | 'rhythm' | 'cascade' | 'bounce' | 'squash' | 'flip' | 'accent' | 'size' | 'spacing' | 'reach' | 'hold' | 'snap'
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
  )
  button($('#warp-switch'), () => (stave.warp = !stave.warp))

  $('#stave-layout').append(slider('Size', bind('size'), percent), slider('Spacing', bind('spacing'), percent))

  button($('#stave-lines'), () => (stave.lines = !stave.lines))
  button($('#stave-new'), newMelody)
  button($('#stave-play'), () => (stave.playing = !stave.playing))

  addSync(() => {
    for (const b of document.querySelectorAll<HTMLElement>('[data-melody]')) {
      b.classList.toggle('is-active', b.dataset.melody === stave.melody)
    }
    const lines = $('#stave-lines')
    lines.classList.toggle('is-active', stave.lines)
    lines.setAttribute('aria-pressed', String(stave.lines))
    $('#stave-play').textContent = stave.playing ? 'Pause' : 'Play'
    const warp = $('#warp-switch')
    warp.classList.toggle('is-on', stave.warp)
    warp.setAttribute('aria-checked', String(stave.warp))
  })
}
