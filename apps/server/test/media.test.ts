import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { timelineSchema } from '@framecraft/shared';
import { ffmpeg, generateFixtureClip, generatePlaceholderImage, probe, extractLastFrame, joinClips, normalizeClip } from '../src/media/ffmpeg';
import { renderTimeline } from '../src/media/render';
import { removeSolidBackground } from '../src/media/remove-bg';
import { toSrt, parseSrt, wordsToCues, scriptToCues } from '../src/media/subtitles';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-media-test-'));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const MUSIC = '33333333-3333-4333-8333-333333333333';
const LOGO = '44444444-4444-4444-8444-444444444444';
const files: Record<string, string> = {};

beforeAll(async () => {
  files[A] = path.join(dir, 'a.mp4');
  files[B] = path.join(dir, 'b.mp4');
  files[MUSIC] = path.join(dir, 'music.mp3');
  files[LOGO] = path.join(dir, 'logo.jpg');
  await generateFixtureClip(files[A]!, { width: 720, height: 1280, durationSec: 4, title: 'Clip A' });
  await generateFixtureClip(files[B]!, { width: 1280, height: 720, durationSec: 3, title: 'Clip B' });
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-c:a', 'libmp3lame', files[MUSIC]!]);
  await generatePlaceholderImage(files[LOGO]!, { width: 200, height: 200, title: 'LOGO' });
}, 120_000);

describe('FFmpeg media pipeline (real binary)', () => {
  it('renders a full timeline with transitions, music, text, subtitles and logo', async () => {
    const timeline = timelineSchema.parse({
      aspectRatio: '9:16',
      resolution: '720p',
      clips: [
        { id: 'c1', assetId: A, inSec: 0.5, outSec: 3.5, transition: { type: 'fade', durationSec: 0.6 } },
        { id: 'c2', assetId: B, inSec: 0, outSec: 2.5 },
      ],
      audio: [{ id: 'm', assetId: MUSIC, kind: 'music', startSec: 0, inSec: 0, outSec: 6, volume: 0.5, fadeOutSec: 1 }],
      texts: [{ id: 't', text: 'Hello Tbilisi — Привет — გამარჯობა', startSec: 0, endSec: 2, position: 'top' }],
      subtitles: [
        { id: 's1', startSec: 0.2, endSec: 2, text: 'First subtitle line' },
        { id: 's2', startSec: 2.2, endSec: 4.5, text: 'Second line' },
      ],
      logo: { assetId: LOGO, position: 'top-right', scale: 0.15 },
    });
    const out = path.join(dir, 'render.mp4');
    const phases: string[] = [];
    const res = await renderTimeline({ timeline, resolve: async (id) => files[id]!, output: out, onProgress: (p) => void phases.push(p) });
    const p = await probe(out);
    expect(p.width).toBe(720);
    expect(p.height).toBe(1280);
    expect(p.hasAudio).toBe(true);
    // 3s + 2.5s with a soft transition overlap, ±0.5s.
    expect(res.durationSec).toBeGreaterThan(4.5);
    expect(res.durationSec).toBeLessThan(6.1);
    expect(phases).toContain('Encoding');
  }, 180_000);

  it('normalizes, joins and extracts the last frame for segment chaining', async () => {
    const na = path.join(dir, 'na.mp4');
    const nb = path.join(dir, 'nb.mp4');
    await normalizeClip(files[A]!, na, { width: 720, height: 1280, fill: true });
    await normalizeClip(files[B]!, nb, { width: 720, height: 1280, fill: true });
    const joined = path.join(dir, 'joined.mp4');
    await joinClips([na, nb], [undefined], joined);
    expect((await probe(joined)).durationSec).toBeCloseTo(7, 0);
    const frame = path.join(dir, 'last.jpg');
    await extractLastFrame(joined, frame);
    expect(fs.statSync(frame).size).toBeGreaterThan(1000);
  }, 120_000);
});

describe('transitions keep the editor timing', () => {
  // Layers, voices and captions are placed with clipStartTimes: a soft transition overlaps the clips.
  const solid = async (name: string, c: string) => {
    const f = path.join(dir, name);
    await ffmpeg(['-y', '-f', 'lavfi', '-i', `color=c=${c}:s=320x240:r=30:d=2`, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
    return f;
  };
  const pixel = async (file: string, at: number) => {
    const raw = path.join(dir, `px-${at}.rgb`);
    await ffmpeg(['-y', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'crop=2:2:159:119,format=rgb24', '-f', 'rawvideo', raw]);
    const [r, g, b] = fs.readFileSync(raw);
    return { r: r!, g: g!, b: b! };
  };

  it('a dissolve overlaps the clips by its duration; a cut does not', async () => {
    const red = await solid('red.mp4', 'red');
    const blue = await solid('blue.mp4', 'blue');
    const green = await solid('green.mp4', 'green');
    const out = path.join(dir, 'tx.mp4');
    await joinClips([red, blue, green], [{ type: 'dissolve', durationSec: 0.6 }, { type: 'cut', durationSec: 0 }], out);
    expect((await probe(out)).durationSec).toBeCloseTo(5.4, 1); // 2 + 2 − 0.6 + 2
    const mid = await pixel(out, 1.7); // half-way through the dissolve: both colours
    expect(mid.r).toBeGreaterThan(60);
    expect(mid.b).toBeGreaterThan(60);
    const b = await pixel(out, 2.6);
    expect(b.b).toBeGreaterThan(180);
    expect(b.r).toBeLessThan(60);
    const g = await pixel(out, 3.6); // blue ends at 1.4 + 2 = 3.4, then green
    expect(g.g).toBeGreaterThan(90);
    expect(g.b).toBeLessThan(60);
  }, 120_000);

  it('a full-size 9:16 ad with five clips and mixed transitions joins (no crash on old FFmpeg builds)', async () => {
    const clips: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, `big${i}.mp4`);
      await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=3', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
      clips.push(f);
    }
    const out = path.join(dir, 'big.mp4');
    await joinClips(clips, [{ type: 'fade', durationSec: 0.6 }, { type: 'dissolve', durationSec: 0.6 }, { type: 'cut', durationSec: 0 }, { type: 'fadeblack', durationSec: 0.4 }], out);
    const m = await probe(out);
    expect([m.width, m.height]).toEqual([1080, 1920]);
    expect(m.durationSec).toBeCloseTo(15 - 0.6 - 0.6 - 0.4, 1);
    expect(m.hasAudio).toBe(true);
  }, 300_000);

  it('a fade to black dips inside the same overlap window', async () => {
    const red = await solid('red2.mp4', 'red');
    const blue = await solid('blue2.mp4', 'blue');
    const out = path.join(dir, 'tx-black.mp4');
    await joinClips([red, blue], [{ type: 'fadeblack', durationSec: 0.8 }], out);
    expect((await probe(out)).durationSec).toBeCloseTo(3.2, 1);
    const dip = await pixel(out, 1.6); // overlap 1.2–2.0: black at its middle
    expect(dip.r + dip.g + dip.b).toBeLessThan(70);
    const after = await pixel(out, 2.3);
    expect(after.b).toBeGreaterThan(180);
  }, 120_000);
});

describe('logo background removal', () => {
  it('clears the plain background but keeps light areas inside the logo', async () => {
    const src = path.join(dir, 'logo-src.png');
    const out = path.join(dir, 'logo-out.png');
    // White canvas, a purple square in the middle with a white dot inside it.
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=200x200:d=1', '-frames:v', '1', '-vf', 'drawbox=x=50:y=50:w=100:h=100:color=0x7C6CFF:t=fill,drawbox=x=90:y=90:w=20:h=20:color=white:t=fill', src]);
    await removeSolidBackground(src, out);
    const raw = path.join(dir, 'logo-out.rgba');
    await ffmpeg(['-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgba', raw]);
    const px = fs.readFileSync(raw);
    const alpha = (x: number, y: number) => px[(y * 200 + x) * 4 + 3];
    expect(alpha(5, 5)).toBe(0); // background → transparent
    expect(alpha(195, 100)).toBe(0);
    expect(alpha(70, 70)).toBe(255); // logo colour kept
    expect(alpha(100, 100)).toBe(255); // white *inside* the logo kept
  }, 60_000);
});

describe('subtitles', () => {
  it('round-trips SRT', () => {
    const srt = toSrt([{ startSec: 1.5, endSec: 3.25, text: 'Hello' }]);
    expect(srt).toContain('00:00:01,500 --> 00:00:03,250');
    expect(parseSrt(srt)[0]).toMatchObject({ startSec: 1.5, endSec: 3.25, text: 'Hello' });
  });
  it('groups transcription words into readable cues', () => {
    const words = 'one two three four five six seven eight nine ten.'.split(' ').map((t, i) => ({ text: t, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const cues = wordsToCues(words, { maxChars: 20 });
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.every((c) => c.text.length <= 20)).toBe(true);
  });
  it('times a script across the duration', () => {
    const cues = scriptToCues('Hello world. This is a test of subtitles that are timed evenly.', 0, 6);
    expect(cues[0]!.startSec).toBe(0);
    expect(cues.at(-1)!.endSec).toBeCloseTo(6, 1);
  });
});
