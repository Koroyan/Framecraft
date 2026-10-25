import fsp from 'node:fs/promises';
import path from 'node:path';
import { layerExpressions, rasterHash, type Timeline } from '@framecraft/shared';
import { probe } from './ffmpeg';
import { rasterizeLayer } from './raster';

/*
 * Composite timeline layers (picture-in-picture, images, text, shapes) over the main picture.
 * Positions, scale, rotation and reveal come from @framecraft/shared layerExpressions — the same
 * definitions the preview evaluates with layerStateAt.
 */

const n = (v: number) => (Math.round(v * 100000) / 100000).toString();
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
const hex = (c: string) => `0x${c.slice(1)}`;

export async function layerFilters(p: {
  timeline: Timeline;
  width: number;
  height: number;
  dir: string;
  inputIndex: number;
  videoIn: string;
  resolve: (assetId: string) => Promise<string>;
}): Promise<{ args: string[]; filters: string[]; videoOut: string; inputIndex: number }> {
  const hidden = new Set(p.timeline.tracks.filter((t) => t.hidden).map((t) => t.index));
  const layers = [...p.timeline.layers].filter((l) => !hidden.has(l.track) && l.endSec > l.startSec).sort((a, b) => a.track - b.track || a.startSec - b.startSec);
  const args: string[] = [];
  const filters: string[] = [];
  let videoOut = p.videoIn;
  let idx = p.inputIndex;
  const rasters = new Map<string, { file: string; width: number; height: number; rows: number }>();

  for (let i = 0; i < layers.length; i++) {
    const L = layers[i]!;
    const len = L.endSec - L.startSec;
    let local: string;
    let srcW: number;
    let srcH: number;
    let rows = 1;
    if (L.kind === 'text' || L.kind === 'shape') {
      const key = rasterHash(L);
      let r = rasters.get(key);
      if (!r) {
        r = await rasterizeLayer(L, p.height, path.join(p.dir, `layer-${key}.png`));
        rasters.set(key, r);
      }
      local = path.basename(r.file);
      srcW = r.width;
      srcH = r.height;
      rows = r.rows;
      args.push('-loop', '1', '-t', n(len), '-i', local);
    } else {
      if (!L.assetId) continue;
      const src = await p.resolve(L.assetId);
      local = `layer${i}${path.extname(src) || (L.kind === 'image' ? '.png' : '.mp4')}`;
      await fsp.copyFile(src, path.join(p.dir, local));
      const meta = await probe(src);
      srcW = meta.width ?? 1280;
      srcH = meta.height ?? 720;
      if (L.kind === 'image') args.push('-loop', '1', '-t', n(len), '-i', local);
      else args.push('-ss', n(L.inSec), '-t', n(len), '-i', local);
    }
    const ex = layerExpressions(L);
    const at = (expr: string) => expr.replaceAll('T', `(${n(L.startSec)}+t)`); // inside the layer's own stream
    const chain: string[] = ['format=rgba'];
    const c = L.crop;
    let aspect = srcW / (srcH / rows);
    if (rows > 1) chain.push(`crop=iw:ih/${rows}:0:'(ih/${rows})*(${at(ex.row)})'`);
    if (c && (c.l || c.t || c.r || c.b)) {
      chain.push(`crop=iw*${n(1 - c.l - c.r)}:ih*${n(1 - c.t - c.b)}:iw*${n(c.l)}:ih*${n(c.t)}`);
      aspect = (aspect * (1 - c.l - c.r)) / (1 - c.t - c.b);
    }
    if (L.chromaKey) chain.push('format=yuva420p', `chromakey=${hex(L.chromaKey.color)}:${n(L.chromaKey.similarity)}:${n(L.chromaKey.blend)}`, 'format=rgba');
    chain.push(`fps=${p.timeline.fps}`);
    if (ex.animated || ex.scaleMin !== ex.scaleMax) {
      // Animated scale: render at the largest size, pad, then zoom in from the smallest (zoompan ≥ 1).
      const K = Math.max(1.0001, ex.scaleMax / ex.scaleMin);
      const bw = even(L.w * p.width * ex.scaleMax);
      const bh = even(bw / aspect);
      chain.push(`scale=${bw}:${bh}`, `pad=${even(bw * K)}:${even(bh * K)}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
      chain.push(`zoompan=z='(${ex.scale.replaceAll('T', `(${n(L.startSec)}+on/${p.timeline.fps})`)})/${n(ex.scaleMin)}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${bw}x${bh}:fps=${p.timeline.fps}`, 'format=rgba');
    } else {
      const s = ex.scaleMax;
      const bw = even(L.w * p.width * s);
      chain.push(`scale=${bw}:${even(bw / aspect)}`);
    }
    if (L.flipH) chain.push('hflip');
    if (L.flipV) chain.push('vflip');
    if (ex.rotation !== '0') chain.push(`rotate=a='${at(ex.rotation)}':c=none:ow='hypot(iw,ih)':oh='ow'`);
    if (L.opacity < 1) chain.push(`colorchannelmixer=aa=${n(L.opacity)}`);
    for (const f of ex.fades) chain.push(`fade=t=${f.dir}:st=${n(Math.max(0, f.start - L.startSec))}:d=${n(f.dur)}:alpha=1`);
    chain.push(`setpts=PTS-STARTPTS+${n(L.startSec)}/TB`);
    filters.push(`[${idx}:v]${chain.join(',')}[ly${i}]`);
    const X = ex.x.replaceAll('T', 't');
    const Y = ex.y.replaceAll('T', 't');
    filters.push(`${videoOut}[ly${i}]overlay=x='(${X})*W-w/2':y='(${Y})*H-h/2':enable='between(t,${n(L.startSec)},${n(L.endSec)})':eof_action=pass:format=auto[vly${i}]`);
    videoOut = `[vly${i}]`;
    idx++;
  }
  return { args, filters, videoOut, inputIndex: idx };
}
