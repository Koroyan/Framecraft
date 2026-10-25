import fsp from 'node:fs/promises';
import path from 'node:path';
import type { MotionTrack } from '@framecraft/shared';
import { ffmpeg, probe, withWorkdir } from './ffmpeg';

/*
 * Box tracker (classic computer vision, no model download): normalised cross-correlation template
 * matching on downscaled greyscale frames, coarse-to-fine search around the last position, run
 * forward and backward from the frame where the box was drawn. The template adapts slowly when the
 * match is confident; low-confidence frames hold position (the user corrects them with keyframes).
 */

export type TrackBox = { x: number; y: number; w: number; h: number };
export type TrackOptions = { atSec: number; startSec: number; endSec: number; box: TrackBox; fps?: number; width?: number; smoothing?: number };

type Frame = Float32Array;

function ncc(frame: Frame, W: number, tpl: Float32Array, tw: number, th: number, tMean: number, tStd: number, ox: number, oy: number, step: number) {
  let sum = 0, sum2 = 0, cross = 0, cnt = 0;
  for (let y = 0; y < th; y += step) {
    const row = (oy + y) * W + ox;
    const trow = y * tw;
    for (let x = 0; x < tw; x += step) {
      const v = frame[row + x]!;
      const t = tpl[trow + x]!;
      sum += v;
      sum2 += v * v;
      cross += v * t;
      cnt++;
    }
  }
  const mean = sum / cnt;
  const std = Math.sqrt(Math.max(1e-6, sum2 / cnt - mean * mean));
  return (cross / cnt - mean * tMean) / (std * tStd);
}

function stats(tpl: Float32Array) {
  let s = 0, s2 = 0;
  for (const v of tpl) {
    s += v;
    s2 += v * v;
  }
  const m = s / tpl.length;
  return { mean: m, std: Math.sqrt(Math.max(1e-6, s2 / tpl.length - m * m)) };
}

function cut(frame: Frame, W: number, x: number, y: number, w: number, h: number) {
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) out.set(frame.subarray((y + j) * W + x, (y + j) * W + x + w), j * w);
  return out;
}

/** Track the box through the source video; returns offsets (fractions of the frame) per sampled frame. */
export async function trackBox(file: string, o: TrackOptions): Promise<MotionTrack & { lost: number }> {
  const meta = await probe(file);
  const fps = o.fps ?? 15;
  const W = o.width ?? 320;
  const H = Math.max(2, Math.round(((meta.height ?? 720) / (meta.width ?? 1280)) * W / 2) * 2);
  const start = Math.max(0, Math.min(o.startSec, o.atSec));
  const end = Math.min(meta.durationSec || o.endSec, Math.max(o.endSec, o.atSec + 0.05));
  const frames: Frame[] = await withWorkdir(async (dir) => {
    const raw = path.join(dir, 'gray.raw');
    await ffmpeg(['-ss', String(start), '-t', String(Math.max(0.1, end - start)), '-i', file, '-vf', `fps=${fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', raw], { timeoutMs: 10 * 60_000 });
    const buf = await fsp.readFile(raw);
    const size = W * H;
    const out: Frame[] = [];
    for (let i = 0; i + size <= buf.length; i += size) {
      const f = new Float32Array(size);
      for (let k = 0; k < size; k++) f[k] = buf[i + k]! / 255;
      out.push(f);
    }
    return out;
  });
  if (!frames.length) throw new Error('No frames to track in this range');
  const ref = Math.min(frames.length - 1, Math.max(0, Math.round((o.atSec - start) * fps)));
  const bw = Math.max(8, Math.min(W - 2, Math.round(o.box.w * W)));
  const bh = Math.max(8, Math.min(H - 2, Math.round(o.box.h * H)));
  const bx = Math.min(W - bw - 1, Math.max(0, Math.round(o.box.x * W)));
  const by = Math.min(H - bh - 1, Math.max(0, Math.round(o.box.y * H)));
  const radius = Math.max(10, Math.round(Math.max(bw, bh) * 0.6));

  const pos = new Array<{ x: number; y: number; conf: number }>(frames.length);
  pos[ref] = { x: bx, y: by, conf: 1 };
  const run = (dir: 1 | -1) => {
    const tpl = cut(frames[ref]!, W, bx, by, bw, bh);
    let st = stats(tpl);
    let px = bx, py = by;
    for (let i = ref + dir; i >= 0 && i < frames.length; i += dir) {
      const f = frames[i]!;
      let best = -2, bxp = px, byp = py;
      // Coarse search (step 3), then refine around the best (step 1).
      for (let dy = -radius; dy <= radius; dy += 3)
        for (let dx = -radius; dx <= radius; dx += 3) {
          const x = px + dx, y = py + dy;
          if (x < 0 || y < 0 || x + bw >= W || y + bh >= H) continue;
          const s = ncc(f, W, tpl, bw, bh, st.mean, st.std, x, y, 2);
          if (s > best) [best, bxp, byp] = [s, x, y];
        }
      const cx = bxp, cy = byp;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x + bw >= W || y + bh >= H) continue;
          const s = ncc(f, W, tpl, bw, bh, st.mean, st.std, x, y, 1);
          if (s > best) [best, bxp, byp] = [s, x, y];
        }
      const conf = Math.max(0, Math.min(1, (best + 1) / 2 > 0.5 ? best : 0));
      if (conf >= 0.45) {
        px = bxp;
        py = byp;
        // Adapt to slow appearance changes only on confident matches.
        if (conf > 0.8) {
          const cur = cut(f, W, px, py, bw, bh);
          for (let k = 0; k < tpl.length; k++) tpl[k] = tpl[k]! * 0.9 + cur[k]! * 0.1;
          st = stats(tpl);
        }
      }
      pos[i] = { x: px, y: py, conf };
    }
  };
  run(1);
  run(-1);
  // Smooth the path (centred moving average), keep confidence.
  const k = Math.round((o.smoothing ?? 0.3) * 4);
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const avg = (arr: number[], i: number) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(arr.length - 1, i + k); j++) {
      s += arr[j]!;
      c++;
    }
    return s / c;
  };
  const points = pos.map((p, i) => ({ t: Math.round((start + i / fps) * 1000) / 1000, dx: Math.round(((avg(xs, i) - bx) / W) * 10000) / 10000, dy: Math.round(((avg(ys, i) - by) / H) * 10000) / 10000, conf: Math.round(p.conf * 100) / 100 }));
  return { points, smoothing: o.smoothing ?? 0.3, lost: points.filter((p) => (p.conf ?? 1) < 0.45).length };
}
