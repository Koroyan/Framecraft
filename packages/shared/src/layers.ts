import { z } from 'zod';

/*
 * Layers above the main track: picture-in-picture video, images, text, shapes and stickers, each
 * with a transform, keyframes, in/out animations and optional object tracking. `layerStateAt` (the
 * preview) and `layerExpressions` (FFmpeg) are generated from the same definitions.
 */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Motion of a tracked object: offsets (fractions of the frame) from where the selection was made. */
export const motionTrackSchema = z.object({
  /** Seconds on the clock of the thing being tracked (source time for shot masks, timeline time for layers). */
  points: z.array(z.object({ t: z.number().min(0), dx: z.number().min(-1).max(1), dy: z.number().min(-1).max(1), conf: z.number().min(0).max(1).optional() })).min(1).max(2000),
  smoothing: z.number().min(0).max(1).default(0.3),
});
export type MotionTrack = z.infer<typeof motionTrackSchema>;

export const LAYER_ANIMS = ['none', 'fade', 'pop', 'slide_up', 'slide_down', 'slide_left', 'slide_right', 'zoom', 'typewriter', 'words'] as const;
export type LayerAnim = (typeof LAYER_ANIMS)[number];
export const layerAnimSchema = z.object({ type: z.enum(LAYER_ANIMS).default('none'), durationSec: z.number().min(0.05).max(6).default(0.4) });

export const layerKeyframeSchema = z.object({
  /** Seconds from the layer's start. */
  t: z.number().min(0).max(3600),
  x: z.number().min(-0.5).max(1.5),
  y: z.number().min(-0.5).max(1.5),
  scale: z.number().min(0.05).max(6).default(1),
  rotation: z.number().min(-360).max(360).default(0),
});
export type LayerKeyframe = z.infer<typeof layerKeyframeSchema>;

export const TEXT_FONTS = ['sans', 'semibold', 'bold', 'black', 'serif', 'mono'] as const;
export const textStyleSchema = z.object({
  content: z.string().min(1).max(500),
  font: z.enum(TEXT_FONTS).default('bold'),
  /** Pixel size at 1080 px frame height. */
  size: z.number().int().min(10).max(300).default(72),
  color: hex.default('#FFFFFF'),
  gradientTo: hex.optional(),
  stroke: z.object({ color: hex.default('#000000'), width: z.number().min(0).max(20).default(0) }).optional(),
  shadow: z.object({ color: hex.default('#000000'), opacity: z.number().min(0).max(1).default(0.6), offset: z.number().min(0).max(20).default(4) }).optional(),
  background: z.object({ color: hex.default('#000000'), opacity: z.number().min(0).max(1).default(0.6), padding: z.number().min(0).max(80).default(18) }).optional(),
  align: z.enum(['left', 'center', 'right']).default('center'),
});
export type TextStyle = z.infer<typeof textStyleSchema>;

export const SHAPES = ['rect', 'pill', 'ellipse', 'bubble', 'arrow', 'burst'] as const;
export const shapeStyleSchema = z.object({
  type: z.enum(SHAPES).default('pill'),
  fill: hex.default('#7C5CFF'),
  opacity: z.number().min(0).max(1).default(1),
  /** Width / height. */
  aspect: z.number().min(0.2).max(8).default(2.6),
  label: z.string().max(80).optional(),
  labelColor: hex.default('#FFFFFF'),
});
export type ShapeStyle = z.infer<typeof shapeStyleSchema>;

export const layerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(80).optional(),
  kind: z.enum(['video', 'image', 'text', 'shape']),
  /** Track above the main picture (1 = just above V1). Higher tracks draw on top. */
  track: z.number().int().min(1).max(10).default(1),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  assetId: z.string().uuid().optional(),
  /** Source offset for video layers. */
  inSec: z.number().min(0).default(0),
  volume: z.number().min(0).max(2).default(0),
  text: textStyleSchema.optional(),
  shape: shapeStyleSchema.optional(),
  /** Centre position and width as fractions of the frame. */
  x: z.number().min(-0.5).max(1.5).default(0.5),
  y: z.number().min(-0.5).max(1.5).default(0.5),
  w: z.number().min(0.02).max(3).default(0.4),
  rotation: z.number().min(-360).max(360).default(0),
  opacity: z.number().min(0).max(1).default(1),
  flipH: z.boolean().default(false),
  flipV: z.boolean().default(false),
  crop: z.object({ l: z.number().min(0).max(0.9).default(0), t: z.number().min(0).max(0.9).default(0), r: z.number().min(0).max(0.9).default(0), b: z.number().min(0).max(0.9).default(0) }).optional(),
  chromaKey: z.object({ color: hex.default('#00FF00'), similarity: z.number().min(0.01).max(0.6).default(0.15), blend: z.number().min(0).max(0.5).default(0.05) }).optional(),
  keyframes: z.array(layerKeyframeSchema).max(24).default([]),
  easing: z.enum(['ease', 'linear']).default('ease'),
  animIn: layerAnimSchema.default({ type: 'none', durationSec: 0.4 }),
  animOut: layerAnimSchema.default({ type: 'none', durationSec: 0.4 }),
  /** Follow a tracked object (timeline-time offsets). */
  follow: motionTrackSchema.optional(),
  /** Server-rendered picture of a text/shape layer (what both the preview and the export show). */
  raster: z.object({ assetId: z.string().uuid(), hash: z.string().max(64), width: z.number().int().positive(), height: z.number().int().positive(), rows: z.number().int().min(1).max(200).default(1) }).optional(),
});
export type Layer = z.infer<typeof layerSchema>;
export type LayerInput = z.input<typeof layerSchema>;

export const trackMetaSchema = z.object({ index: z.number().int().min(1).max(10), name: z.string().max(40).optional(), locked: z.boolean().default(false), hidden: z.boolean().default(false) });

// ------------------------------------------------------------------ animation maths (preview)

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (u: number) => u * u * (3 - 2 * u);
const easeOut = (p: number) => 1 - (1 - p) ** 3;
const C1 = 1.70158;
const backOut = (p: number) => 1 + (C1 + 1) * (p - 1) ** 3 + C1 * (p - 1) ** 2;

/** Number of reveal steps for typewriter / word animations (one sprite row each). */
export function revealUnits(layer: Pick<Layer, 'kind' | 'text' | 'animIn'>): string[] | null {
  if (layer.kind !== 'text' || !layer.text) return null;
  if (layer.animIn.type === 'typewriter') {
    const chars = Array.from(layer.text.content);
    const step = Math.max(1, Math.ceil(chars.length / 60));
    const out: string[] = [];
    for (let i = step; i < chars.length; i += step) out.push(chars.slice(0, i).join(''));
    out.push(layer.text.content);
    return out;
  }
  if (layer.animIn.type === 'words') {
    const words = layer.text.content.split(/(\s+)/);
    const out: string[] = [];
    for (let i = 1; i <= words.length; i += 2) out.push(words.slice(0, i).join(''));
    return out.slice(0, 60);
  }
  return null;
}

function trackAt(track: MotionTrack | undefined, t: number) {
  if (!track?.points.length) return { dx: 0, dy: 0 };
  const p = track.points;
  if (t <= p[0]!.t) return { dx: p[0]!.dx, dy: p[0]!.dy };
  for (let i = 0; i < p.length - 1; i++) {
    if (t <= p[i + 1]!.t) {
      const u = (t - p[i]!.t) / Math.max(1e-6, p[i + 1]!.t - p[i]!.t);
      return { dx: p[i]!.dx + (p[i + 1]!.dx - p[i]!.dx) * u, dy: p[i]!.dy + (p[i + 1]!.dy - p[i]!.dy) * u };
    }
  }
  return { dx: p[p.length - 1]!.dx, dy: p[p.length - 1]!.dy };
}
export { trackAt as motionAt };

function keyAt(layer: Layer, local: number) {
  const ks = [...layer.keyframes].sort((a, b) => a.t - b.t);
  const base = { x: layer.x, y: layer.y, scale: 1, rotation: layer.rotation };
  if (!ks.length) return base;
  if (local <= ks[0]!.t) return { x: ks[0]!.x, y: ks[0]!.y, scale: ks[0]!.scale, rotation: ks[0]!.rotation };
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]!;
    const b = ks[i + 1]!;
    if (local <= b.t) {
      const raw = (local - a.t) / Math.max(1e-6, b.t - a.t);
      const u = layer.easing === 'linear' ? raw : smooth(raw);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, scale: a.scale + (b.scale - a.scale) * u, rotation: a.rotation + (b.rotation - a.rotation) * u };
    }
  }
  const z = ks[ks.length - 1]!;
  return { x: z.x, y: z.y, scale: z.scale, rotation: z.rotation };
}

export type LayerState = { visible: boolean; x: number; y: number; scale: number; rotation: number; opacity: number; row: number };

/** Where and how a layer is drawn at timeline time `t`. */
export function layerStateAt(layer: Layer, t: number): LayerState {
  const len = layer.endSec - layer.startSec;
  const local = t - layer.startSec;
  if (local < 0 || local > len) return { visible: false, x: layer.x, y: layer.y, scale: 1, rotation: layer.rotation, opacity: 0, row: 0 };
  const k0 = keyAt(layer, local);
  let { x, y, scale } = k0;
  const rotation = k0.rotation;
  let opacity = layer.opacity;
  let row = 0;
  const ai = layer.animIn;
  const ao = layer.animOut;
  const p = ai.type === 'none' ? 1 : clamp01(local / ai.durationSec);
  const q = ao.type === 'none' ? 1 : clamp01((len - local) / ao.durationSec);
  const apply = (type: LayerAnim, k: number, out: boolean) => {
    switch (type) {
      case 'fade':
        opacity *= k;
        break;
      case 'pop':
        scale *= 0.6 + 0.4 * backOut(k);
        opacity *= Math.min(1, k * 2);
        break;
      case 'slide_up':
        y += (1 - easeOut(k)) * (out ? -0.08 : 0.08);
        opacity *= k;
        break;
      case 'slide_down':
        y += (1 - easeOut(k)) * (out ? 0.08 : -0.08);
        opacity *= k;
        break;
      case 'slide_left':
        x += (1 - easeOut(k)) * (out ? -0.12 : 0.12);
        opacity *= k;
        break;
      case 'slide_right':
        x += (1 - easeOut(k)) * (out ? 0.12 : -0.12);
        opacity *= k;
        break;
      case 'zoom':
        scale *= 1.3 - 0.3 * easeOut(k);
        opacity *= k;
        break;
      default:
        break;
    }
  };
  apply(ai.type, p, false);
  apply(ao.type, q, true);
  const units = revealUnits(layer);
  if (units) row = Math.min(units.length - 1, Math.floor(clamp01(local / ai.durationSec) * units.length));
  const f = trackAt(layer.follow, t);
  return { visible: true, x: x + f.dx, y: y + f.dy, scale, rotation, opacity: clamp01(opacity), row };
}

// ------------------------------------------------------------------ the same maths as FFmpeg expressions

const n = (v: number) => (Math.round(v * 100000) / 100000).toString();

/** Piecewise interpolation of values over times as an FFmpeg expression in variable `T`. */
export function piecewiseExpr(times: number[], values: number[], easing: 'linear' | 'ease'): string {
  if (!values.length) return '0';
  if (values.every((v) => Math.abs(v - values[0]!) < 1e-6)) return n(values[0]!);
  const seg = (i: number) => {
    const u = `((T-${n(times[i]!)})/${n(Math.max(1e-6, times[i + 1]! - times[i]!))})`;
    const e = easing === 'ease' ? `(${u}*${u}*(3-2*${u}))` : u;
    return `${n(values[i]!)}+${n(values[i + 1]! - values[i]!)}*${e}`;
  };
  let expr = n(values[values.length - 1]!);
  for (let i = times.length - 2; i >= 0; i--) expr = `if(lt(T,${n(times[i + 1]!)}),${seg(i)},${expr})`;
  return `if(lt(T,${n(times[0]!)}),${n(values[0]!)},${expr})`;
}

/**
 * FFmpeg expressions (in timeline seconds `T`) for a layer's centre x/y (fractions), scale multiplier,
 * rotation (radians) and reveal row. Opacity ramps are emitted as fade ranges (linear, like the preview).
 */
export function layerExpressions(layer: Layer) {
  const S = layer.startSec;
  const E = layer.endSec;
  const len = E - S;
  const ks = [...layer.keyframes].sort((a, b) => a.t - b.t);
  const L = (expr: string) => expr.replaceAll('T', `(T-${n(S)})`); // keyframe times are layer-local
  const kx = ks.length ? L(piecewiseExpr(ks.map((k) => k.t), ks.map((k) => k.x), layer.easing)) : n(layer.x);
  const ky = ks.length ? L(piecewiseExpr(ks.map((k) => k.t), ks.map((k) => k.y), layer.easing)) : n(layer.y);
  const ksc = ks.length ? L(piecewiseExpr(ks.map((k) => k.t), ks.map((k) => k.scale), layer.easing)) : '1';
  const krot = ks.length ? L(piecewiseExpr(ks.map((k) => k.t), ks.map((k) => (k.rotation * Math.PI) / 180), layer.easing)) : n((layer.rotation * Math.PI) / 180);
  const ai = layer.animIn;
  const ao = layer.animOut;
  const P = ai.type === 'none' ? '1' : `clip((T-${n(S)})/${n(ai.durationSec)},0,1)`;
  const Q = ao.type === 'none' ? '1' : `clip((${n(E)}-T)/${n(ao.durationSec)},0,1)`;
  const easeOutE = (k: string) => `(1-pow(1-${k},3))`;
  const backOutE = (k: string) => `(1+${n(C1 + 1)}*pow(${k}-1,3)+${n(C1)}*pow(${k}-1,2))`;
  let x = kx;
  let y = ky;
  let scale = ksc;
  const fades: { start: number; dur: number; dir: 'in' | 'out' }[] = [];
  const add = (type: LayerAnim, k: string, out: boolean, d: number) => {
    switch (type) {
      case 'fade':
        fades.push(out ? { start: E - d, dur: d, dir: 'out' } : { start: S, dur: d, dir: 'in' });
        break;
      case 'pop':
        scale = `(${scale})*(0.6+0.4*${backOutE(k)})`;
        fades.push(out ? { start: E - d / 2, dur: d / 2, dir: 'out' } : { start: S, dur: d / 2, dir: 'in' });
        break;
      case 'slide_up':
      case 'slide_down':
        y = `(${y})+(1-${easeOutE(k)})*${(type === 'slide_up') !== out ? '0.08' : '-0.08'}`;
        fades.push(out ? { start: E - d, dur: d, dir: 'out' } : { start: S, dur: d, dir: 'in' });
        break;
      case 'slide_left':
      case 'slide_right':
        x = `(${x})+(1-${easeOutE(k)})*${(type === 'slide_left') !== out ? '0.12' : '-0.12'}`;
        fades.push(out ? { start: E - d, dur: d, dir: 'out' } : { start: S, dur: d, dir: 'in' });
        break;
      case 'zoom':
        scale = `(${scale})*(1.3-0.3*${easeOutE(k)})`;
        fades.push(out ? { start: E - d, dur: d, dir: 'out' } : { start: S, dur: d, dir: 'in' });
        break;
      default:
        break;
    }
  };
  add(ai.type, P, false, ai.durationSec);
  add(ao.type, Q, true, ao.durationSec);
  if (layer.follow?.points.length) {
    const pts = downsample(layer.follow.points, 40);
    x = `(${x})+(${piecewiseExpr(pts.map((p) => p.t), pts.map((p) => p.dx), 'linear')})`;
    y = `(${y})+(${piecewiseExpr(pts.map((p) => p.t), pts.map((p) => p.dy), 'linear')})`;
  }
  const units = revealUnits(layer);
  const row = units ? `min(${units.length - 1},floor(clip((T-${n(S)})/${n(ai.durationSec)},0,1)*${units.length}))` : '0';
  // Scale range the renderer must cover (static keyframes × animation extremes).
  const kScales = ks.length ? ks.map((k) => k.scale) : [1];
  const animMin = [ai.type, ao.type].includes('pop') ? 0.6 : 1;
  const animMax = [ai.type, ao.type].includes('zoom') ? 1.3 : [ai.type, ao.type].includes('pop') ? 1.04 : 1;
  return { x, y, scale, rotation: krot, row, fades, len, scaleMin: Math.min(...kScales) * animMin, scaleMax: Math.max(...kScales) * animMax, animated: scale !== '1' };
}

function downsample<T>(pts: T[], max: number): T[] {
  if (pts.length <= max) return pts;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.round((i * (pts.length - 1)) / (max - 1))]!);
  return out;
}

/** Evaluate one of the expressions above in JS (tests: preview and export must agree). */
export function evalExpr(expr: string, T: number): number {
  const js = expr
    .replaceAll('T', `(${T})`)
    .replace(/\bif\(/g, '__if(')
    .replace(/\blt\(/g, '__lt(')
    .replace(/\bclip\(/g, '__clip(')
    .replace(/\bpow\(/g, 'Math.pow(')
    .replace(/\bmin\(/g, 'Math.min(')
    .replace(/\bfloor\(/g, 'Math.floor(');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return Function('__if', '__lt', '__clip', `return (${js});`)((c: number, a: number, b: number) => (c ? a : b), (a: number, b: number) => (a < b ? 1 : 0), (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)));
}

/** Stable hash of what a text/shape layer looks like (re-render the raster when it changes). */
export function rasterHash(layer: Pick<Layer, 'kind' | 'text' | 'shape' | 'animIn'>): string {
  const s = JSON.stringify({ k: layer.kind, t: layer.text, s: layer.shape, a: layer.animIn.type === 'typewriter' || layer.animIn.type === 'words' ? layer.animIn.type : null });
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `r${(h >>> 0).toString(36)}${s.length.toString(36)}`;
}
