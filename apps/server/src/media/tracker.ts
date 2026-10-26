import fsp from 'node:fs/promises';
import path from 'node:path';
import type { MotionTrack } from '@framecraft/shared';
import { ffmpeg, probe, withWorkdir } from './ffmpeg';

/*
 * Box tracker (classic computer vision, no model download): normalised cross-correlation of the
 * selection's template on downscaled greyscale frames — coarse-to-fine search around the last
 * centre, then a size search (the subject may come closer or move away) — run forward and backward
 * from the frame where the selection was made. The template adapts slowly on confident matches;
 * uncertain frames hold their place and are reported, so the editor can show them and the user can
 * correct one frame and re-track from there.
 */

export type TrackBox = { x: number; y: number; w: number; h: number };
export type TrackOptions = { atSec: number; startSec: number; endSec: number; box: TrackBox; fps?: number; width?: number; smoothing?: number; /** Search sizes too (default on). */ scale?: boolean };
export type TrackResult = MotionTrack & {
  /** Number of uncertain samples. */
  lost: number;
  /** The span around the selection frame where the object was reliably found ("until it disappears"). */
  reliable: { start: number; end: number };
};

type Frame = Float32Array;
const LOST = 0.45;

/** NCC of the template against the frame sampled around centre (cx, cy) at size s. */
function ncc(frame: Frame, W: number, H: number, tpl: Float32Array, tw: number, th: number, tMean: number, tStd: number, cx: number, cy: number, s: number, step: number) {
  let sum = 0, sum2 = 0, cross = 0, cnt = 0, miss = 0;
  const hw = tw / 2, hh = th / 2;
  for (let y = 0; y < th; y += step) {
    const fy = Math.round(cy + (y - hh) * s);
    const trow = y * tw;
    for (let x = 0; x < tw; x += step) {
      const fx = Math.round(cx + (x - hw) * s);
      if (fx < 0 || fy < 0 || fx >= W || fy >= H) {
        miss++;
        continue;
      }
      const v = frame[fy * W + fx]!;
      const t = tpl[trow + x]!;
      sum += v;
      sum2 += v * v;
      cross += v * t;
      cnt++;
    }
  }
  if (cnt < 16 || miss > cnt) return -1;
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

/** Resample the frame around (cx, cy) at size s into a tw×th template. */
function cut(frame: Frame, W: number, H: number, cx: number, cy: number, tw: number, th: number, s: number) {
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    const fy = Math.min(H - 1, Math.max(0, Math.round(cy + (y - th / 2) * s)));
    for (let x = 0; x < tw; x++) out[y * tw + x] = frame[fy * W + Math.min(W - 1, Math.max(0, Math.round(cx + (x - tw / 2) * s)))]!;
  }
  return out;
}

/** Track the box through the source video; offsets of its centre (fractions of the frame) and size per sampled frame. */
export async function trackBox(file: string, o: TrackOptions): Promise<TrackResult> {
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
  // The template keeps a margin of context around the selection: plain-coloured objects have no
  // texture of their own, their outline against the background is what can be followed.
  const tw = Math.max(10, Math.min(W - 2, Math.round(o.box.w * W * 1.4)));
  const th = Math.max(10, Math.min(H - 2, Math.round(o.box.h * H * 1.4)));
  const cx0 = Math.min(W - 1, Math.max(0, (o.box.x + o.box.w / 2) * W));
  const cy0 = Math.min(H - 1, Math.max(0, (o.box.y + o.box.h / 2) * H));
  const radius = Math.max(10, Math.round(Math.max(tw, th) * 0.6));
  const scales = o.scale === false ? [1] : [0.97, 1, 1.03];

  const pos = new Array<{ x: number; y: number; s: number; conf: number }>(frames.length);
  pos[ref] = { x: cx0, y: cy0, s: 1, conf: 1 };
  const run = (dir: 1 | -1) => {
    const tpl = cut(frames[ref]!, W, H, cx0, cy0, tw, th, 1);
    let st = stats(tpl);
    let px = cx0, py = cy0, ps = 1;
    for (let i = ref + dir; i >= 0 && i < frames.length; i += dir) {
      const f = frames[i]!;
      let best = -2, bx = px, by = py, bs = ps;
      const r = Math.round(radius * Math.max(1, ps));
      // Coarse search at the current size, then refine position and size.
      for (let dy = -r; dy <= r; dy += 3)
        for (let dx = -r; dx <= r; dx += 3) {
          const sc = ncc(f, W, H, tpl, tw, th, st.mean, st.std, px + dx, py + dy, ps, 2);
          if (sc > best) [best, bx, by] = [sc, px + dx, py + dy];
        }
      const [cx, cy] = [bx, by];
      for (const k of scales)
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++) {
            const s = Math.min(6, Math.max(0.2, ps * k));
            const sc = ncc(f, W, H, tpl, tw, th, st.mean, st.std, cx + dx, cy + dy, s, 1);
            if (sc > best + (k === 1 ? 0 : 0.0015)) [best, bx, by, bs] = [sc, cx + dx, cy + dy, s];
          }
      const conf = Math.max(0, Math.min(1, (best + 1) / 2 > 0.5 ? best : 0));
      if (conf >= LOST) {
        px = bx;
        py = by;
        ps = bs;
        if (conf > 0.8) {
          const cur = cut(f, W, H, px, py, tw, th, ps);
          for (let k = 0; k < tpl.length; k++) tpl[k] = tpl[k]! * 0.9 + cur[k]! * 0.1;
          st = stats(tpl);
        }
      }
      pos[i] = { x: px, y: py, s: ps, conf };
    }
  };
  run(1);
  run(-1);
  // Smooth the path (centred moving average), keep confidence.
  const k = Math.round((o.smoothing ?? 0.3) * 4);
  const avg = (arr: number[], i: number) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(arr.length - 1, i + k); j++) {
      s += arr[j]!;
      c++;
    }
    return s / c;
  };
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const ss = pos.map((p) => p.s);
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const points = pos.map((p, i) => ({ t: Math.round((start + i / fps) * 1000) / 1000, dx: r4((avg(xs, i) - cx0) / W), dy: r4((avg(ys, i) - cy0) / H), s: r4(avg(ss, i)), conf: Math.round(p.conf * 100) / 100 }));
  // Reliable span: from the selection frame outwards until 4 uncertain samples in a row.
  const reach = (dir: 1 | -1) => {
    let i = ref, bad = 0, last = ref;
    for (let j = ref + dir; j >= 0 && j < points.length; j += dir) {
      if ((points[j]!.conf ?? 1) < LOST) {
        if (++bad >= 4) break;
      } else {
        bad = 0;
        last = j;
      }
      i = j;
    }
    void i;
    return points[last]!.t;
  };
  return { points, smoothing: o.smoothing ?? 0.3, lost: points.filter((p) => (p.conf ?? 1) < LOST).length, reliable: { start: reach(-1), end: reach(1) } };
}
