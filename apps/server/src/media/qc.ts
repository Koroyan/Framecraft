import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sceneCuts } from '../ads/analyze';
import { extractFrame, ffmpeg, ffmpegPath, probe, run } from './ffmpeg';

/*
 * Post-render measurements of the actual exported video (deterministic, no AI): shot boundaries
 * and lengths, near-duplicate shots, black and frozen stretches, flicker/jumps inside a shot,
 * loudness, silence and clipping. These are facts about the file, used for the verified score.
 */

export type RenderMeasurements = {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  shots: { startSec: number; endSec: number }[];
  /** Pairs of shots that look almost the same (by perceptual hash). */
  duplicateShots: [number, number][];
  black: { startSec: number; endSec: number }[];
  frozen: { startSec: number; endSec: number }[];
  /** Abrupt picture jumps that are not at a cut (glitches, morphing, flicker). */
  jumps: number[];
  audio: { meanDb: number; maxDb: number; silent: { startSec: number; endSec: number }[] } | null;
  /** Mid-frame of every shot (JPEG paths in `dir`), for visual checks. */
  frames: { shot: number; atSec: number; file: string }[];
  dir: string;
};

const num = (m: RegExpMatchArray | null) => (m ? Number(m[1]) : NaN);

async function aHash(img: string): Promise<bigint> {
  const raw = `${img}.ah`;
  await ffmpeg(['-i', img, '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', raw]);
  const b = await fsp.readFile(raw);
  await fsp.rm(raw, { force: true });
  const avg = b.reduce((s, v) => s + v, 0) / b.length;
  let h = 0n;
  for (let i = 0; i < 64; i++) if (b[i]! > avg) h |= 1n << BigInt(i);
  return h;
}
const hamming = (a: bigint, b: bigint) => {
  let x = a ^ b;
  let c = 0;
  while (x) {
    c += Number(x & 1n);
    x >>= 1n;
  }
  return c;
};

/** Greyscale frame-to-frame change at 8 fps (fraction 0–1). */
async function frameDiffs(file: string, durationSec: number): Promise<{ t: number; diff: number }[]> {
  const W = 96;
  const H = 170;
  const raw = path.join(os.tmpdir(), `fc-qc-${process.pid}-${Date.now()}.raw`);
  try {
    await ffmpeg(['-i', file, '-vf', `fps=8,scale=${W}:${H},format=gray`, '-t', String(Math.min(durationSec, 300)), '-f', 'rawvideo', '-pix_fmt', 'gray', raw], { timeoutMs: 10 * 60_000 });
    const buf = await fsp.readFile(raw);
    const size = W * H;
    const out: { t: number; diff: number }[] = [];
    for (let i = size, k = 1; i + size <= buf.length; i += size, k++) {
      let d = 0;
      for (let j = 0; j < size; j += 2) d += Math.abs(buf[i + j]! - buf[i - size + j]!);
      out.push({ t: k / 8, diff: d / (size / 2) / 255 });
    }
    return out;
  } finally {
    await fsp.rm(raw, { force: true });
  }
}

export async function measureRender(file: string): Promise<RenderMeasurements> {
  const meta = await probe(file);
  const dur = meta.durationSec;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fc-qc-'));
  const cuts = (await sceneCuts(file, 0.3)).filter((c) => c > 0.2 && c < dur - 0.2);
  const bounds = [0, ...cuts, dur];
  const shots = bounds.slice(1).map((b, i) => ({ startSec: Math.round(bounds[i]! * 100) / 100, endSec: Math.round(b * 100) / 100 })).filter((s) => s.endSec - s.startSec > 0.15);

  // Mid-frame per shot + perceptual hash.
  const frames: RenderMeasurements['frames'] = [];
  const hashes: bigint[] = [];
  for (const [i, s] of shots.entries()) {
    const at = (s.startSec + s.endSec) / 2;
    const f = path.join(dir, `shot-${i + 1}.jpg`);
    await extractFrame(file, f, at);
    await ffmpeg(['-i', f, '-vf', 'scale=512:-2', '-q:v', '4', `${f}.s.jpg`]);
    await fsp.rename(`${f}.s.jpg`, f);
    frames.push({ shot: i, atSec: Math.round(at * 100) / 100, file: f });
    hashes.push(await aHash(f));
  }
  const duplicateShots: [number, number][] = [];
  for (let i = 0; i < hashes.length; i++) for (let j = i + 1; j < hashes.length; j++) if (hamming(hashes[i]!, hashes[j]!) <= 6) duplicateShots.push([i, j]);

  const { stderr: vlog } = await run(ffmpegPath(), ['-hide_banner', '-i', file, '-vf', 'blackdetect=d=0.4:pix_th=0.08,freezedetect=n=0.002:d=1.5', '-an', '-f', 'null', '-'], { timeoutMs: 10 * 60_000 });
  const black = [...vlog.matchAll(/black_start:([0-9.]+) black_end:([0-9.]+)/g)].map((m) => ({ startSec: Number(m[1]), endSec: Number(m[2]) }));
  const fs = [...vlog.matchAll(/freeze_start: ([0-9.]+)/g)].map((m) => Number(m[1]));
  const fe = [...vlog.matchAll(/freeze_end: ([0-9.]+)/g)].map((m) => Number(m[1]));
  const frozen = fs.map((s, i) => ({ startSec: s, endSec: fe[i] ?? dur }));

  // Jumps: a big change between consecutive frames away from any cut (±0.3 s).
  const diffs = await frameDiffs(file, dur);
  const jumps = diffs.filter((d) => d.diff > 0.16 && !cuts.some((c) => Math.abs(c - d.t) < 0.3) && d.t > 0.3).map((d) => Math.round(d.t * 100) / 100);

  let audio: RenderMeasurements['audio'] = null;
  if (meta.hasAudio) {
    const { stderr: alog } = await run(ffmpegPath(), ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect,silencedetect=n=-50dB:d=1.2', '-f', 'null', '-'], { timeoutMs: 5 * 60_000 });
    const ss = [...alog.matchAll(/silence_start: ([0-9.]+)/g)].map((m) => Number(m[1]));
    const se = [...alog.matchAll(/silence_end: ([0-9.]+)/g)].map((m) => Number(m[1]));
    audio = { meanDb: num(alog.match(/mean_volume:\s*(-?[0-9.]+)/)), maxDb: num(alog.match(/max_volume:\s*(-?[0-9.]+)/)), silent: ss.map((s, i) => ({ startSec: s, endSec: se[i] ?? dur })) };
  }
  return { durationSec: Math.round(dur * 100) / 100, width: meta.width ?? 0, height: meta.height ?? 0, hasAudio: meta.hasAudio, shots, duplicateShots, black, frozen, jumps, audio, frames, dir };
}

/** Frames at given times (e.g. the middle of every timeline clip) for visual checks. */
export async function framesAt(file: string, times: number[], dir: string): Promise<RenderMeasurements['frames']> {
  const out: RenderMeasurements['frames'] = [];
  for (const [i, at] of times.entries()) {
    const f = path.join(dir, `clip-${i + 1}.jpg`);
    await extractFrame(file, f, at);
    await ffmpeg(['-i', f, '-vf', 'scale=512:-2', '-q:v', '4', `${f}.s.jpg`]);
    await fsp.rename(`${f}.s.jpg`, f);
    out.push({ shot: i, atSec: Math.round(at * 100) / 100, file: f });
  }
  return out;
}

/** Rough colour signature (12-bin hue histogram of the central area), for a cheap product-colour check. */
export async function hueSignature(img: string): Promise<number[]> {
  const raw = `${img}.rgb`;
  await ffmpeg(['-i', img, '-vf', 'crop=iw*0.6:ih*0.6,scale=48:48', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const b = await fsp.readFile(raw);
  await fsp.rm(raw, { force: true });
  const bins = new Array(12).fill(0) as number[];
  let n = 0;
  for (let i = 0; i + 2 < b.length; i += 3) {
    const r = b[i]! / 255;
    const g = b[i + 1]! / 255;
    const bl = b[i + 2]! / 255;
    const max = Math.max(r, g, bl);
    const min = Math.min(r, g, bl);
    if (max - min < 0.12 || max < 0.15) continue; // greys and darkness carry no hue
    let h = max === r ? ((g - bl) / (max - min)) % 6 : max === g ? (bl - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
    if (h < 0) h += 6;
    bins[Math.min(11, Math.floor(h * 2))]! += 1;
    n++;
  }
  return n ? bins.map((v) => v / n) : bins;
}

/** 0 = same colours, 1 = completely different (half the L1 distance of two histograms). */
export const hueDistance = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) / 2;
