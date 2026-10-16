export type LoopMode = 'wave' | 'breathe' | 'ripple' | 'sweep'

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Eases 0 → 1, overshooting by up to `amount` (0–1) as it snaps into place. */
export const snapEase = (u: number, amount: number) => {
  const c = amount * 2.2
  return 1 + (c + 1) * (u - 1) ** 3 + c * (u - 1) ** 2
}

// Each letter's turn, in seconds, as two Warp moves at its default Snap: up to the top note, a stay
// there, then back down to the bottom line
const REACH = 0.16 // an edge reaching out
const STRETCHED = 0.06 // holding stretched
const RELEASE = 0.18 // the other edge letting go and snapping after it
const TOP = 0.25 // staying at the top in its own shape
const SNAP = 0.4
// The share of each loop over which the letters set off one after another
const STAGGER = 0.4
// Every letter's turn ends by this share of the loop, so a loop is done before the next one starts
const END = 0.95

/**
 * When letter i sets off in a forward loop (a share of the loop) and how much longer it stays at the
 * top (seconds): t is its place in the word (0–1), c the middle letter's, cycle the loop's length.
 */
const TIMING: Record<LoopMode, (t: number, c: number, cycle: number) => { at: number; stay: number }> = {
  wave: (t) => ({ at: t * STAGGER, stay: 0 }), // one after another, left to right
  breathe: () => ({ at: 0, stay: 0 }), // all together
  // from the middle out
  ripple: (t, c) => ({ at: (Math.abs(t - c) / Math.max(c, 1 - c)) * STAGGER, stay: 0 }),
  // up one after another, then all come down together once the last is up
  sweep: (t, _, cycle) => ({ at: t * STAGGER, stay: (STAGGER - t * STAGGER) * cycle }),
}

/**
 * Where a letter's bottom and top edges are, as shares of the climb to the top note (0 at rest on
 * the bottom line, 1 at the top), `phase` loops in, each `cycle` seconds long. Its top reaches up
 * and its bottom snaps after it; it stays at the top in its own shape; then its bottom reaches down
 * and its top snaps after it. Loops alternate: every other one plays the letters' turns in reverse
 * order (Wave right to left, Ripple from the outside in, Sweep up together and down one by one).
 * Between turns, and before its first, the letter rests.
 */
export function loopSpan(mode: LoopMode, t: number, c: number, phase: number, cycle: number): [number, number] {
  if (phase < 0) return [0, 0]
  const loop = Math.floor(phase)
  const timing = (x: number) => TIMING[mode](x, c, cycle)
  // the turns are quicker if a loop is too short to fit them all
  const base = 2 * (REACH + STRETCHED + RELEASE) + TOP
  const latest = Math.max(...[0, 1].map((x) => timing(x).at + timing(x).stay / cycle))
  const fit = Math.min(1, ((END - latest) * cycle) / base)
  const { at, stay } = timing(t)
  const length = base * fit + stay // seconds
  // played backwards, a turn starts as long before the loop's last moment as it ended after the start
  const start = loop % 2 === 0 ? at : latest + (base * fit) / cycle - at - length / cycle
  let since = (phase - loop - start) * cycle // seconds into this letter's turn
  if (since < 0 || since >= length) return [0, 0]
  const [reach, stretched, release, top] = [REACH * fit, STRETCHED * fit, RELEASE * fit, TOP * fit + stay]
  // the way up
  if (since < reach) return [0, easeInOut(since / reach)]
  if ((since -= reach) < stretched) return [0, 1]
  if ((since -= stretched) < release) return [snapEase(since / release, SNAP), 1]
  if ((since -= release) < top) return [1, 1]
  // the way down
  if ((since -= top) < reach) return [1 - easeInOut(since / reach), 1]
  if ((since -= reach) < stretched) return [0, 1]
  if ((since -= stretched) < release) return [0, 1 - snapEase(since / release, SNAP)]
  return [0, 0]
}

/** Loops per second at a Speed (0–100). */
export const loopRate = (speed: number) => 0.2 * 6 ** (speed / 100)
