import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hexToRgb, interiorPoints, prepareFrame, regionAt, rgbToHsl, selectFrom, smartSelect, timelineSchema, type EditMask } from '@framecraft/shared';
import { ffmpeg } from '../src/media/ffmpeg';
import { trackBox } from '../src/media/tracker';
import { renderTimeline } from '../src/media/render';
import { spliceEdit } from '../src/editing/localize';

/*
 * Task B end to end on real FFmpeg: a red box moves (and grows) across a beige wall. We select it
 * from one click on a frame, track it through the clip, recolour it blue and export — then read the
 * exported pixels: the box is blue wherever it went, the wall is untouched, and an object edit
 * limited to a time range leaves the other seconds alone.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-objedit-'));
const clip = path.join(dir, 'moving-box.mp4');
const ASSET = '00000000-0000-4000-8000-0000000000aa';
// Box: 80×80 at x = 60 + 110·t, y = 140 (640×360, 4 s); it grows to 104×104 by the end.
const boxAt = (t: number) => {
  const size = 80 + 6 * t;
  return { x: 60 + 110 * t - (size - 80) / 2, y: 140 - (size - 80) / 2, size };
};

async function frameRgb(file: string, t: number, w: number, h: number): Promise<Buffer> {
  const out = path.join(dir, `f-${Math.random().toString(36).slice(2)}.rgb`);
  await ffmpeg(['-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, out]);
  const buf = await fsp.readFile(out);
  await fsp.rm(out, { force: true });
  return buf;
}
const px = (buf: Buffer, w: number, x: number, y: number) => {
  const i = (Math.round(y) * w + Math.round(x)) * 3;
  return [buf[i]! / 255, buf[i + 1]! / 255, buf[i + 2]! / 255] as [number, number, number];
};
const hue = (rgb: [number, number, number]) => rgbToHsl(...rgb)[0];

beforeAll(async () => {
  // Frames drawn here (the bundled FFmpeg cannot animate sizes): beige wall, red box moving and growing.
  const W = 640, H = 360, fps = 30, frames = 4 * fps;
  const raw = path.join(dir, 'frames.rgb');
  const buf = Buffer.alloc(W * H * 3 * frames);
  for (let f = 0; f < frames; f++) {
    const b = boxAt(f / fps);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = ((f * H + y) * W + x) * 3;
        const inBox = x >= b.x && x < b.x + b.size && y >= b.y && y < b.y + b.size;
        buf[i] = inBox ? 0xcc : 0xd6;
        buf[i + 1] = inBox ? 0x22 : 0xc4;
        buf[i + 2] = inBox ? 0x33 : 0xa8;
      }
  }
  await fsp.writeFile(raw, buf);
  await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(fps), '-i', raw, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', clip]);
  await fsp.rm(raw, { force: true });
}, 120_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('object edit: select → track → recolour → export', () => {
  let mask: EditMask;

  it('selects the box from one click on the frame at 1 s', async () => {
    const buf = await frameRgb(clip, 1, 640, 360);
    const b = boxAt(1);
    const r = smartSelect({ data: new Uint8Array(buf), width: 640, height: 360, channels: 3 }, b.x + b.size / 2, b.y + b.size / 2)!;
    expect(r).not.toBeNull();
    expect(r.bounds.x0 * 640).toBeGreaterThan(b.x - 4);
    expect(r.bounds.x1 * 640).toBeLessThan(b.x + b.size + 4);
    expect(Math.abs(r.area * 640 * 360 - b.size * b.size)).toBeLessThan(b.size * b.size * 0.15);
    mask = { rects: [], strokes: [], polygons: [{ points: r.polygon, subtract: false }], feather: 0.004, invert: false };
  });

  it('tracks it through the whole clip, including its growth', async () => {
    const b = boxAt(1);
    const tr = await trackBox(clip, { atSec: 1, startSec: 0, endSec: 4, box: { x: b.x / 640, y: b.y / 360, w: b.size / 640, h: b.size / 360 } });
    const at = (t: number) => tr.points.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best));
    // Centre moved 110 px/s minus the growth offset (which keeps the centre on the box path).
    expect(at(3).dx * 640).toBeGreaterThan(200);
    expect(at(3).dx * 640).toBeLessThan(240);
    expect(at(3.5).s ?? 1).toBeGreaterThan(1.05);
    expect(tr.lost).toBeLessThanOrEqual(2);
    expect(tr.reliable.end).toBeGreaterThan(3.5);
    mask = { ...mask, track: { points: tr.points, smoothing: tr.smoothing } };
  }, 60_000);

  it('exports the box blue wherever it goes, and leaves the wall alone', async () => {
    const out = path.join(dir, 'out.mp4');
    const timeline = timelineSchema.parse({
      aspectRatio: '16:9',
      resolution: '720p',
      fps: 30,
      clips: [
        {
          id: 'c1',
          assetId: ASSET,
          inSec: 0,
          outSec: 4,
          objects: [{ id: 'o1', name: 'Box', mask, atSec: 1, startSec: 0, endSec: 4, color: '#CC2233', effects: [{ type: 'recolor', from: '#CC2233', to: '#2563EB' }] }],
        },
      ],
    });
    await renderTimeline({ timeline, resolve: async () => clip, output: out });
    for (const t of [0.4, 2, 3.4]) {
      const buf = await frameRgb(out, t, 1280, 720);
      const b = boxAt(t);
      const k = 1280 / 640;
      const inside = px(buf, 1280, (b.x + b.size / 2) * k, (b.y + b.size / 2) * k);
      expect(hue(inside), `box at ${t}s`).toBeGreaterThan(205);
      expect(hue(inside), `box at ${t}s`).toBeLessThan(235);
      const wall = px(buf, 1280, 20 * k, 30 * k);
      const ref = hexToRgb('#D6C4A8');
      expect(Math.abs(wall[0] - ref[0]) + Math.abs(wall[1] - ref[1]) + Math.abs(wall[2] - ref[2]), `wall at ${t}s`).toBeLessThan(0.08);
    }
  }, 180_000);

  it('an AI result is blended back only inside the moving, growing object and only in its seconds', async () => {
    // Stand-in for the model's output: the whole window turned solid blue.
    const edited = path.join(dir, 'ai-window.mp4');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x2563EB:s=640x360:r=30:d=3.2', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', edited]);
    const out = path.join(dir, 'spliced.mp4');
    await spliceEdit({ original: clip, edited, output: out, windowStart: 0.4, rangeStart: 0.5, rangeEnd: 3.5, mask, workdir: dir });
    for (const t of [1, 3]) {
      const buf = await frameRgb(out, t, 640, 360);
      const b = boxAt(t);
      expect(hue(px(buf, 640, b.x + b.size / 2, b.y + b.size / 2)), `object at ${t}s`).toBeGreaterThan(205);
      const wall = px(buf, 640, 20, 30);
      const ref = hexToRgb('#D6C4A8');
      expect(Math.abs(wall[0] - ref[0]) + Math.abs(wall[1] - ref[1]) + Math.abs(wall[2] - ref[2]), `wall at ${t}s`).toBeLessThan(0.08);
    }
    const before = await frameRgb(out, 0.2, 640, 360);
    const b0 = boxAt(0.2);
    const h0 = hue(px(before, 640, b0.x + b0.size / 2, b0.y + b0.size / 2));
    expect(Math.min(h0, 360 - h0)).toBeLessThan(15); // outside the range: the original red
  }, 180_000);

  it('a landscape clip in a vertical project: the edit lands on the object inside the crop', async () => {
    // 640×360 source in a 9:16 project: only the middle ~200 px of the width are visible.
    const out = path.join(dir, 'out-vertical.mp4');
    const timeline = timelineSchema.parse({
      aspectRatio: '9:16',
      resolution: '720p',
      fps: 30,
      clips: [{ id: 'c1', assetId: ASSET, inSec: 0, outSec: 4, objects: [{ id: 'o1', name: 'Box', mask, atSec: 1, startSec: 0, endSec: 4, effects: [{ type: 'recolor', from: '#CC2233', to: '#2563EB' }] }] }],
    });
    await renderTimeline({ timeline, resolve: async () => clip, output: out });
    // Cover scale k = 1280 / 360; visible source x from (640·k − 720) / 2 / k.
    const k = 1280 / 360;
    const x0 = (640 * k - 720) / 2 / k;
    for (const t of [2.1, 2.6]) {
      const buf = await frameRgb(out, t, 720, 1280);
      const b = boxAt(t);
      const cx = (b.x + b.size / 2 - x0) * k;
      const cy = (b.y + b.size / 2) * k;
      expect(cx).toBeGreaterThan(40);
      expect(cx).toBeLessThan(680);
      expect(hue(px(buf, 720, cx, cy)), `box at ${t}s in the vertical frame`).toBeGreaterThan(205);
      const ref = hexToRgb('#D6C4A8');
      const wall = px(buf, 720, 360, 120);
      expect(Math.abs(wall[0] - ref[0]) + Math.abs(wall[1] - ref[1]) + Math.abs(wall[2] - ref[2]), 'wall').toBeLessThan(0.08);
    }
  }, 180_000);

  it('a time-limited edit leaves the other seconds untouched', async () => {
    const out = path.join(dir, 'out-range.mp4');
    const timeline = timelineSchema.parse({
      aspectRatio: '16:9',
      resolution: '720p',
      fps: 30,
      clips: [{ id: 'c1', assetId: ASSET, inSec: 0, outSec: 4, objects: [{ id: 'o1', name: 'Box', mask, atSec: 1, startSec: 2, endSec: 4, scope: 'range', effects: [{ type: 'recolor', from: '#CC2233', to: '#2563EB' }] }] }],
    });
    await renderTimeline({ timeline, resolve: async () => clip, output: out });
    const early = await frameRgb(out, 1, 1280, 720);
    const b1 = boxAt(1);
    const h1 = hue(px(early, 1280, (b1.x + b1.size / 2) * 2, (b1.y + b1.size / 2) * 2));
    expect(Math.min(h1, 360 - h1)).toBeLessThan(15); // still red at 1 s
    const late = await frameRgb(out, 3, 1280, 720);
    const b3 = boxAt(3);
    expect(hue(px(late, 1280, (b3.x + b3.size / 2) * 2, (b3.y + b3.size / 2) * 2))).toBeGreaterThan(205); // blue at 3 s
  }, 180_000);
});

describe('object edit: a shape-changing object is followed exactly', () => {
  // An orange blob that turns from wide (60×30) to tall (30×60) over 2 s, on a grey wall.
  const S = 320;
  const turning = path.join(dir, 'turning.mp4');
  const shapeAt = (t: number) => ({ rx: 60 - 15 * t, ry: 30 + 15 * t });

  beforeAll(async () => {
    const fps = 30, frames = 2 * fps;
    const raw = path.join(dir, 'turning.rgb');
    const buf = Buffer.alloc(S * S * 3 * frames);
    for (let f = 0; f < frames; f++) {
      const { rx, ry } = shapeAt(f / fps);
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const i = ((f * S + y) * S + x) * 3;
          const inside = ((x - 160) / rx) ** 2 + ((y - 160) / ry) ** 2 <= 1;
          buf[i] = inside ? 0xe8 : 0x80;
          buf[i + 1] = inside ? 0x78 : 0x82;
          buf[i + 2] = inside ? 0x1e : 0x86;
        }
    }
    await fsp.writeFile(raw, buf);
    await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${S}x${S}`, '-r', String(fps), '-i', raw, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', turning]);
    await fsp.rm(raw, { force: true });
  }, 120_000);

  it('exports it blue in its new shape (the drawn outline alone would miss it)', async () => {
    // Selected on the first frame, as the editor does: the outline plus how to find it again.
    const f0 = await frameRgb(turning, 0, S, S);
    const p = prepareFrame({ data: new Uint8Array(f0), width: S, height: S, channels: 3 });
    const sel = selectFrom(p, 160, 160);
    const region = regionAt(p, sel, sel.auto)!;
    const adapt = { on: true, parts: [{ seeds: interiorPoints(region.mask, S, S, 12), lab: [sel.ref.L, sel.ref.A, sel.ref.B], wL: sel.ref.wL, threshold: sel.auto }], res: S };
    const timeline = (follow: boolean) =>
      timelineSchema.parse({
        aspectRatio: '1:1',
        resolution: '720p',
        fps: 30,
        clips: [{ id: 'c1', assetId: ASSET, inSec: 0, outSec: 2, objects: [{ id: 'o1', name: 'Blob', mask: { rects: [], strokes: [], polygons: [{ points: region.polygon, subtract: false }], feather: 0.004, invert: false }, atSec: 0, startSec: 0, endSec: 2, color: region.color, ...(follow ? { adapt } : {}), effects: [{ type: 'recolor', from: region.color, to: '#2563EB' }] }] }],
      });
    const k = 720 / S;
    const { ry } = shapeAt(1.8);
    for (const follow of [true, false]) {
      const out = path.join(dir, `turning-${follow}.mp4`);
      await renderTimeline({ timeline: timeline(follow), resolve: async () => turning, output: out });
      const buf = await frameRgb(out, 1.8, 720, 720);
      const centre = hue(px(buf, 720, 160 * k, 160 * k));
      const newPart = hue(px(buf, 720, 160 * k, (160 + ry - 8) * k)); // inside the tall shape only
      const wall = rgbToHsl(...px(buf, 720, 40 * k, 40 * k));
      expect(centre).toBeGreaterThan(200);
      expect(centre).toBeLessThan(245);
      if (follow) {
        expect(newPart).toBeGreaterThan(200);
        expect(newPart).toBeLessThan(245);
      } else expect(newPart).toBeLessThan(45); // still orange: the drawn outline does not reach it
      expect(wall[1]).toBeLessThan(0.12); // the grey wall stays grey
    }
  }, 240_000);
});
