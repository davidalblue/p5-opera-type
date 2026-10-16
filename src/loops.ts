export type LoopMode = 'wave' | 'breathe' | 'ripple' | 'sweep'

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Eases 0 → 1, overshooting by up to `amount` (0–1) as it snaps into place. */
export const snapEase = (u: number, amount: number) => {
  const c = amount * 2.2
  return 1 + (c + 1) * (u - 1) ** 3 + c * (u - 1) ** 2
}

// Each letter's pulse, in seconds, like a Warp at its default Snap: reaching up, holding, snapping back
const REACH = 0.16
const HOLD = 0.12
const RELEASE = 0.18
const SNAP = 0.4
// The share of each loop over which the letters set off one after another
const STAGGER = 0.5

/**
 * When letter i sets off in each loop (a share of the loop) and how much longer it holds at full
 * stretch (seconds): t is its place in the word (0–1), c the middle letter's, cycle the loop's length.
 */
const TIMING: Record<LoopMode, (t: number, c: number, cycle: number) => { at: number; hold: number }> = {
  wave: (t) => ({ at: t * STAGGER, hold: 0 }), // one after another, left to right
  breathe: () => ({ at: 0, hold: 0 }), // all together
  ripple: (t, c) => ({ at: Math.abs(t - c) * 0.75, hold: 0 }), // from the middle out
  // one after another, then all snap back together once the last is up
  sweep: (t, _, cycle) => ({ at: t * STAGGER, hold: (STAGGER - t * STAGGER) * cycle }),
}

/**
 * How far a letter is stretched (0–1, dipping below 0 as it snaps back), `phase` loops in, each loop
 * `cycle` seconds long. Between pulses, and before its first, the letter is at rest.
 */
export function loopStretch(mode: LoopMode, t: number, c: number, phase: number, cycle: number) {
  const { at, hold } = TIMING[mode](t, c, cycle)
  if (phase < at) return 0
  const since = ((phase - at) % 1) * cycle // seconds into this loop's pulse
  const fit = Math.min(1, (cycle * 0.9) / (REACH + HOLD + hold + RELEASE))
  const [reach, held, release] = [REACH * fit, (HOLD + hold) * fit, RELEASE * fit]
  if (since < reach) return easeInOut(since / reach)
  if (since < reach + held) return 1
  if (since < reach + held + release) return 1 - snapEase((since - reach - held) / release, SNAP)
  return 0
}

/** Loops per second at a Speed (0–100). */
export const loopRate = (speed: number) => 0.2 * 6 ** (speed / 100)
