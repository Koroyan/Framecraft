import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { gradeFunction, timelineSchema } from '@framecraft/shared';
import { ffmpeg, probe } from '../src/media/ffmpeg';
import { renderTimeline } from '../src/media/render';
import { trackBox } from '../src/media/tracker';
import { rasterizeLayer } from '../src/media/raster';
import { layerSchema } from '@framecraft/shared';

/*
 * Manual editor: colour, tracked local recolour, animated Georgian titles + logo, picture-in-picture.
 * Real FFmpeg renders; assertions measure pixels of the exported MP4.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-manual-'));
const f = (n: string) => path.join(dir, n);
const ID = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
const files: Record<string, string> = {};
const resolve = async (id: string) => files[id]!;

async function pixel(video: string, t: number, x: number, y: number) {
  const p = await probe(video);
  const out = f(`px-${Math.random().toString(36).slice(2)}.rgb`);
  await ffmpeg(['-ss', String(t), '-i', video, '-frames:v', '1', '-vf', `crop=2:2:${Math.floor((((p.width ?? 4) - 2) * x) / 2) * 2}:${Math.floor((((p.height ?? 4) - 2) * y) / 2) * 2},format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', out]);
  const b = fs.readFileSync(out);
  return [b[0]!, b[1]!, b[2]!] as [number, number, number];
}

beforeAll(async () => {
  // Grey 640×360 clip with a tone.
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x808080:s=640x360:d=3:r=30', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-c:a', 'aac', '-shortest', f('grey.mp4')]);
  files[ID(1)] = f('grey.mp4');
  // Moving red square (left → right) on green, plus a static red disc top-right that must stay red.
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=0x1E9E3C:s=640x360:d=3:r=30',
    '-f', 'lavfi', '-i', 'color=c=0xD01818:s=80x80:d=3:r=30',
    '-filter_complex', "[0:v]drawbox=x=540:y=30:w=60:h=60:color=0xD01818:t=fill[bg];[bg][1:v]overlay=x='60+t*120':y=200[v]",
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-crf', '12', f('moving.mp4'),
  ]);
  files[ID(2)] = f('moving.mp4');
  // Blue clip for picture-in-picture, a white "logo" PNG, and a voice/music pair for ducking.
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x1030E0:s=320x180:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', f('blue.mp4')]);
  files[ID(3)] = f('blue.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xFFFF00:s=200x100', '-frames:v', '1', f('logo.png')]);
  files[ID(4)] = f('logo.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', f('music.mp3')]);
  files[ID(5)] = f('music.mp3');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.5', f('voice.mp3')]);
  files[ID(6)] = f('voice.mp3');
}, 120_000);

describe('manual editor renders what the preview shows', () => {
  it('Test 1 — exposure, saturation and contrast go through the colour LUT into the MP4', async () => {
    const adjust = { exposure: 0.4, contrast: 0.3, saturation: -0.5, temperature: 0.5 };
    const tl = timelineSchema.parse({ aspectRatio: '16:9', resolution: '480p', burnSubtitles: false, clips: [{ id: 'a', assetId: ID(1), inSec: 0, outSec: 3, adjust }] });
    const out = f('t1.mp4');
    await renderTimeline({ timeline: tl, resolve, output: out });
    const got = await pixel(out, 1.5, 0.5, 0.5);
    const want = gradeFunction(adjust)([128 / 255, 128 / 255, 128 / 255]).map((v) => v * 255);
    got.forEach((v, i) => expect(Math.abs(v - want[i]!)).toBeLessThan(10));
    expect(got[0]).toBeGreaterThan(got[2] + 10); // warm
  }, 120_000);

  it('Test 2 — a tracked mask follows the moving object; its colour changes, nothing else does', async () => {
    // Track the square drawn at t=0 (x 60–140 px, y 200–280 px of 640×360).
    const track = await trackBox(f('moving.mp4'), { atSec: 0, startSec: 0, endSec: 3, box: { x: 60 / 640, y: 200 / 360, w: 80 / 640, h: 80 / 360 } });
    const last = track.points.at(-1)!;
    expect(last.dx * 640).toBeGreaterThan(300); // moved ~350 px right
    expect(Math.abs(last.dy)).toBeLessThan(0.03);
    expect(track.lost).toBe(0);
    const mask = { rects: [{ x: 50 / 640, y: 190 / 360, w: 100 / 640, h: 100 / 360, ellipse: false, subtract: false }], polygons: [], strokes: [], feather: 0.003, invert: false, track };
    const tl = timelineSchema.parse({
      aspectRatio: '16:9',
      resolution: '480p',
      burnSubtitles: false,
      clips: [{ id: 'a', assetId: ID(2), inSec: 0, outSec: 3, adjust: { replace: [{ id: 'r', from: '#D01818', to: '#1848E0', range: 0.2, softness: 0.4, mask }] } }],
    });
    const out = f('t2.mp4');
    await renderTimeline({ timeline: tl, resolve, output: out });
    for (const t of [0.3, 1.5, 2.6]) {
      const cx = (100 + t * 120) / 640; // square centre at time t
      const [r, , b] = await pixel(out, t, cx, 240 / 360);
      expect(b).toBeGreaterThan(r + 60); // recoloured blue, following the object
    }
    const [dr, , db] = await pixel(out, 1.5, 570 / 640, 60 / 360); // the static red disc: not in the mask
    expect(dr).toBeGreaterThan(db + 80);
    const [gr, gg, gb] = await pixel(out, 1.5, 0.5, 0.1); // background untouched
    expect(gg).toBeGreaterThan(gr + 60);
    expect(gg).toBeGreaterThan(gb + 40);
  }, 180_000);

  it('Auto reframe — a 16:9 shot in a 9:16 timeline keeps the tracked subject in frame', async () => {
    const track = await trackBox(f('moving.mp4'), { atSec: 0, startSec: 0, endSec: 3, box: { x: 60 / 640, y: 200 / 360, w: 80 / 640, h: 80 / 360 } });
    const cx0 = 100 / 640;
    const cy0 = 240 / 360;
    const points = track.points.map((p) => ({ t: p.t, x: cx0 + p.dx, y: cy0 + p.dy }));
    const tl = timelineSchema.parse({ aspectRatio: '9:16', resolution: '480p', burnSubtitles: false, clips: [{ id: 'a', assetId: ID(2), inSec: 0, outSec: 3, reframe: { points } }] });
    const out = f('reframe.mp4');
    await renderTimeline({ timeline: tl, resolve, output: out });
    for (const t of [0.3, 1.5, 2.6]) {
      const [r, g] = await pixel(out, t, 0.5, 0.67); // the square stays in the middle of the vertical frame
      expect(r).toBeGreaterThan(g + 80);
    }
  }, 120_000);

  it('Test 3 — an animated Georgian title and a logo appear at their times and sizes', async () => {
    const title = layerSchema.parse({ id: 'title', kind: 'text', track: 2, startSec: 0.5, endSec: 2.5, x: 0.5, y: 0.3, w: 0.7, text: { content: 'ახალი კოლექცია', font: 'black', size: 80, color: '#FFFFFF', stroke: { color: '#000000', width: 4 } }, animIn: { type: 'pop', durationSec: 0.4 } });
    const raster = await rasterizeLayer(title, 480, f('title.png'));
    expect(raster.width).toBeGreaterThan(raster.height * 3); // a wide line of Georgian text
    const tl = timelineSchema.parse({
      aspectRatio: '16:9',
      resolution: '480p',
      burnSubtitles: false,
      clips: [{ id: 'a', assetId: ID(1), inSec: 0, outSec: 3 }],
      layers: [title, { id: 'logo', kind: 'image', track: 3, assetId: ID(4), startSec: 1, endSec: 3, x: 0.88, y: 0.12, w: 0.16 }],
    });
    const out = f('t3.mp4');
    await renderTimeline({ timeline: tl, resolve, output: out });
    // Text pixels exist inside the title box only while it is on screen.
    const brightAt = async (t: number) => {
      const raw = f(`row-${t}.rgb`);
      await ffmpeg(['-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'crop=iw*0.7:ih*0.2:iw*0.15:ih*0.2,format=rgb24', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
      const b = fs.readFileSync(raw);
      let bright = 0;
      for (let i = 0; i < b.length; i += 3) if (b[i]! > 230 && b[i + 1]! > 230 && b[i + 2]! > 230) bright++;
      return bright;
    };
    expect(await brightAt(0.2)).toBe(0);
    expect(await brightAt(1.5)).toBeGreaterThan(300);
    const [lr, lg, lb] = await pixel(out, 2, 0.88, 0.12); // yellow logo top-right after 1 s
    expect(lr).toBeGreaterThan(200);
    expect(lg).toBeGreaterThan(200);
    expect(lb).toBeLessThan(90);
    const [, , before] = await pixel(out, 0.5, 0.88, 0.12);
    expect(before).toBeGreaterThan(100); // still grey before the logo starts
  }, 180_000);

  it('Test 4 — picture-in-picture moves on its keyframes; music ducks under the voice; length and audio stay in sync', async () => {
    const tl = timelineSchema.parse({
      aspectRatio: '16:9',
      resolution: '480p',
      burnSubtitles: false,
      clips: [{ id: 'a', assetId: ID(1), inSec: 0, outSec: 3 }],
      layers: [{ id: 'pip', kind: 'video', track: 1, assetId: ID(3), startSec: 0, endSec: 3, w: 0.3, keyframes: [{ t: 0, x: 0.25, y: 0.5 }, { t: 3, x: 0.75, y: 0.5 }], easing: 'linear' }],
      audio: [
        { id: 'm', assetId: ID(5), kind: 'music', startSec: 0, inSec: 0, outSec: 3, volume: 0.8, duck: true },
        { id: 'v', assetId: ID(6), kind: 'voice', startSec: 0.5, inSec: 0, outSec: 1.5, volume: 1 },
      ],
      loudnorm: true,
    });
    const out = f('t4.mp4');
    const r = await renderTimeline({ timeline: tl, resolve, output: out });
    expect(Math.abs(r.durationSec - 3)).toBeLessThan(0.1);
    const meta = await probe(out);
    expect(meta.hasAudio).toBe(true);
    const at = async (t: number) => (await pixel(out, t, 0.25 + (0.5 * t) / 3, 0.5))[2];
    expect(await at(0.3)).toBeGreaterThan(180); // blue PiP under the moving centre
    expect(await at(2.7)).toBeGreaterThan(180);
    expect((await pixel(out, 0.3, 0.8, 0.5))[2]).toBeLessThan(160); // not yet on the right
  }, 180_000);
});
