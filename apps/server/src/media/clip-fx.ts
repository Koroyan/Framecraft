import fsp from 'node:fs/promises';
import path from 'node:path';
import { applyReplace, buildLut, clampKeyframe, gradeFunction, gradeSchema, isNeutralGrade, lutToCube, maskIsEmpty, needsLut, piecewiseExpr, type ClipCamera, type GradeSettings, type Lut3d } from '@framecraft/shared';
import { writeMaskPgm } from './mask-raster';

/*
 * FFmpeg filters for per-clip effects. The maths comes from @framecraft/shared (gradeOf, camera
 * keyframes), the same functions the browser preview uses, so preview and export match.
 */

const n = (v: number) => (Math.round(v * 100000) / 100000).toString();

/** Piecewise expression of `T` through keyframe values (linear or smoothstep easing). */
function interp(times: number[], values: number[], easing: 'linear' | 'ease'): string {
  if (values.every((v) => Math.abs(v - values[0]!) < 1e-6)) return n(values[0]!);
  const seg = (i: number) => {
    const t0 = times[i]!;
    const t1 = times[i + 1]!;
    const u = t1 > t0 ? `((T-${n(t0)})/${n(t1 - t0)})` : '1';
    const e = easing === 'ease' ? `(${u}*${u}*(3-2*${u}))` : u;
    return `${n(values[i]!)}+${n(values[i + 1]! - values[i]!)}*${e}`;
  };
  let expr = n(values[values.length - 1]!);
  for (let i = times.length - 2; i >= 0; i--) expr = `if(lt(T,${n(times[i + 1]!)}),${seg(i)},${expr})`;
  return `if(lt(T,${n(times[0]!)}),${n(values[0]!)},${expr})`;
}

/**
 * 2D camera: a zoom/pan window keyframed over the clip, then rotation. Input must already be
 * W×H at `fps`. Prescaled 2× so slow moves don't stair-step.
 */
export function cameraFilters(cam: ClipCamera | undefined, w: number, h: number, fps: number): string[] {
  if (!cam?.keyframes.length) return [];
  const ks = [...cam.keyframes].sort((a, b) => a.t - b.t).map((k) => ({ ...k, ...clampKeyframe(k) }));
  if (ks.every((k) => k.scale === 1 && k.rotation === 0)) return [];
  const times = ks.map((k) => k.t);
  const T = (expr: string, tvar: string) => expr.replaceAll('T', tvar);
  const z = interp(times, ks.map((k) => k.scale), cam.easing);
  const x = interp(times, ks.map((k) => k.x), cam.easing);
  const y = interp(times, ks.map((k) => k.y), cam.easing);
  const tz = `(on/${fps})`;
  const out = [
    `scale=${w * 2}:${h * 2}`,
    `zoompan=z='${T(z, tz)}':x='${T(x, tz)}*iw-iw/zoom/2':y='${T(y, tz)}*ih-ih/zoom/2':d=1:s=${w}x${h}:fps=${fps}`,
  ];
  if (ks.some((k) => k.rotation !== 0)) out.push(`rotate=a='${T(interp(times, ks.map((k) => (k.rotation * Math.PI) / 180), cam.easing), 't')}':fillcolor=black`);
  return out;
}

/**
 * Colour grade as FFmpeg filters: the per-pixel colour transform is baked into a 3D LUT (same
 * function as the preview), spatial effects follow. Masked colour replacements are composited only
 * inside their (optionally tracked) mask. Files are written to `dir`; the filters reference them by
 * relative name, so FFmpeg must run with `cwd = dir`.
 */
export async function lookFilters(
  adjust: Partial<GradeSettings> | undefined,
  o: { dir: string; key: string; width: number; height: number; fps: number; durationSec: number; srcWidth: number; srcHeight: number; inSec: number; speed: number; customLut?: Lut3d | null },
): Promise<string[]> {
  if (isNeutralGrade(adjust)) return [];
  const g = gradeSchema.parse(adjust ?? {});
  const out: string[] = [];
  if (needsLut(g) || (g.lut && o.customLut)) {
    const file = `${o.key}-grade.cube`;
    await fsp.writeFile(path.join(o.dir, file), lutToCube(buildLut(gradeFunction(g, o.customLut ?? null), 33)));
    out.push(`lut3d=file=${file}:interp=trilinear`);
  }
  // Masked colour replacements (e.g. only the jacket), in source-normalised mask coordinates.
  const masked = (g.replace ?? []).filter((r) => r.mask && !maskIsEmpty(r.mask));
  for (let i = 0; i < masked.length; i++) {
    const rep = masked[i]!;
    const k = Math.max(o.width / o.srcWidth, o.height / o.srcHeight);
    const sw = Math.round((o.srcWidth * k) / 2) * 2;
    const sh = Math.round((o.srcHeight * k) / 2) * 2;
    const offX = Math.round((sw - o.width) / 2);
    const offY = Math.round((sh - o.height) / 2);
    const cube = `${o.key}-rep${i}.cube`;
    await fsp.writeFile(path.join(o.dir, cube), lutToCube(buildLut((px) => applyReplace({ ...rep, mask: undefined }, px), 33)));
    const mw = Math.min(640, sw);
    const mh = Math.max(2, Math.round((sh * mw) / sw / 2) * 2);
    const maskFile = `${o.key}-mask${i}.pgm`;
    await writeMaskPgm(rep.mask!, mw, mh, path.join(o.dir, maskFile));
    const pts = rep.mask!.track?.points ?? [];
    // Mask clock = source seconds: inSec + t·speed for the normalised clip's time t.
    const src = `(${n(o.inSec)}+t*${n(o.speed)})`;
    const dx = pts.length ? piecewiseExpr(pts.map((p) => p.t), pts.map((p) => p.dx), 'linear').replaceAll('T', src) : '0';
    const dy = pts.length ? piecewiseExpr(pts.map((p) => p.t), pts.map((p) => p.dy), 'linear').replaceAll('T', src) : '0';
    const sigma = Math.max(0.5, (rep.mask!.feather ?? 0.015) * o.width);
    out.push(
      `split[rb${i}][rs${i}];` +
        `[rs${i}]lut3d=file=${cube}:interp=trilinear[rc${i}];` +
        `color=c=black:s=${sw}x${sh}:r=${o.fps},format=gray,trim=duration=${n(o.durationSec + 0.5)}[rbg${i}];` +
        `movie=${maskFile},format=gray,scale=${sw}:${sh}[rmk${i}];` +
        `[rbg${i}][rmk${i}]overlay=x='(${dx})*${sw}':y='(${dy})*${sh}':eof_action=repeat,crop=${o.width}:${o.height}:${offX}:${offY},gblur=sigma=${n(sigma)}[rm${i}];` +
        `[rc${i}][rm${i}]alphamerge[ra${i}];` +
        `[rb${i}][ra${i}]overlay=format=auto:shortest=1,format=yuv420p`,
    );
  }
  if (g.blur > 0) out.push(`gblur=sigma=${n((g.blur * o.height) / 1080)}`);
  if (g.sharpen > 0) out.push(`unsharp=5:5:${n(g.sharpen)}:5:5:0`);
  if (g.glow > 0) out.push(`format=gbrp,split[gl0][gl1];[gl1]gblur=sigma=${n(o.height / 45)}[gl2];[gl0][gl2]blend=all_mode=screen:all_opacity=${n(g.glow * 0.6)},format=yuv420p`);
  if (g.vignette > 0) out.push(`vignette=angle=${n(0.15 + g.vignette * 0.75)}`);
  if (g.grain > 0) out.push(`noise=alls=${Math.round(g.grain * 40)}:allf=t`);
  return out;
}

/** atempo only accepts 0.5–2 per stage: chain stages for 0.25–4×. */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${n(s)}`);
  return out;
}
