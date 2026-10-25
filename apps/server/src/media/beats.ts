import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg } from './ffmpeg';

/*
 * Beat detection for "cut to the beat": an onset envelope from the music's energy (mono, 11 kHz,
 * ~23 ms hops), the tempo from its autocorrelation (60–180 BPM), then a beat grid phase-aligned
 * to the strongest onsets. Deterministic, local, no AI.
 */

export type BeatAnalysis = { bpm: number; beats: number[]; durationSec: number; confidence: number };

export async function detectBeats(file: string): Promise<BeatAnalysis> {
  const sr = 11025;
  const raw = path.join(os.tmpdir(), `fc-beats-${process.pid}-${Date.now()}.raw`);
  try {
    await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', String(sr), '-t', '600', '-f', 's16le', raw], { timeoutMs: 5 * 60_000 });
    const buf = await fsp.readFile(raw);
    const n = Math.floor(buf.length / 2);
    const hop = 256;
    const frames = Math.floor(n / hop);
    const energy = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
      let e = 0;
      for (let i = 0; i < hop; i++) {
        const v = buf.readInt16LE((f * hop + i) * 2) / 32768;
        e += v * v;
      }
      energy[f] = Math.log1p(1000 * e);
    }
    // Onset strength: positive change of the (log) energy, locally normalised.
    const onset = new Float64Array(frames);
    for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f]! - energy[f - 1]!);
    const fps = sr / hop;
    const durationSec = n / sr;
    if (frames < fps * 4) return { bpm: 0, beats: [], durationSec, confidence: 0 };

    // Tempo: autocorrelation of the mean-removed onset envelope, 60–180 BPM, then octave-corrected
    // (half or double tempo when that peak is nearly as strong and closer to 90–140 BPM).
    let m = 0;
    for (let f = 0; f < frames; f++) m += onset[f]!;
    m /= frames;
    const centred = onset.map((v) => v - m);
    const ac = (lag: number) => {
      let a = 0;
      for (let f = lag; f < frames; f++) a += centred[f]! * centred[f - lag]!;
      return a / (frames - lag);
    };
    const minLag = Math.max(2, Math.floor((60 / 180) * fps));
    const maxLag = Math.ceil((60 / 60) * fps);
    let bestLag = minLag;
    let best = -Infinity;
    let sum = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const v = ac(lag);
      sum += Math.max(0, v);
      if (v > best) {
        best = v;
        bestLag = lag;
      }
    }
    const bpmOf = (lag: number) => (60 * fps) / lag;
    const inSweet = (lag: number) => bpmOf(lag) >= 85 && bpmOf(lag) <= 150;
    for (const k of [0.5, 2, 1 / 3, 3]) {
      if (inSweet(bestLag)) break;
      const lag = Math.round(bestLag * k);
      if (lag >= minLag && lag <= maxLag && inSweet(lag) && ac(lag) >= 0.5 * best) bestLag = lag;
    }
    // Refine the lag to sub-frame precision from the beat spacing over the whole track.
    const mean = sum / (maxLag - minLag + 1);
    const confidence = Math.max(0, Math.min(1, mean > 0 ? (ac(bestLag) / mean - 1) / 3 : 0));

    // Period (fractional frames) and phase: the grid that collects the most onset energy.
    const at = (x: number) => {
      const i = Math.round(x);
      return (onset[i] ?? 0) + 0.5 * (onset[i - 1] ?? 0) + 0.5 * (onset[i + 1] ?? 0);
    };
    let period = bestLag;
    let phase = 0;
    let bestScore = -Infinity;
    for (let p = bestLag - 1; p <= bestLag + 1; p += 0.02) {
      for (let ph = 0; ph < p; ph += 0.5) {
        let sc = 0;
        for (let x = ph; x < frames; x += p) sc += at(x);
        if (sc > bestScore) {
          bestScore = sc;
          period = p;
          phase = ph;
        }
      }
    }
    const beats: number[] = [];
    for (let x = phase; x < frames; x += period) beats.push(Math.round((x / fps) * 1000) / 1000);
    return { bpm: Math.round((60 * fps) / period), beats, durationSec: Math.round(durationSec * 100) / 100, confidence: Math.round(confidence * 100) / 100 };
  } finally {
    await fsp.rm(raw, { force: true });
  }
}

