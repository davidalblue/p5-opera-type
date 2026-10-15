import { TypeEngine, type AxisValues } from './engine'

interface FontChoice {
  name: string
  file: string // path inside public/fonts
  axes?: AxisValues // axis values pinned for this family
}

// The first font that loads is the default. Files in public/fonts/local/ are git-ignored, so they're
// only there when running on this computer (trial fonts can't be published) — elsewhere they're skipped.
export const FONTS: FontChoice[] = [
  // GT Ultra variable font, with its contrast axis starting at the Fine end
  { name: 'GT Ultra Fine', file: 'local/GT-Ultra-Trial-VF.ttf', axes: { CNTR: 100 } },
  // ABC Arizona superfamily: serif, width, weight and slant axes
  { name: 'ABC Arizona', file: 'local/ABCArizonaSuperfamilyVariableTrial.ttf' },
  // Bundled, SIL Open Font License
  { name: 'Source Serif Display', file: 'SourceSerif4Display-Semibold.otf' },
  { name: 'Playfair Display', file: 'PlayfairDisplay.ttf' },
  { name: 'DM Serif Display', file: 'DMSerifDisplay-Regular.ttf' },
  { name: 'Libre Caslon Display', file: 'LibreCaslonDisplay-Regular.ttf' },
  { name: 'Gloock', file: 'Gloock-Regular.ttf' },
  { name: 'Instrument Serif', file: 'InstrumentSerif-Regular.ttf' },
]

const fontUrl = (file: string) => `${import.meta.env.BASE_URL}fonts/${file}`
const loadChoice = (f: FontChoice) => TypeEngine.load(fontUrl(f.file), f.axes)
const missing = new Set<string>()

/** Loads the first font in FONTS that's available. */
export async function loadDefaultFont() {
  for (const f of FONTS) {
    try {
      return { key: f.file, engine: await loadChoice(f) }
    } catch {
      missing.add(f.file)
    }
  }
  throw new Error('None of the fonts could be loaded')
}

/** Font dropdown plus an upload button for local .otf/.ttf/.woff files. */
export function initFontPicker(initialKey: string, initial: TypeEngine, onPick: (engine: TypeEngine) => void) {
  const select = document.querySelector<HTMLSelectElement>('#font-select')!
  const upload = document.querySelector<HTMLButtonElement>('#font-upload')!
  const input = document.querySelector<HTMLInputElement>('#font-file')!
  const engines = new Map<string, TypeEngine>([[initialKey, initial]])

  for (const f of FONTS) if (!missing.has(f.file)) select.add(new Option(f.name, f.file))
  select.value = initialKey
  let current = initialKey

  const pick = (key: string, engine: TypeEngine) => {
    current = key
    select.value = key
    onPick(engine)
  }

  select.addEventListener('change', async () => {
    const key = select.value
    // drop focus so typing goes to the word instead of the dropdown's type-ahead
    select.blur()
    let engine = engines.get(key)
    if (!engine) {
      select.disabled = true
      try {
        engine = await loadChoice(FONTS.find((f) => f.file === key)!)
        engines.set(key, engine)
      } catch {
        select.value = current
        flash("Couldn't load that font")
        return
      } finally {
        select.disabled = false
      }
    }
    pick(key, engine)
  })

  upload.addEventListener('click', (e) => {
    if (e.detail > 0) upload.blur()
    input.click()
  })

  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    try {
      const engine = TypeEngine.fromBuffer(await file.arrayBuffer())
      const key = `upload:${engines.size}`
      engines.set(key, engine)
      select.add(new Option(engine.name ?? file.name.replace(/\.\w+$/, ''), key))
      pick(key, engine)
    } catch {
      flash(/\.woff2$/i.test(file.name) ? 'WOFF2 isn’t supported — use .otf, .ttf or .woff' : `Couldn’t read ${file.name}`)
    }
  })
}

let flashTimer = 0

/** Shows a short message in the panel footer in place of the usual hint. */
function flash(message: string) {
  const hint = document.querySelector<HTMLElement>('#hint')!
  hint.dataset.default ??= hint.textContent ?? ''
  hint.textContent = message
  hint.classList.add('is-error')
  clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => {
    hint.textContent = hint.dataset.default!
    hint.classList.remove('is-error')
  }, 4000)
}
