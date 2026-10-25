import path from 'node:path';
import { fitToProviderLimits } from '../media/prepare';
import { piecewiseExpr, type EditMask } from '@framecraft/shared';
import { ffmpeg, probe } from '../media/ffmpeg';
import { writeMaskPgm } from '../media/mask-raster';

/*
 * Localized editing primitives (FFmpeg only, no AI): cut the edit window out of a shot, rasterise a
 * spatial selection, and put an edited window back so that everything outside the selected time
 * range — and outside the mask — is the original footage, pixel for pixel, with the original audio.
 */

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/**
 * Extract [startSec, endSec) as a silent H.264 clip small enough for an inline provider upload
 * (at most `maxBytes`).
 */
export async function extractWindow(src: string, output: string, o: { startSec: number; endSec: number; maxBytes: number; maxSide?: number }): Promise<{ width: number; height: number; bytes: number }> {
  // Bitrate from the byte budget, resolution from the bitrate (see media/prepare.ts).
  const durationSec = Math.max(0.1, o.endSec - o.startSec);
  const r = await fitToProviderLimits(src, output, { maxBytes: o.maxBytes, maxDurationSec: durationSec, maxLongSide: o.maxSide ?? 1280, audio: false }, { startSec: o.startSec, durationSec }).catch(() => {
    throw new Error('The selected part of the shot is too large to send for editing; select a shorter time range.');
  });
  return { width: r.width, height: r.height, bytes: r.bytes };
}

export { writeMaskPgm } from '../media/mask-raster';

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
    const pts = o.mask.track?.points ?? [];
    if (pts.length) {
      // The selection follows the tracked object: move the mask over black, on source time rs + t.
      const src = `(${rs}+t)`;
      const dx = piecewiseExpr(pts.map((p) => p.t), pts.map((p) => p.dx), 'linear').replaceAll('T', src);
      const dy = piecewiseExpr(pts.map((p) => p.t), pts.map((p) => p.dy), 'linear').replaceAll('T', src);
      f.push(`color=c=black:s=${W}x${H}:r=${fps},format=gray,trim=duration=${re - rs}[mbg]`);
      f.push(`[2:v]scale=${W}:${H},format=gray[mshape]`);
      f.push(`[mbg][mshape]overlay=x='(${dx})*${W}':y='(${dy})*${H}':eof_action=repeat,gblur=sigma=${sigma.toFixed(2)},setpts=PTS-STARTPTS[mk]`);
    } else f.push(`[2:v]scale=${W}:${H},format=gray,gblur=sigma=${sigma.toFixed(2)},fps=${fps},trim=duration=${re - rs},setpts=PTS-STARTPTS[mk]`);
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
