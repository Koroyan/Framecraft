import fsp from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, probe, withWorkdir } from './ffmpeg';

/**
 * Make a logo's plain background transparent — locally, no AI service, no cost.
 *
 * The background colour is sampled from the image border, then a flood fill from the
 * edges clears only pixels *connected to the border* that match it. Light or white
 * areas inside the logo are kept (a global colour-key would punch holes in them).
 * Pixels close to the threshold get partial alpha for smooth, anti-aliased edges.
 */
export async function removeSolidBackground(input: string, output: string, opts: { tolerance?: number; maxSize?: number } = {}) {
  const tolerance = opts.tolerance ?? 0.12; // fraction of the max RGB distance
  const maxSize = opts.maxSize ?? 1024;
  const p = await probe(input);
  if (!p.width || !p.height) throw new Error('Not an image');
  const scale = Math.min(1, maxSize / Math.max(p.width, p.height));
  const w = Math.max(1, Math.round(p.width * scale));
  const h = Math.max(1, Math.round(p.height * scale));

  await withWorkdir(async (dir) => {
    const raw = path.join(dir, 'in.rgba');
    await ffmpeg(['-i', input, '-vf', `scale=${w}:${h}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', raw]);
    const px = await fsp.readFile(raw);
    if (px.length !== w * h * 4) throw new Error('Unexpected image data');

    // Background colour = median of the border pixels (robust to a few logo pixels touching the edge).
    const border: number[][] = [];
    for (let x = 0; x < w; x++) border.push(rgb(px, x, 0, w), rgb(px, x, h - 1, w));
    for (let y = 0; y < h; y++) border.push(rgb(px, 0, y, w), rgb(px, w - 1, y, w));
    const bg = [0, 1, 2].map((c) => median(border.map((b) => b[c]!)));

    const maxDist = Math.sqrt(3) * 255;
    const hard = tolerance * maxDist; // fully transparent below this distance
    const soft = hard * 1.8; // partially transparent up to here (edge smoothing)
    const dist = (i: number) => Math.hypot(px[i]! - bg[0]!, px[i + 1]! - bg[1]!, px[i + 2]! - bg[2]!);

    const seen = new Uint8Array(w * h);
    const stack: number[] = [];
    const push = (x: number, y: number) => {
      const k = y * w + x;
      if (!seen[k]) {
        seen[k] = 1;
        stack.push(k);
      }
    };
    for (let x = 0; x < w; x++) {
      push(x, 0);
      push(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      push(0, y);
      push(w - 1, y);
    }

    let cleared = 0;
    while (stack.length) {
      const k = stack.pop()!;
      const i = k * 4;
      const d = dist(i);
      if (d > soft) continue; // part of the logo: stop the fill here
      if (d <= hard) {
        px[i + 3] = 0;
        cleared++;
      } else {
        // Edge pixel: fade alpha with distance, and stop spreading through it.
        px[i + 3] = Math.round(px[i + 3]! * ((d - hard) / (soft - hard)));
        continue;
      }
      const x = k % w;
      const y = (k - x) / w;
      if (x > 0) push(x - 1, y);
      if (x < w - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < h - 1) push(x, y + 1);
    }

    await fsp.writeFile(raw, px);
    await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', raw, '-frames:v', '1', '-pix_fmt', 'rgba', path.join(dir, 'out.png')]);
    await fsp.copyFile(path.join(dir, 'out.png'), output);
    return { cleared, total: w * h };
  });
}

function rgb(px: Buffer, x: number, y: number, w: number) {
  const i = (y * w + x) * 4;
  return [px[i]!, px[i + 1]!, px[i + 2]!];
}

function median(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
