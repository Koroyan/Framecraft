/* Cutting to the beat (pure; used by the editor). */

/**
 * New clip lengths so every cut lands on a beat: each clip keeps roughly its length but is
 * snapped to a whole number of beats (every `every` beats), never longer than its source allows.
 */
export function snapClipsToBeats(clips: { lengthSec: number; maxSec: number }[], beats: number[], startSec: number, every = 1): number[] {
  if (beats.length < 2) return clips.map((c) => c.lengthSec);
  const period = (beats[beats.length - 1]! - beats[0]!) / (beats.length - 1);
  const step = period * every;
  let t = startSec;
  const out: number[] = [];
  for (const c of clips) {
    const target = t + Math.min(c.lengthSec, c.maxSec);
    // The beat nearest the planned end, at least one step after the clip starts.
    const grid = beats.filter((b, i) => i % every === 0 && b >= t + Math.min(step, c.maxSec) - 0.02);
    const end = grid.length ? grid.reduce((m, b) => (Math.abs(b - target) < Math.abs(m - target) ? b : m), grid[0]!) : target;
    const len = Math.max(0.3, Math.min(c.maxSec, end - t));
    out.push(Math.round(len * 1000) / 1000);
    t += len;
  }
  return out;
}
