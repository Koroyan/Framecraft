import type { SubtitleCue } from '@framecraft/shared';

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');

export function formatSrtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  return `${pad(ms / 3_600_000)}:${pad((ms / 60_000) % 60)}:${pad((ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: Pick<SubtitleCue, 'startSec' | 'endSec' | 'text'>[]): string {
  return cues
    .filter((c) => c.endSec > c.startSec && c.text.trim())
    .sort((a, b) => a.startSec - b.startSec)
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.startSec)} --> ${formatSrtTime(c.endSec)}\n${c.text.trim()}\n`)
    .join('\n');
}

export function toVtt(cues: Pick<SubtitleCue, 'startSec' | 'endSec' | 'text'>[]): string {
  return `WEBVTT\n\n${toSrt(cues).replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2')}`;
}

export function parseSrt(srt: string): Omit<SubtitleCue, 'id'>[] {
  const blocks = srt.replace(/\r/g, '').split(/\n\n+/);
  const toSec = (t: string) => {
    const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : 0;
  };
  const cues: Omit<SubtitleCue, 'id'>[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    const timing = lines.find((l) => l.includes('-->'));
    if (!timing) continue;
    const [a, z] = timing.split('-->');
    const text = lines.slice(lines.indexOf(timing) + 1).join('\n');
    if (text) cues.push({ startSec: toSec(a!), endSec: toSec(z!), text });
  }
  return cues;
}

/** Group word timestamps from speech-to-text into readable cues (≤ maxChars, ≤ maxDuration). */
export function wordsToCues(words: { text: string; start: number; end: number }[], opts: { maxChars?: number; maxDuration?: number } = {}): Omit<SubtitleCue, 'id'>[] {
  const maxChars = opts.maxChars ?? 42;
  const maxDuration = opts.maxDuration ?? 4;
  const cues: Omit<SubtitleCue, 'id'>[] = [];
  let cur: { text: string; start: number; end: number } | undefined;
  for (const w of words) {
    const word = w.text.trim();
    if (!word) continue;
    if (cur && (cur.text.length + word.length + 1 > maxChars || w.end - cur.start > maxDuration || /[.!?]$/.test(cur.text))) {
      cues.push({ startSec: cur.start, endSec: cur.end, text: cur.text });
      cur = undefined;
    }
    cur = cur ? { text: `${cur.text} ${word}`, start: cur.start, end: w.end } : { text: word, start: w.start, end: w.end };
  }
  if (cur) cues.push({ startSec: cur.start, endSec: cur.end, text: cur.text });
  return cues;
}

/** Evenly time a script across a duration (used when no transcription is available). */
export function scriptToCues(script: string, startSec: number, durationSec: number): Omit<SubtitleCue, 'id'>[] {
  const sentences = script.replace(/\s+/g, ' ').split(/(?<=[.!?…])\s+/).filter((s) => s.trim());
  const chunks = sentences.flatMap((s) => {
    const words = s.split(' ');
    const out: string[] = [];
    for (let i = 0; i < words.length; i += 7) out.push(words.slice(i, i + 7).join(' '));
    return out;
  });
  const totalChars = chunks.reduce((a, c) => a + c.length, 0) || 1;
  let t = startSec;
  return chunks.map((c) => {
    const d = (c.length / totalChars) * durationSec;
    const cue = { startSec: Math.round(t * 1000) / 1000, endSec: Math.round((t + d) * 1000) / 1000, text: c };
    t += d;
    return cue;
  });
}
