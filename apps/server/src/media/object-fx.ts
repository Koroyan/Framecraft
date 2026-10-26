import fsp from 'node:fs/promises';
import path from 'node:path';
import { applyTransform, buildLut, lutToCube, maskIsEmpty, maskTransformAt, objectActiveAt, objectColorFunction, reframeAt, spatialEffect, type EditMask, type ObjectEdit } from '@framecraft/shared';
import { ffmpeg } from './ffmpeg';

/*
 * Object edits in the export. Each object becomes a mask *video* drawn here frame by frame — at
 * every output frame the selection is moved/scaled by its track at that frame's source second,
 * mapped through the same cover crop (and re-frame) as the picture, and left black outside the
 * object's time range — then FFmpeg composites the effect (colour LUT / blur / pixelate) through
 * it. The maths (transform, active range, colour function) is the one the browser preview uses.
 */

const n = (v: number) => (Math.round(v * 100000) / 100000).toString();

type Map2 = (x: number, y: number) => [number, number];

/** Even-odd scanline fill of a polygon given in mask pixels. */
function fillPolygon(buf: Uint8Array, w: number, h: number, pts: [number, number][], value: number) {
  if (pts.length < 3) return;
  let y0 = h, y1 = 0;
  for (const [, y] of pts) {
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const ys = Math.max(0, Math.floor(y0));
  const ye = Math.min(h - 1, Math.ceil(y1));
  const xs: number[] = [];
  for (let y = ys; y <= ye; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]!;
      const [xj, yj] = pts[j]!;
      if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const b = Math.min(w - 1, Math.floor(xs[k + 1]! - 0.5));
      if (b >= a) buf.fill(value, y * w + a, y * w + b + 1);
    }
  }
}

/** Rasterise a selection into `buf` (mask pixels), every point passed through `map`. */
export function rasterizeMask(buf: Uint8Array, w: number, h: number, mask: EditMask, map: Map2) {
  for (const r of mask.rects) {
    let pts: [number, number][];
    if (r.ellipse) {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      pts = Array.from({ length: 48 }, (_, i) => map(cx + (Math.cos((i / 48) * Math.PI * 2) * r.w) / 2, cy + (Math.sin((i / 48) * Math.PI * 2) * r.h) / 2));
    } else pts = [map(r.x, r.y), map(r.x + r.w, r.y), map(r.x + r.w, r.y + r.h), map(r.x, r.y + r.h)];
    fillPolygon(buf, w, h, pts, r.subtract ? 0 : 255);
  }
  for (const p of mask.polygons) fillPolygon(buf, w, h, p.points.map(([x, y]) => map(x, y)), p.subtract ? 0 : 255);
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
};

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
  try {
    for (let f = 0; f < frames; f++) {
      buf.fill(0);
      const srcT = sourceTimeAt(o, f / o.fps);
      if (objectActiveAt(obj, srcT, 1 / o.fps)) {
        const tr = maskTransformAt(obj.mask, srcT);
        let offX = (sw - o.width) / 2;
        let offY = (sh - o.height) / 2;
        if (o.reframe?.length) {
          const c = reframeAt(o.reframe, srcT);
          offX = Math.min(Math.max(0, c.x * sw - o.width / 2), Math.max(0, sw - o.width));
          offY = Math.min(Math.max(0, c.y * sh - o.height / 2), Math.max(0, sh - o.height));
        }
        rasterizeMask(buf, mw, mh, obj.mask, (x, y) => {
          const [tx, ty] = applyTransform(tr, x, y);
          return [((tx * sw - offX) / o.width) * mw, ((ty * sh - offY) / o.height) * mh];
        });
      }
      await handle.write(buf);
    }
  } finally {
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
