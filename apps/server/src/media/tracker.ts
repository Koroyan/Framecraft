import fsp from 'node:fs/promises';
import path from 'node:path';
import type { MotionTrack } from '@framecraft/shared';
import { ffmpeg, probe, withWorkdir } from './ffmpeg';

/*
 * Object tracker (classic computer vision, no model download).
 *
 * Primary: Median Flow — a grid of points on the selected object (inside its outline, not its box,
 * so a background moving at another speed does not drag it) is followed frame to frame with
 * pyramidal Lucas–Kanade optical flow, checked by tracking back again (forward–backward error);
 * the reliable half gives the motion (median displacement) and the size change (median ratio of
 * point distances). This follows hand-held camera moves, approaching subjects and zooms.
 * Fallback: when the flow fails (blur, occlusion), a correlation search of the selection's
 * appearance around the last position tries to find it again; otherwise the frame holds its place
 * and is reported as uncertain, so the editor can show it and the user can correct it.
 */

export type TrackBox = { x: number; y: number; w: number; h: number };
export type TrackOptions = {
  atSec: number;
  startSec: number;
  endSec: number;
  box: TrackBox;
  /** The selection's outline (normalised); points are seeded inside it. Defaults to the box. */
  region?: [number, number][];
  fps?: number;
  width?: number;
  smoothing?: number;
  /** Follow size changes (default on). */
  scale?: boolean;
};
export type TrackResult = MotionTrack & {
  /** Number of uncertain samples. */
  lost: number;
  /** The span around the selection frame where the object was reliably found ("until it disappears"). */
  reliable: { start: number; end: number };
};

const LOST = 0.45;
type Gray = { w: number; h: number; d: Float32Array };
type Level = Gray & { gx: Float32Array; gy: Float32Array };

// ------------------------------------------------------------------ image pyramid

function downsample(g: Gray): Gray {
  const w = Math.max(1, g.w >> 1);
  const h = Math.max(1, g.h >> 1);
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = 2 * y * g.w + 2 * x;
      const r = Math.min(g.w - 1, 2 * x + 1) - 2 * x;
      const b = Math.min(g.h - 1, 2 * y + 1) - 2 * y;
      d[y * w + x] = (g.d[i]! + g.d[i + r]! + g.d[i + b * g.w]! + g.d[i + b * g.w + r]!) / 4;
    }
  return { w, h, d };
}

function withGradients(g: Gray): Level {
  const gx = new Float32Array(g.w * g.h);
  const gy = new Float32Array(g.w * g.h);
  for (let y = 1; y < g.h - 1; y++)
    for (let x = 1; x < g.w - 1; x++) {
      const i = y * g.w + x;
      // Scharr: better rotational symmetry than Sobel for optical flow.
      gx[i] = (3 * (g.d[i - g.w + 1]! - g.d[i - g.w - 1]!) + 10 * (g.d[i + 1]! - g.d[i - 1]!) + 3 * (g.d[i + g.w + 1]! - g.d[i + g.w - 1]!)) / 32;
      gy[i] = (3 * (g.d[i + g.w - 1]! - g.d[i - g.w - 1]!) + 10 * (g.d[i + g.w]! - g.d[i - g.w]!) + 3 * (g.d[i + g.w + 1]! - g.d[i - g.w + 1]!)) / 32;
    }
  return { ...g, gx, gy };
}

function pyramid(g: Gray, levels: number): Level[] {
  const out: Level[] = [withGradients(g)];
  let cur = g;
  for (let l = 1; l < levels; l++) {
    cur = downsample(cur);
    out.push(withGradients(cur));
  }
  return out;
}

function bilinear(arr: Float32Array, w: number, h: number, x: number, y: number): number {
  const xc = Math.min(w - 1.001, Math.max(0, x));
  const yc = Math.min(h - 1.001, Math.max(0, y));
  const x0 = xc | 0;
  const y0 = yc | 0;
  const ax = xc - x0;
  const ay = yc - y0;
  const i = y0 * w + x0;
  return (arr[i]! * (1 - ax) + arr[i + 1]! * ax) * (1 - ay) + (arr[i + w]! * (1 - ax) + arr[i + w + 1]! * ax) * ay;
}

// ------------------------------------------------------------------ Lucas–Kanade

const HALF = 7; // 15×15 window
const ITERS = 12;

/** Pyramidal Lucas–Kanade (Bouguet) for one point; null when the window has no texture or diverges. */
function lk(prev: Level[], next: Level[], x: number, y: number): [number, number] | null {
  let gx = 0;
  let gy = 0;
  for (let L = prev.length - 1; L >= 0; L--) {
    const P = prev[L]!;
    const N = next[L]!;
    const s = 1 / (1 << L);
    const px = x * s;
    const py = y * s;
    let a = 0, b = 0, c = 0;
    for (let wy = -HALF; wy <= HALF; wy++)
      for (let wx = -HALF; wx <= HALF; wx++) {
        const ix = bilinear(P.gx, P.w, P.h, px + wx, py + wy);
        const iy = bilinear(P.gy, P.w, P.h, px + wx, py + wy);
        a += ix * ix;
        b += ix * iy;
        c += iy * iy;
      }
    const det = a * c - b * b;
    // Shi–Tomasi: texture in both directions. A straight edge can only measure motion across it
    // (aperture problem) and would bias the median; a flat patch measures nothing.
    const n = (2 * HALF + 1) ** 2;
    const lMin = (a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b)) / 2;
    const lMax = (a + c + Math.sqrt((a - c) * (a - c) + 4 * b * b)) / 2;
    if (L === 0 && (lMin / n < 1e-4 || lMin < 0.02 * lMax)) return null;
    if (det < 1e-7 * n) return null;
    let vx = 0;
    let vy = 0;
    for (let k = 0; k < ITERS; k++) {
      let bx = 0, by = 0;
      for (let wy = -HALF; wy <= HALF; wy++)
        for (let wx = -HALF; wx <= HALF; wx++) {
          const I = bilinear(P.d, P.w, P.h, px + wx, py + wy);
          const J = bilinear(N.d, N.w, N.h, px + wx + gx + vx, py + wy + gy + vy);
          const diff = I - J;
          bx += diff * bilinear(P.gx, P.w, P.h, px + wx, py + wy);
          by += diff * bilinear(P.gy, P.w, P.h, px + wx, py + wy);
        }
      const ex = (c * bx - b * by) / det;
      const ey = (a * by - b * bx) / det;
      vx += ex;
      vy += ey;
      if (ex * ex + ey * ey < 1e-4) break;
    }
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;
    if (L > 0) {
      gx = 2 * (gx + vx);
      gy = 2 * (gy + vy);
    } else {
      gx += vx;
      gy += vy;
    }
  }
  const nx = x + gx;
  const ny = y + gy;
  const N0 = next[0]!;
  if (nx < 0 || ny < 0 || nx >= N0.w || ny >= N0.h) return null;
  return [nx, ny];
}

const median = (v: number[]) => {
  if (!v.length) return NaN;
  const s = [...v].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function inside(x: number, y: number, poly: [number, number][]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** About `want` grid points inside the (slightly grown) outline — its edges carry the texture. */
function seedPoints(poly: [number, number][], W: number, H: number, want = 110): [number, number][] {
  let x0 = W, y0 = H, x1 = 0, y1 = 0, cx = 0, cy = 0;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
    cx += x / poly.length;
    cy += y / poly.length;
  }
  const grown = poly.map(([x, y]) => [cx + (x - cx) * 1.12, cy + (y - cy) * 1.12] as [number, number]);
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  const step = Math.max(2, Math.sqrt(area / want));
  const out: [number, number][] = [];
  for (let y = y0 + step / 2; y < y1; y += step)
    for (let x = x0 + step / 2; x < x1; x += step) if (x > HALF && y > HALF && x < W - HALF && y < H - HALF && inside(x, y, grown)) out.push([x, y]);
  return out;
}

/** One Median Flow step: motion (dx, dy), size change and a confidence, or null when it failed. */
function medianFlow(prev: Level[], next: Level[], pts: [number, number][], scaleOn: boolean) {
  const kept: { p: [number, number]; q: [number, number]; fb: number }[] = [];
  for (const p of pts) {
    const q = lk(prev, next, p[0], p[1]);
    if (!q) continue;
    const back = lk(next, prev, q[0], q[1]);
    if (!back) continue;
    kept.push({ p, q, fb: Math.hypot(back[0] - p[0], back[1] - p[1]) });
  }
  if (kept.length < 6) return null;
  const medFb = median(kept.map((k) => k.fb));
  const good = kept.filter((k) => k.fb <= Math.max(medFb, 0.25));
  if (good.length < 5) return null;
  const dx = median(good.map((k) => k.q[0] - k.p[0]));
  const dy = median(good.map((k) => k.q[1] - k.p[1]));
  let scale = 1;
  if (scaleOn) {
    const ratios: number[] = [];
    for (let i = 0; i < good.length && ratios.length < 400; i++)
      for (let j = i + 1; j < good.length && ratios.length < 400; j += Math.max(1, (good.length / 12) | 0)) {
        const d0 = Math.hypot(good[i]!.p[0] - good[j]!.p[0], good[i]!.p[1] - good[j]!.p[1]);
        if (d0 < 4) continue;
        ratios.push(Math.hypot(good[i]!.q[0] - good[j]!.q[0], good[i]!.q[1] - good[j]!.q[1]) / d0);
      }
    if (ratios.length >= 5) scale = Math.min(1.15, Math.max(0.87, median(ratios)));
  }
  // Confidence: small forward–backward error and most points agreeing. A turning object (its parts
  // appear and disappear) raises the error; up to a point the median motion is still right.
  const agree = good.length / Math.max(1, pts.length);
  const conf = Math.max(0, Math.min(1, (1 - medFb / 9) * Math.min(1, agree * 2.2)));
  if (medFb > 9) return null;
  return { dx, dy, scale, conf };
}

// ------------------------------------------------------------------ correlation (re-acquisition)

function ncc(frame: Gray, tpl: Float32Array, tw: number, th: number, tMean: number, tStd: number, cx: number, cy: number, s: number, step: number) {
  let sum = 0, sum2 = 0, cross = 0, cnt = 0, miss = 0;
  for (let y = 0; y < th; y += step) {
    const fy = Math.round(cy + (y - th / 2) * s);
    for (let x = 0; x < tw; x += step) {
      const fx = Math.round(cx + (x - tw / 2) * s);
      if (fx < 0 || fy < 0 || fx >= frame.w || fy >= frame.h) {
        miss++;
        continue;
      }
      const v = frame.d[fy * frame.w + fx]!;
      const t = tpl[y * tw + x]!;
      sum += v;
      sum2 += v * v;
      cross += v * t;
      cnt++;
    }
  }
  if (cnt < 16 || miss > cnt) return -1;
  const mean = sum / cnt;
  const std = Math.sqrt(Math.max(1e-6, sum2 / cnt - mean * mean));
  // A flat patch (plain wall, sky) cannot match a template with an edge in it.
  if (std < 0.012 || tStd < 0.012) return -1;
  return Math.max(-1, Math.min(1, (cross / cnt - mean * tMean) / (std * tStd)));
}

function cut(frame: Gray, cx: number, cy: number, tw: number, th: number, s: number) {
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    const fy = Math.min(frame.h - 1, Math.max(0, Math.round(cy + (y - th / 2) * s)));
    for (let x = 0; x < tw; x++) out[y * tw + x] = frame.d[fy * frame.w + Math.min(frame.w - 1, Math.max(0, Math.round(cx + (x - tw / 2) * s)))]!;
  }
  return out;
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

/** Look for the selection's appearance around (cx, cy) near size s; best centre, size and score. */
function reacquire(frame: Gray, tpl: Float32Array, tw: number, th: number, st: { mean: number; std: number }, cx: number, cy: number, s: number, scaleOn: boolean) {
  const r = Math.round(Math.max(tw, th) * s * 0.4); // nearby only: jumping to a look-alike is worse than holding
  let best = -2, bx = cx, by = cy, bs = s;
  for (let dy = -r; dy <= r; dy += 3)
    for (let dx = -r; dx <= r; dx += 3) {
      const sc = ncc(frame, tpl, tw, th, st.mean, st.std, cx + dx, cy + dy, s, 2);
      if (sc > best) [best, bx, by] = [sc, cx + dx, cy + dy];
    }
  const [c0x, c0y] = [bx, by];
  // Refine position and size together (the subject may come closer or move away).
  for (const k of scaleOn ? [0.96, 1, 1.04] : [1])
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const ss = Math.min(6, Math.max(0.2, s * k));
        const sc = ncc(frame, tpl, tw, th, st.mean, st.std, c0x + dx, c0y + dy, ss, 1);
        if (sc > best + (k === 1 ? 0 : 0.0015)) [best, bx, by, bs] = [sc, c0x + dx, c0y + dy, ss];
      }
  return { x: bx, y: by, s: bs, score: best };
}

// ------------------------------------------------------------------ tracking

/** Track the selection through the source video; offsets of its centre (fractions of the frame) and size per sampled frame. */
export async function trackBox(file: string, o: TrackOptions): Promise<TrackResult> {
  const meta = await probe(file);
  const fps = o.fps ?? 15;
  const W = o.width ?? 400;
  const H = Math.max(2, Math.round(((meta.height ?? 720) / (meta.width ?? 1280)) * W / 2) * 2);
  const start = Math.max(0, Math.min(o.startSec, o.atSec));
  const end = Math.min(meta.durationSec || o.endSec, Math.max(o.endSec, o.atSec + 0.05));
  const frames: Gray[] = await withWorkdir(async (dir) => {
    const raw = path.join(dir, 'gray.raw');
    await ffmpeg(['-ss', String(start), '-t', String(Math.max(0.1, end - start)), '-i', file, '-vf', `fps=${fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', raw], { timeoutMs: 10 * 60_000 });
    const buf = await fsp.readFile(raw);
    const size = W * H;
    const out: Gray[] = [];
    for (let i = 0; i + size <= buf.length; i += size) {
      const d = new Float32Array(size);
      for (let k = 0; k < size; k++) d[k] = buf[i + k]! / 255;
      out.push({ w: W, h: H, d });
    }
    return out;
  });
  if (!frames.length) throw new Error('No frames to track in this range');
  const ref = Math.min(frames.length - 1, Math.max(0, Math.round((o.atSec - start) * fps)));
  const c0 = { x: Math.min(W - 1, Math.max(0, (o.box.x + o.box.w / 2) * W)), y: Math.min(H - 1, Math.max(0, (o.box.y + o.box.h / 2) * H)) };
  const region: [number, number][] =
    o.region && o.region.length >= 3
      ? o.region.map(([x, y]) => [x * W, y * H])
      : [
          [o.box.x * W, o.box.y * H],
          [(o.box.x + o.box.w) * W, o.box.y * H],
          [(o.box.x + o.box.w) * W, (o.box.y + o.box.h) * H],
          [o.box.x * W, (o.box.y + o.box.h) * H],
        ];
  const scaleOn = o.scale !== false;
  const levels = new Map<number, Level[]>();
  const pyr = (i: number) => {
    let p = levels.get(i);
    if (!p) {
      p = pyramid(frames[i]!, 3);
      levels.set(i, p);
    }
    return p;
  };
  // Appearance for re-acquisition: the selection with a margin of context, as at the selection frame.
  const tw = Math.max(10, Math.min(W - 2, Math.round(o.box.w * W * 1.3)));
  const th = Math.max(10, Math.min(H - 2, Math.round(o.box.h * H * 1.3)));
  const tpl = cut(frames[ref]!, c0.x, c0.y, tw, th, 1);
  const tst = stats(tpl);

  type State = { x: number; y: number; s: number; conf: number };
  const pos = new Array<State>(frames.length);
  pos[ref] = { x: c0.x, y: c0.y, s: 1, conf: 1 };
  const run = (dir: 1 | -1) => {
    let st = pos[ref]!;
    for (let i = ref + dir; i >= 0 && i < frames.length; i += dir) {
      // The outline where the object is now; seed points inside it.
      const poly = region.map(([x, y]) => [st.x + (x - c0.x) * st.s, st.y + (y - c0.y) * st.s] as [number, number]);
      const pts = seedPoints(poly, W, H);
      // Physically plausible: between two samples the object moves at most ~a third of its size.
      const maxJump = Math.max(8, 0.35 * Math.sqrt(tw * th) * st.s);
      const step = pts.length >= 6 ? medianFlow(pyr(i - dir), pyr(i), pts, scaleOn) : null;
      if (step && step.conf >= LOST && Math.hypot(step.dx, step.dy) <= maxJump) {
        st = { x: st.x + step.dx, y: st.y + step.dy, s: Math.min(6, Math.max(0.2, st.s * step.scale)), conf: step.conf };
      } else {
        const found = reacquire(frames[i]!, tpl, tw, th, tst, st.x, st.y, st.s, scaleOn);
        if (found.score > 0.82 && Math.hypot(found.x - st.x, found.y - st.y) <= maxJump) st = { x: found.x, y: found.y, s: found.s, conf: Math.min(0.8, found.score) };
        else if (step && Math.hypot(step.dx, step.dy) <= maxJump) st = { x: st.x + step.dx, y: st.y + step.dy, s: st.s, conf: Math.min(LOST - 0.01, step.conf) }; // follow the flow, flagged as unsure
        else st = { ...st, conf: 0.2 }; // hold: uncertain
      }
      pos[i] = st;
      levels.delete(i - 2 * dir); // keep memory flat
    }
    levels.clear();
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
  const points = pos.map((p, i) => ({ t: Math.round((start + i / fps) * 1000) / 1000, dx: r4(Math.max(-1, Math.min(1, (avg(xs, i) - c0.x) / W))), dy: r4(Math.max(-1, Math.min(1, (avg(ys, i) - c0.y) / H))), s: r4(avg(ss, i)), conf: Math.round(p.conf * 100) / 100 }));
  // Reliable span: from the selection frame outwards until 4 uncertain samples in a row.
  const reach = (dir: 1 | -1) => {
    let bad = 0;
    let last = ref;
    for (let j = ref + dir; j >= 0 && j < points.length; j += dir) {
      if ((points[j]!.conf ?? 1) < LOST) {
        if (++bad >= 4) break;
      } else {
        bad = 0;
        last = j;
      }
    }
    return points[last]!.t;
  };
  return { points, smoothing: o.smoothing ?? 0.3, lost: points.filter((p) => (p.conf ?? 1) < LOST).length, reliable: { start: reach(-1), end: reach(1) } };
}
