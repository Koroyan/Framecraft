import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { snapClipsToBeats } from '@framecraft/shared';
import { ffmpeg } from '../src/media/ffmpeg';
import { detectBeats } from '../src/media/beats';

/* Beat detection on a synthetic 120 BPM track, and snapping clip cuts to it (real FFmpeg). */
const file = path.join(os.tmpdir(), `fc-beats-${process.pid}.wav`);
beforeAll(async () => {
  // A 60 Hz kick-like thump every 0.5 s over a quiet pad: 120 BPM.
  await ffmpeg(['-f', 'lavfi', '-i', "aevalsrc='0.9*sin(2*PI*60*t)*exp(-30*mod(t,0.5))+0.05*sin(2*PI*440*t)':s=22050:d=12", file]);
}, 60_000);

describe('beats', () => {
  it('finds the tempo and a grid of beats', async () => {
    const b = await detectBeats(file);
    expect(Math.abs(b.bpm - 120)).toBeLessThanOrEqual(3);
    expect(b.beats.length).toBeGreaterThan(18);
    const gaps = b.beats.slice(1).map((t, i) => t - b.beats[i]!);
    expect(Math.abs(gaps.reduce((s, g) => s + g, 0) / gaps.length - 0.5)).toBeLessThan(0.03);
    const off = b.beats[0]! % 0.5;
    expect(Math.min(off, 0.5 - off)).toBeLessThan(0.04); // phase-aligned to the thumps
    fs.rmSync(file, { force: true });
  });

  it('snaps clip lengths so every cut lands on a beat', () => {
    const beats = Array.from({ length: 30 }, (_, i) => i * 0.5);
    const lens = snapClipsToBeats([{ lengthSec: 1.3, maxSec: 5 }, { lengthSec: 2.2, maxSec: 5 }, { lengthSec: 0.9, maxSec: 0.8 }], beats, 0);
    let t = 0;
    for (const [i, l] of lens.entries()) {
      t += l;
      if (i < 2) expect(Math.abs(t / 0.5 - Math.round(t / 0.5))).toBeLessThan(0.01);
    }
    expect(lens[2]).toBeLessThanOrEqual(0.8); // never longer than the source
  });
});
