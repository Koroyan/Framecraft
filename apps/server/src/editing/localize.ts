import fsp from 'node:fs/promises';
import path from 'node:path';
import type { EditMask } from '@framecraft/shared';
import { ffmpeg, probe } from '../media/ffmpeg';

/*
 * Localized editing primitives (FFmpeg only, no AI): cut the edit window out of a shot, rasterise a
 * spatial selection, and put an edited window back so that everything outside the selected time
 * range — and outside the mask — is the original footage, pixel for pixel, with the original audio.
 */

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/**
 * Extract [startSec, endSec) as a silent H.264 clip small enough for an inline provider upload.
 * Lowers quality, then size, until it fits `maxBytes`.
 */
export async function extractWindow(src: string, output: string, o: { startSec: number; endSec: number; maxBytes: number; maxSide?: number }): Promise<{ width: number; height: number; bytes: number }> {
  const p = await probe(src);
  const w0 = p.width ?? 1280;
  const h0 = p.height ?? 720;
  const sides = [o.maxSide ?? 1280, 960, 720, 540];
  for (const side of sides) {
    const k = Math.min(1, side / Math.max(w0, h0));
    const width = even(w0 * k);
    const height = even(h0 * k);
    for (const crf of [22, 26, 30, 34]) {
      await ffmpeg(['-ss', String(o.startSec), '-t', String(Math.max(0.1, o.endSec - o.startSec)), '-i', src, '-an', '-vf', `scale=${width}:${height},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-movflags', '+faststart', output]);
      const bytes = (await fsp.stat(output)).size;
      if (bytes <= o.maxBytes) return { width, height, bytes };
    }
  }
  throw new Error('The selected part of the shot is too large to send for editing; select a shorter time range.');
}

/** Rasterise a normalised selection to an 8-bit greyscale PGM (white = edit here). */
export async function writeMaskPgm(mask: EditMask, width: number, height: number, file: string): Promise<void> {
  const px = new Uint8Array(width * height);
  const paint = (inside: (x: number, y: number) => boolean, value: number, box: [number, number, number, number]) => {
    const [x0, y0, x1, y1] = [Math.max(0, Math.floor(box[0] * width)), Math.max(0, Math.floor(box[1] * height)), Math.min(width - 1, Math.ceil(box[2] * width)), Math.min(height - 1, Math.ceil(box[3] * height))];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside((x + 0.5) / width, (y + 0.5) / height)) px[y * width + x] = value;
  };
  for (const r of mask.rects) {
    const inside = r.ellipse
      ? (x: number, y: number) => ((x - (r.x + r.w / 2)) / (r.w / 2)) ** 2 + ((y - (r.y + r.h / 2)) / (r.h / 2)) ** 2 <= 1
      : (x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    paint(inside, r.subtract ? 0 : 255, [r.x, r.y, r.x + r.w, r.y + r.h]);
  }
  for (const poly of mask.polygons) {
    const pts = poly.points;
    const inside = (x: number, y: number) => {
      let c = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]!;
        const [xj, yj] = pts[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    paint(inside, poly.subtract ? 0 : 255, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  for (const s of mask.strokes) {
    // Brush: distance (in frame-width units) from each pixel to the polyline ≤ radius.
    const aspect = height / width;
    const pts = s.points.map(([x, y]) => [x, y * aspect] as const);
    const inside = (x: number, y: number) => {
      const py = y * aspect;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i]!;
        const [bx, by] = pts[Math.min(i + 1, pts.length - 1)]!;
        const dx = bx - ax;
        const dy = by - ay;
        const len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (py - ay) * dy) / len)) : 0;
        if ((x - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2 <= s.radius ** 2) return true;
      }
      return false;
    };
    const xs = s.points.map((p) => p[0]);
    const ys = s.points.map((p) => p[1]);
    paint(inside, s.subtract ? 0 : 255, [Math.min(...xs) - s.radius, Math.min(...ys) - s.radius / aspect, Math.max(...xs) + s.radius, Math.max(...ys) + s.radius / aspect]);
  }
  if (mask.invert) for (let i = 0; i < px.length; i++) px[i] = 255 - px[i]!;
  await fsp.writeFile(file, Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), Buffer.from(px)]));
}

/**
 * Put an edited window back into the original shot.
 * - `edited` covers [windowStart, windowEnd) of the original (any size/fps; conformed here).
 * - Only [rangeStart, rangeEnd) is taken from it; the rest is the original, untouched.
 * - With a mask, the edit shows only inside it (feathered); outside is the original.
 * - The original audio track is kept as is (the model's output carries none).
 */
export async function spliceEdit(o: {
  original: string;
  edited: string;
  output: string;
  windowStart: number;
  rangeStart: number;
  rangeEnd: number;
  mask?: EditMask | null;
  workdir: string;
}): Promise<{ durationSec: number }> {
  const p = await probe(o.original);
  const W = p.width ?? 1280;
  const H = p.height ?? 720;
  const fps = Math.min(60, Math.max(12, Math.round(p.fps ?? 30)));
  const dur = p.durationSec;
  const rs = Math.max(0, Math.min(o.rangeStart, dur));
  const re = Math.max(rs + 0.05, Math.min(o.rangeEnd, dur));
  const es = Math.max(0, rs - o.windowStart);
  const ee = es + (re - rs);

  const args = ['-i', o.original, '-i', o.edited];
  const f: string[] = [];
  const parts: string[] = [];
  f.push(`[0:v]fps=${fps},format=yuv420p,setsar=1,split=3[o1][o2][o3]`);
  if (rs > 0.01) {
    f.push(`[o1]trim=start=0:end=${rs},setpts=PTS-STARTPTS[pre]`);
    parts.push('[pre]');
  } else f.push('[o1]nullsink');
  // The edited window, conformed to the original's size and frame rate, cut to the range.
  f.push(`[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p,setsar=1,trim=start=${es}:end=${ee},setpts=PTS-STARTPTS[em]`);
  f.push(`[o2]trim=start=${rs}:end=${re},setpts=PTS-STARTPTS[om]`);
  if (o.mask) {
    const maskFile = path.join(o.workdir, 'mask.pgm');
    const mw = Math.min(W, 640);
    const mh = even((H * mw) / W);
    await writeMaskPgm(o.mask, mw, mh, maskFile);
    args.push('-loop', '1', '-t', String(re - rs + 1), '-i', maskFile);
    const sigma = Math.max(0.5, o.mask.feather * W);
    f.push(`[2:v]scale=${W}:${H},format=gray,gblur=sigma=${sigma.toFixed(2)},fps=${fps},trim=duration=${re - rs},setpts=PTS-STARTPTS[mk]`);
    f.push('[em][mk]alphamerge[ea]');
    f.push('[om][ea]overlay=format=auto:shortest=1,format=yuv420p[mid]');
  } else {
    f.push('[om]nullsink');
    f.push('[em]null[mid]');
  }
  parts.push('[mid]');
  if (re < dur - 0.01) {
    f.push(`[o3]trim=start=${re},setpts=PTS-STARTPTS[post]`);
    parts.push('[post]');
  } else f.push('[o3]nullsink');
  f.push(`${parts.join('')}concat=n=${parts.length}:v=1:a=0,format=yuv420p[v]`);
  args.push('-filter_complex', f.join(';'), '-map', '[v]');
  if (p.hasAudio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k');
  args.push('-t', String(dur), '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', o.output);
  await ffmpeg(args, { timeoutMs: 20 * 60_000 });
  return { durationSec: (await probe(o.output)).durationSec };
}

/** Whole-shot result (reframe / camera remix): the model's picture, the original's length and audio. */
export async function adoptWholeShot(o: { original: string; edited: string; output: string }): Promise<void> {
  const p = await probe(o.original);
  const args = ['-i', o.edited, '-i', o.original, '-map', '0:v:0'];
  if (p.hasAudio) args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k');
  args.push('-vf', 'format=yuv420p', '-t', String(p.durationSec), '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-movflags', '+faststart', o.output);
  await ffmpeg(args, { timeoutMs: 20 * 60_000 });
}
