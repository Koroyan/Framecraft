import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { adaptedMaskAt, adapts, applyTransform, buildLut, fillPolygon, lutToCube, maskIsEmpty, maskTransformAt, objectActiveAt, objectColorFunction, reframeAt, spatialEffect, type AdaptedMask, type EditMask, type ObjectEdit } from '@framecraft/shared';
import { ffmpeg, ffmpegPath } from './ffmpeg';

/*
 * Object edits in the export. Each object becomes a mask *video* drawn here frame by frame — at
 * every output frame the selection is moved/scaled by its track at that frame's source second,
 * mapped through the same cover crop (and re-frame) as the picture, and left black outside the
 * object's time range — then FFmpeg composites the effect (colour LUT / blur / pixelate) through
 * it. The maths (transform, active range, colour function) is the one the browser preview uses.
 */

const n = (v: number) => (Math.round(v * 100000) / 100000).toString();

type Map2 = (x: number, y: number) => [number, number];

/**
 * Rasterise a selection into `buf` (mask pixels), every point passed through `map`. `found`, when
 * given, paints the added polygons instead (the object's shape found on this very frame).
 */
export function rasterizeMask(buf: Uint8Array, w: number, h: number, mask: EditMask, map: Map2, found?: () => void) {
  for (const r of mask.rects) {
    let pts: [number, number][];
    if (r.ellipse) {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      pts = Array.from({ length: 48 }, (_, i) => map(cx + (Math.cos((i / 48) * Math.PI * 2) * r.w) / 2, cy + (Math.sin((i / 48) * Math.PI * 2) * r.h) / 2));
    } else pts = [map(r.x, r.y), map(r.x + r.w, r.y), map(r.x + r.w, r.y + r.h), map(r.x, r.y + r.h)];
    fillPolygon(buf, w, h, pts, r.subtract ? 0 : 255);
  }
  let painted = false;
  for (const p of mask.polygons) {
    if (found && !p.subtract) {
      if (!painted) found();
      painted = true;
      continue;
    }
    fillPolygon(buf, w, h, p.points.map(([x, y]) => map(x, y)), p.subtract ? 0 : 255);
  }
  for (const s of mask.strokes) {
    const pts = s.points.map(([x, y]) => map(x, y));
    const [ax, ay] = map(s.points[0]![0], s.points[0]![1]);
    const [bx] = map(s.points[0]![0] + s.radius, s.points[0]![1]);
    const r = Math.max(0.5, Math.abs(bx - ax));
    void ay;
    const xsAll = pts.map((p) => p[0]);
    const ysAll = pts.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xsAll) - r)), x1 = Math.min(w - 1, Math.ceil(Math.max(...xsAll) + r));
    const y0 = Math.max(0, Math.floor(Math.min(...ysAll) - r)), y1 = Math.min(h - 1, Math.ceil(Math.max(...ysAll) + r));
    const v = s.subtract ? 0 : 255;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        for (let i = 0; i < pts.length; i++) {
          const [sx, sy] = pts[i]!;
          const [ex, ey] = pts[Math.min(i + 1, pts.length - 1)]!;
          const dx = ex - sx, dy = ey - sy;
          const len = dx * dx + dy * dy;
          const t = len ? Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / len)) : 0;
          if ((px - sx - t * dx) ** 2 + (py - sy - t * dy) ** 2 <= r * r) {
            buf[y * w + x] = v;
            break;
          }
        }
      }
  }
  if (mask.invert) for (let i = 0; i < buf.length; i++) buf[i] = 255 - buf[i]!;
}

export type ObjectFxOptions = {
  dir: string;
  key: string;
  /** Output frame size and rate. */
  width: number;
  height: number;
  fps: number;
  /** Clip duration on the timeline (seconds). */
  durationSec: number;
  srcWidth: number;
  srcHeight: number;
  inSec: number;
  outSec: number;
  speed: number;
  reverse?: boolean;
  freeze?: boolean;
  reframe?: { t: number; x: number; y: number }[];
  /** The clip's source file: objects that follow shape changes are found again in its frames. */
  source?: string;
};

/** A shape found on the frame (frame pixels) painted into mask pixels; `toMask` / `fromMask` map normalised source <-> mask. */
function paintAdapted(buf: Uint8Array, mw: number, mh: number, a: AdaptedMask, toMask: Map2, fromMask: Map2) {
  const [ax0, ay0] = toMask(a.x0 / a.frameWidth, a.y0 / a.frameHeight);
  const [ax1, ay1] = toMask((a.x0 + a.width) / a.frameWidth, (a.y0 + a.height) / a.frameHeight);
  for (let y = Math.max(0, Math.floor(ay0)); y < Math.min(mh, Math.ceil(ay1)); y++)
    for (let x = Math.max(0, Math.floor(ax0)); x < Math.min(mw, Math.ceil(ax1)); x++) {
      const [sx, sy] = fromMask(x + 0.5, y + 0.5);
      const px = Math.floor(sx * a.frameWidth) - a.x0;
      const py = Math.floor(sy * a.frameHeight) - a.y0;
      if (px >= 0 && py >= 0 && px < a.width && py < a.height && a.mask[py * a.width + px]) buf[y * mw + x] = 255;
    }
}

/** Frames of a video decoded one at a time (RGB) - never all held in memory. */
function frameReader(file: string, o: { startSec: number; durationSec: number; fps: number; width: number; height: number }) {
  const size = o.width * o.height * 3;
  const args = ['-v', 'error', '-ss', n(o.startSec), '-t', n(Math.max(1 / o.fps, o.durationSec)), '-i', file, '-an', '-vf', `fps=${n(o.fps)},scale=${o.width}:${o.height}:flags=bilinear`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
  const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  child.on('error', () => undefined);
  const it = child.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let rest: Buffer | null = null;
  let ended = false;
  let last: Uint8Array | null = null;
  return {
    /** The next frame; the last one again once the video ends; null if nothing could be decoded. */
    async next(): Promise<Uint8Array | null> {
      if (ended) return last;
      const frame = new Uint8Array(size);
      let filled = 0;
      while (filled < size) {
        let chunk = rest;
        rest = null;
        if (!chunk) {
          const r = await it.next().catch((): IteratorResult<Buffer> => ({ done: true, value: undefined }));
          if (r.done) {
            ended = true;
            return last;
          }
          chunk = r.value;
        }
        const take = Math.min(size - filled, chunk.length);
        frame.set(chunk.subarray(0, take), filled);
        filled += take;
        if (take < chunk.length) rest = chunk.subarray(take);
      }
      last = frame;
      return frame;
    },
    close() {
      if (child.exitCode === null) child.kill();
    },
  };
}

/** Source second shown at output time t of the normalised clip (same mapping as normalizeClip). */
export function sourceTimeAt(o: Pick<ObjectFxOptions, 'inSec' | 'outSec' | 'speed' | 'reverse' | 'freeze'>, t: number): number {
  if (o.freeze) return o.inSec;
  return o.reverse ? o.outSec - t * o.speed : o.inSec + t * o.speed;
}

/** Write the object's mask video (FFV1, grey) at reduced size; returns its file name in `dir`. */
export async function writeObjectMaskVideo(obj: ObjectEdit, o: ObjectFxOptions, file: string): Promise<void> {
  const long = 384;
  const k = long / Math.max(o.width, o.height);
  const mw = Math.max(2, Math.round((o.width * k) / 2) * 2);
  const mh = Math.max(2, Math.round((o.height * k) / 2) * 2);
  const frames = Math.ceil(o.durationSec * o.fps) + 2;
  const scale = Math.max(o.width / o.srcWidth, o.height / o.srcHeight);
  const sw = o.srcWidth * scale;
  const sh = o.srcHeight * scale;
  const raw = path.join(o.dir, `${path.basename(file)}.raw`);
  const handle = await fsp.open(raw, 'w');
  const buf = new Uint8Array(mw * mh);
  // Objects that follow shape changes are found again in every source frame (same function as the preview).
  const fw = obj.adapt?.res ?? 0;
  const fh = Math.max(2, Math.round((fw * o.srcHeight) / Math.max(1, o.srcWidth)));
  const reader = adapts(obj) && o.source && !o.reverse ? frameReader(o.source, { startSec: o.inSec, durationSec: o.freeze ? 1 / o.fps : o.durationSec * o.speed, fps: o.fps * (o.freeze ? 1 : o.speed), width: fw, height: fh }) : null;
  try {
    for (let f = 0; f < frames; f++) {
      buf.fill(0);
      const srcT = sourceTimeAt(o, f / o.fps);
      // Decode in step with the output, also while the object is inactive.
      const img = reader ? await reader.next() : null;
      if (objectActiveAt(obj, srcT, 1 / o.fps)) {
        const tr = maskTransformAt(obj.mask, srcT);
        let offX = (sw - o.width) / 2;
        let offY = (sh - o.height) / 2;
        if (o.reframe?.length) {
          const c = reframeAt(o.reframe, srcT);
          offX = Math.min(Math.max(0, c.x * sw - o.width / 2), Math.max(0, sw - o.width));
          offY = Math.min(Math.max(0, c.y * sh - o.height / 2), Math.max(0, sh - o.height));
        }
        const toMask: Map2 = (x, y) => [((x * sw - offX) / o.width) * mw, ((y * sh - offY) / o.height) * mh];
        const fromMask: Map2 = (x, y) => [((x / mw) * o.width + offX) / sw, ((y / mh) * o.height + offY) / sh];
        const adapted = img ? adaptedMaskAt(obj, { data: img, width: fw, height: fh, channels: 3 }, srcT) : null;
        rasterizeMask(
          buf,
          mw,
          mh,
          obj.mask,
          (x, y) => {
            const [tx, ty] = applyTransform(tr, x, y);
            return toMask(tx, ty);
          },
          adapted ? () => paintAdapted(buf, mw, mh, adapted, toMask, fromMask) : undefined,
        );
      }
      await handle.write(buf);
    }
  } finally {
    reader?.close();
    await handle.close();
  }
  await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${mw}x${mh}`, '-r', String(o.fps), '-i', raw, '-c:v', 'ffv1', '-pix_fmt', 'gray', file], { timeoutMs: 10 * 60_000, cwd: o.dir });
  await fsp.rm(raw, { force: true });
}

/**
 * FFmpeg filters that apply the clip's object edits (after the grade, before the 2D camera).
 * Files are written to `dir`; FFmpeg must run with `cwd = dir`.
 */
export async function objectFilters(objects: ObjectEdit[] | undefined, o: ObjectFxOptions): Promise<string[]> {
  const out: string[] = [];
  const list = (objects ?? []).filter((x) => x.enabled && x.effects.length && !maskIsEmpty(x.mask) && x.endSec >= Math.min(o.inSec, o.outSec) - 0.05 && x.startSec <= Math.max(o.inSec, o.outSec) + 0.05);
  for (let i = 0; i < list.length; i++) {
    const obj = list[i]!;
    const maskFile = `${o.key}-obj${i}.mkv`;
    await writeObjectMaskVideo(obj, o, path.join(o.dir, maskFile));
    const chain: string[] = [];
    const sp = spatialEffect(obj.effects);
    if (sp?.type === 'blur') chain.push(`gblur=sigma=${n((sp.amount * o.height) / 1080)}`);
    else if (sp?.type === 'pixelate') {
      const block = Math.max(2, (sp.size * o.height) / 1080);
      const bw = Math.max(2, Math.round(o.width / block));
      const bh = Math.max(2, Math.round(o.height / block));
      chain.push(`scale=${bw}:${bh}:flags=area`, `scale=${o.width}:${o.height}:flags=neighbor`);
    }
    const fn = objectColorFunction(obj.effects);
    if (fn) {
      const cube = `${o.key}-obj${i}.cube`;
      await fsp.writeFile(path.join(o.dir, cube), lutToCube(buildLut(fn, 33)));
      chain.push(`lut3d=file=${cube}:interp=trilinear`);
    }
    if (!chain.length) continue;
    // Feather: the preview blurs the mask by `feather` × source width; in output pixels that is × sw.
    const sw = o.srcWidth * Math.max(o.width / o.srcWidth, o.height / o.srcHeight);
    const sigma = Math.max(0.5, (obj.mask.feather ?? 0.015) * sw);
    out.push(
      `split[ob${i}][os${i}];` +
        `[os${i}]${chain.join(',')}[oe${i}];` +
        `movie=${maskFile},format=gray,scale=${o.width}:${o.height},gblur=sigma=${n(sigma)}[om${i}];` +
        `[oe${i}][om${i}]alphamerge[oa${i}];` +
        `[ob${i}][oa${i}]overlay=format=auto:eof_action=pass,format=yuv420p`,
    );
  }
  return out;
}

/**
 * A selection as a mask video in *source* coordinates (no crop), from source second `startSec` for
 * `durationSec` — moved and resized by its track on every frame. Used when an AI edit is blended
 * back into the original shot.
 */
export async function writeSourceMaskVideo(mask: EditMask, o: { width: number; height: number; fps: number; startSec: number; durationSec: number; dir: string; file: string }): Promise<void> {
  const long = 384;
  const k = long / Math.max(o.width, o.height);
  const mw = Math.max(2, Math.round((o.width * k) / 2) * 2);
  const mh = Math.max(2, Math.round((o.height * k) / 2) * 2);
  const frames = Math.ceil(o.durationSec * o.fps) + 2;
  const raw = path.join(o.dir, `${path.basename(o.file)}.raw`);
  const handle = await fsp.open(raw, 'w');
  const buf = new Uint8Array(mw * mh);
  try {
    for (let f = 0; f < frames; f++) {
      buf.fill(0);
      const tr = maskTransformAt(mask, o.startSec + f / o.fps);
      rasterizeMask(buf, mw, mh, mask, (x, y) => {
        const [tx, ty] = applyTransform(tr, x, y);
        return [tx * mw, ty * mh];
      });
      await handle.write(buf);
    }
  } finally {
    await handle.close();
  }
  await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${mw}x${mh}`, '-r', String(o.fps), '-i', raw, '-c:v', 'ffv1', '-pix_fmt', 'gray', o.file], { timeoutMs: 10 * 60_000 });
  await fsp.rm(raw, { force: true });
}
