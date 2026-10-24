import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { cameraPreset, timelineSchema } from '@framecraft/shared';
import { ffmpeg, probe } from '../src/media/ffmpeg';
import { renderTimeline } from '../src/media/render';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-fx-'));
const file = (name: string) => path.join(dir, name);
const ids = { red: '00000000-0000-4000-8000-0000000000a1', split: '00000000-0000-4000-8000-0000000000a2', green: '00000000-0000-4000-8000-0000000000a3' };

/** RGB of one pixel of the frame at `t` (x, y as fractions). */
async function pixel(video: string, t: number, x: number, y: number): Promise<[number, number, number]> {
  const p = await probe(video);
  const out = file(`px-${Math.random().toString(36).slice(2)}.rgb`);
  await ffmpeg(['-ss', String(t), '-i', video, '-frames:v', '1', '-vf', `crop=2:2:${Math.floor(((p.width ?? 4) - 2) * x / 2) * 2}:${Math.floor(((p.height ?? 4) - 2) * y / 2) * 2},format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', out]);
  const b = fs.readFileSync(out);
  return [b[0]!, b[1]!, b[2]!];
}

beforeAll(async () => {
  // Solid red with a tone; left-red/right-blue split; a green image for the overlay track.
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=360x640:d=4:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file('red.mp4')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=360x640:d=4:r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=180x640:d=4:r=30', '-filter_complex', '[0:v][1:v]overlay=x=180:y=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file('split.mp4')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x00FF00:s=200x200', '-frames:v', '1', file('green.png')]);
}, 120_000);

const resolve = async (id: string) => ({ [ids.red]: file('red.mp4'), [ids.split]: file('split.mp4'), [ids.green]: file('green.png') })[id]!;

describe('timeline effects are rendered into the export', () => {
  it('speed, freeze frame and reverse give the timeline length; grade, camera and overlay show in the pixels', async () => {
    const timeline = timelineSchema.parse({
      aspectRatio: '9:16',
      resolution: '480p',
      fps: 30,
      burnSubtitles: false,
      clips: [
        // 4 s at 2× = 2 s, desaturated to grey.
        { id: 'a', assetId: ids.red, inSec: 0, outSec: 4, speed: 2, adjust: { saturation: -1 } },
        // Freeze frame held 1.5 s.
        { id: 'b', assetId: ids.red, inSec: 1, outSec: 4, freezeSec: 1.5 },
        // Reversed, camera zoomed 2× on the right (blue) half.
        { id: 'c', assetId: ids.split, inSec: 0, outSec: 4, reverse: true, camera: { keyframes: [{ t: 0, x: 0.75, y: 0.5, scale: 2 }], easing: 'linear' } },
      ],
      overlays: [{ id: 'o', assetId: ids.green, startSec: 0.5, endSec: 1.5, x: 0, y: 0, w: 0.4, opacity: 1 }],
      audio: [{ id: 'm', assetId: ids.red, startSec: 0, inSec: 0, outSec: 4, muted: true }],
    });
    const out = file('out.mp4');
    const r = await renderTimeline({ timeline, resolve, output: out });
    expect(r.durationSec).toBeGreaterThan(7.3);
    expect(r.durationSec).toBeLessThan(7.7);

    const [gr, gg, gb] = await pixel(out, 1.0, 0.8, 0.8); // graded clip, outside the overlay
    expect(Math.max(Math.abs(gr - gg), Math.abs(gg - gb))).toBeLessThan(12); // grey, not red
    const [or, og] = await pixel(out, 1.0, 0.1, 0.05); // overlay visible
    expect(og).toBeGreaterThan(200);
    expect(or).toBeLessThan(60);
    const [fr, , fb] = await pixel(out, 2.8, 0.5, 0.5); // freeze frame: original red
    expect(fr).toBeGreaterThan(200);
    expect(fb).toBeLessThan(60);
    const [cr, , cb] = await pixel(out, 5.5, 0.05, 0.5); // zoomed into the blue half: even the left edge is blue
    expect(cb).toBeGreaterThan(200);
    expect(cr).toBeLessThan(60);
  }, 180_000);

  it('camera presets render without changing the clip length', async () => {
    const timeline = timelineSchema.parse({ aspectRatio: '9:16', resolution: '480p', burnSubtitles: false, clips: [{ id: 'a', assetId: ids.split, inSec: 0, outSec: 3, camera: cameraPreset('pan_right', 3, 0.8), fadeInSec: 0.5, fadeOutSec: 0.5 }] });
    const out = file('pan.mp4');
    const r = await renderTimeline({ timeline, resolve, output: out });
    expect(r.durationSec).toBeGreaterThan(2.85);
    expect(r.durationSec).toBeLessThan(3.15);
    // Pan right: the window starts on the red side and ends on the blue side.
    expect((await pixel(out, 0.6, 0.5, 0.5))[0]).toBeGreaterThan(150);
    expect((await pixel(out, 2.3, 0.5, 0.5))[2]).toBeGreaterThan(150);
  }, 120_000);
});
