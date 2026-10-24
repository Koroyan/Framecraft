import { clampKeyframe, gradeOf, isNeutralAdjust, type ClipAdjust, type ClipCamera } from '@framecraft/shared';

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

/** Colour grade: matrix → linear contrast/brightness → tone curve → blur/sharpen/vignette. */
export function gradeFilters(adjust: Partial<ClipAdjust> | undefined, outHeight: number): string[] {
  if (isNeutralAdjust(adjust)) return [];
  const g = gradeOf(adjust);
  const m = g.matrix;
  const out: string[] = [];
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1].every((v, i) => Math.abs(v - m[i]!) < 1e-4);
  if (!identity) out.push(`colorchannelmixer=rr=${n(m[0]!)}:rg=${n(m[1]!)}:rb=${n(m[2]!)}:gr=${n(m[3]!)}:gg=${n(m[4]!)}:gb=${n(m[5]!)}:br=${n(m[6]!)}:bg=${n(m[7]!)}:bb=${n(m[8]!)}`);
  if (g.slope !== 1 || g.intercept !== 0 || g.curve) {
    const lin = `clip(val/255*${n(g.slope)}+${n(g.intercept)},0,1)`;
    let v = lin;
    if (g.curve) {
      const c = g.curve;
      const L = 'L';
      const piece = (i: number) => `${n(c[i]!)}+(${L}*4-${i})*${n(c[i + 1]! - c[i]!)}`;
      v = `if(lt(${L},0.25),${piece(0)},if(lt(${L},0.5),${piece(1)},if(lt(${L},0.75),${piece(2)},${piece(3)})))`.replaceAll(L, lin);
    }
    const e = `clip(${v}*255,0,255)`;
    out.push(`lutrgb=r='${e}':g='${e}':b='${e}'`);
  }
  if (g.blur > 0) out.push(`gblur=sigma=${n((g.blur * outHeight) / 1080)}`);
  if (g.sharpen > 0) out.push(`unsharp=5:5:${n(g.sharpen)}:5:5:0`);
  if (g.vignette > 0) out.push(`vignette=angle=${n(0.15 + g.vignette * 0.75)}`);
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
