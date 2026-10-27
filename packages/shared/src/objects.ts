import { z } from 'zod';
import { editMaskSchema, type EditMask } from './masks';
import { applyReplace, gradeFunction, hexToRgb, hslToRgb, rgbToHex, rgbToHsl, type GradeSettings } from './grade';
import { motionAt } from './layers';
import { adaptiveMask, fillPolygon, type AdaptiveMask, type ImageLike } from './segment';

/*
 * Object edits: "this jacket, from 1.2 s to 4.0 s, blue". An object is a selection (drawn or
 * click-selected) that can follow a tracked subject, a time range on the clip's source clock, and a
 * short list of effects applied only inside it. Manual effects are deterministic and free; the
 * preview (WebGL) and the export (FFmpeg) compute them from the same functions below.
 */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const objectEffectSchema = z.discriminatedUnion('type', [
  /** Recolour only the object's own colour inside the selection (window + colour qualifier). */
  z.object({ type: z.literal('recolor'), from: hex, to: hex, range: z.number().min(0.02).max(1).default(0.25), softness: z.number().min(0).max(1).default(0.5), strength: z.number().min(0).max(1).default(1), keepLightness: z.boolean().default(true) }),
  /** Light / colour correction inside the selection. */
  z.object({
    type: z.literal('adjust'),
    exposure: z.number().min(-2).max(2).default(0),
    brightness: z.number().min(-1).max(1).default(0),
    contrast: z.number().min(-1).max(1).default(0),
    saturation: z.number().min(-1).max(1).default(0),
    temperature: z.number().min(-1).max(1).default(0),
    tint: z.number().min(-1).max(1).default(0),
    hue: z.number().min(-180).max(180).default(0),
  }),
  /** Gaussian blur (sigma in pixels at 1080 lines) — faces, number plates, logos. */
  z.object({ type: z.literal('blur'), amount: z.number().min(1).max(60).default(14) }),
  /** Mosaic blocks (size in pixels at 1080 lines). */
  z.object({ type: z.literal('pixelate'), size: z.number().min(4).max(120).default(28) }),
]);
export type ObjectEffect = z.infer<typeof objectEffectSchema>;
export type ObjectEffectInput = z.input<typeof objectEffectSchema>;

export const OBJECT_SCOPES = [
  { key: 'frame', label: 'This frame' },
  { key: 'clip', label: 'Whole clip' },
  { key: 'until_lost', label: 'Until it disappears' },
  { key: 'range', label: 'Custom range' },
] as const;
export type ObjectScope = (typeof OBJECT_SCOPES)[number]['key'];

/** One clicked part of an object: its colour and points on it (at `atSec`, moved by the track). */
export const adaptPartSchema = z.object({
  seeds: z.array(z.tuple([z.number().min(-0.5).max(1.5), z.number().min(-0.5).max(1.5)])).min(1).max(24),
  /** Its colour (CIELAB) and how much lightness counts. */
  lab: z.tuple([z.number(), z.number(), z.number()]),
  wL: z.number().min(0).max(1),
  /** Edge threshold of the click — measured at a frame `res` pixels wide. */
  threshold: z.number().min(0.5).max(80),
});
export type AdaptPart = z.infer<typeof adaptPartSchema>;

/**
 * How a click-selected object is found again on every frame, so the edit follows its real shape when
 * it turns or deforms (the outline as drawn only moves and scales with the track). It replaces the
 * selection's added parts; subtracted parts stay as drawn. Shift + click adds a part (e.g. the side
 * of a coat that is in the light).
 */
export const objectAdaptSchema = z.object({
  on: z.boolean().default(true),
  parts: z.array(adaptPartSchema).min(1).max(6),
  res: z.number().int().min(64).max(1920),
});
export type ObjectAdapt = z.infer<typeof objectAdaptSchema>;

export const objectEditSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(60).default('Object'),
  /** Selection in source-normalised coordinates, as drawn at `atSec`; `mask.track` moves it. */
  mask: editMaskSchema,
  /** Source second where the selection was made. */
  atSec: z.number().min(0),
  /** Source-time range (clip-local source seconds) the effects apply to. */
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  scope: z.enum(OBJECT_SCOPES.map((s) => s.key) as [ObjectScope, ...ObjectScope[]]).default('clip'),
  effects: z.array(objectEffectSchema).max(4).default([]),
  /** Average colour of the selected pixels (swatch and recolour source). */
  color: hex.optional(),
  /** Follow shape changes (click selections): see objectAdaptSchema. */
  adapt: objectAdaptSchema.optional(),
  enabled: z.boolean().default(true),
});
export type ObjectEdit = z.infer<typeof objectEditSchema>;
export type ObjectEditInput = z.input<typeof objectEditSchema>;

// ------------------------------------------------------------------ geometry

/** Bounding box of the additive parts of a mask (normalised). */
export function maskBounds(m: EditMask): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  const add = (x: number, y: number) => ((x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y)));
  m.rects.filter((r) => !r.subtract).forEach((r) => (add(r.x, r.y), add(r.x + r.w, r.y + r.h)));
  m.polygons.filter((p) => !p.subtract).forEach((p) => p.points.forEach(([x, y]) => add(x, y)));
  m.strokes.filter((s) => !s.subtract).forEach((s) => s.points.forEach(([x, y]) => (add(x - s.radius, y - s.radius), add(x + s.radius, y + s.radius))));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/**
 * Where the selection is at source time t: a point p maps to c + (p − c)·s + (dx, dy), c being the
 * centre of the selection as drawn. Without a track it stays where it was drawn.
 */
export function maskTransformAt(m: EditMask, t: number) {
  const b = maskBounds(m);
  const cx = b ? (b.x0 + b.x1) / 2 : 0.5;
  const cy = b ? (b.y0 + b.y1) / 2 : 0.5;
  const { dx, dy, s } = motionAt(m.track, t);
  return { dx, dy, s, cx, cy };
}

export const applyTransform = (tr: { dx: number; dy: number; s: number; cx: number; cy: number }, x: number, y: number): [number, number] => [tr.cx + (x - tr.cx) * tr.s + tr.dx, tr.cy + (y - tr.cy) * tr.s + tr.dy];

export type AdaptedMask = AdaptiveMask & { frameWidth: number; frameHeight: number; t: number };

const polyArea = (pts: [number, number][]) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j]![0] + pts[i]![0]) * (pts[j]![1] - pts[i]![1]);
  return Math.abs(a / 2);
};

/** Does this object re-find its shape on every frame? */
export const adapts = (o: Pick<ObjectEdit, 'adapt' | 'mask'>) => Boolean(o.adapt?.on && o.adapt.parts.length && o.mask.polygons.some((p) => !p.subtract) && !o.mask.invert);

/**
 * The object's real shape at source second t, found in `img` (the source frame scaled to
 * `adapt.res` pixels wide) — the same function in the browser preview and in the export. It stands
 * for the selection's added polygons. Null when it can't be found there; the drawn outline (moved
 * by the track) is used instead.
 */
export function adaptedMaskAt(o: Pick<ObjectEdit, 'adapt' | 'mask'>, img: ImageLike, t: number): AdaptedMask | null {
  const a = o.adapt;
  if (!a || !adapts(o)) return null;
  const W = img.width;
  const H = img.height;
  const tr = maskTransformAt(o.mask, t);
  const toPx = ([x, y]: [number, number]) => {
    const [px, py] = applyTransform(tr, x, y);
    return [px * W, py * H] as [number, number];
  };
  const polys = o.mask.polygons.filter((p) => !p.subtract).map((p) => p.points.map(toPx));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pts of polys)
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  const groups = a.parts.map((p) => ({ seeds: p.seeds.map(toPx), ref: { L: p.lab[0], A: p.lab[1], B: p.lab[2], wL: p.wL }, threshold: p.threshold }));
  const side = Math.max(x1 - x0, y1 - y0);
  // Where the object can plausibly reach. A side of the picture it is nowhere near counts as
  // background too: a region running out there is the road or a wall, not the object.
  const near = 0.3 * side;
  const open = { left: x0 - near >= 1, top: y0 - near >= 1, right: x1 + near <= W - 1, bottom: y1 + near <= H - 1 };
  // Room to change shape: a turning object can get a good deal wider or taller.
  const search = (k: number) => adaptiveMask(img, { window: { x0: x0 - k * side, y0: y0 - k * side, x1: x1 + k * side, y1: y1 + k * side }, groups, open });
  let r = search(0.3);
  // Cut at the window's side: the object may simply have grown or turned wider — look again in a
  // window twice as roomy; whatever still runs out of that one is background.
  if (r?.cut) r = search(0.65) ?? r;
  if (!r) return null;
  const expected = polys.reduce((sum, pts) => sum + polyArea(pts), 0);
  if (r.area < expected * 0.1) return null;
  if (r.area > expected * 2.2) {
    // Ran into a similar-coloured background: keep only what is near where the object should be.
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const guard = new Uint8Array(r.width * r.height);
    for (const pts of polys) fillPolygon(guard, r.width, r.height, pts.map(([x, y]) => [cx + (x - cx) * 1.3 - r.x0, cy + (y - cy) * 1.3 - r.y0]), 1);
    let area = 0;
    for (let i = 0; i < guard.length; i++) {
      if (!guard[i]) r.mask[i] = 0;
      area += r.mask[i]!;
    }
    r.area = area;
    if (!area) return null;
  }
  return { ...r, frameWidth: W, frameHeight: H, t };
}

/** Is the object edit active at this source second? (A "frame" edit lasts one frame either side.) */
export function objectActiveAt(o: Pick<ObjectEdit, 'startSec' | 'endSec' | 'enabled'>, srcT: number, frame = 1 / 30): boolean {
  if (!o.enabled) return false;
  return srcT >= o.startSec - frame / 2 && srcT <= Math.max(o.endSec, o.startSec + frame) + frame / 2;
}

/** Track confidence below this counts as "lost" (the UI marks those frames for correction). */
export const TRACK_LOST = 0.45;

/** Times where the track is uncertain, merged into spans (for red marks on the time bar). */
export function lostSpans(m: EditMask, minLen = 0): { start: number; end: number }[] {
  const pts = m.track?.points ?? [];
  const out: { start: number; end: number }[] = [];
  for (const p of pts) {
    if ((p.conf ?? 1) >= TRACK_LOST) continue;
    const last = out[out.length - 1];
    if (last && p.t - last.end < 0.2) last.end = p.t;
    else out.push({ start: p.t, end: p.t });
  }
  return out.filter((s) => s.end - s.start >= minLen);
}

/**
 * Merge a re-track that starts at a user's correction into an existing track. `offset` is where the
 * user moved the selection at `fromT` (relative to where it was drawn), so the new points continue
 * from there. Points before `fromT` are kept.
 */
export function mergeTrack(base: EditMask['track'], fromT: number, add: NonNullable<EditMask['track']>, offset: { dx: number; dy: number; s: number }): NonNullable<EditMask['track']> {
  const keep = (base?.points ?? []).filter((p) => p.t < fromT - 1e-3);
  const next = add.points
    .filter((p) => p.t >= fromT - 1e-3)
    .map((p) => ({ ...p, dx: clampU(offset.dx + p.dx), dy: clampU(offset.dy + p.dy), s: Math.max(0.05, Math.min(20, offset.s * (p.s ?? 1))) }));
  return { points: [...keep, ...next].slice(0, 2000), smoothing: base?.smoothing ?? add.smoothing };
}
const clampU = (v: number) => Math.max(-1, Math.min(1, v));

// ------------------------------------------------------------------ colour

const ADJUST_KEYS = ['exposure', 'brightness', 'contrast', 'saturation', 'temperature', 'tint', 'hue'] as const;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Recolour a colourless object (black, grey, white): hue cannot select it, so pixels are chosen by
 * being similarly light and colourless, and get the target's hue and saturation with their shading
 * kept — lightness moves towards the target so a black jacket can really become red.
 */
function colorizeNeutral(e: Extract<ObjectEffect, { type: 'recolor' }>) {
  const [, fs, fl] = rgbToHsl(...hexToRgb(e.from));
  const [th, ts, tl] = rgbToHsl(...hexToRgb(e.to));
  const width = 0.12 + e.range * 0.5; // lightness window
  const soft = Math.max(0.02, e.softness * width);
  return (px: [number, number, number]): [number, number, number] => {
    const [, s, l] = rgbToHsl(...px);
    // A light material only gets lighter where light hits it (and a dark one darker in shade):
    // those shades are the same object, so the window is open on that side.
    const d = (fl >= 0.5 && l > fl) || (fl <= 0.25 && l < fl) ? 0 : Math.abs(l - fl);
    let w = d <= width ? 1 : d >= width + soft ? 0 : 1 - (d - width) / soft;
    w *= clamp01((Math.max(0.28, fs + 0.18) - s) / 0.1); // leave clearly coloured pixels alone
    w *= e.strength;
    if (w <= 0) return px;
    const nl = clamp01(l + (tl - fl) * 0.85);
    const out = hslToRgb(th, ts * clamp01(0.55 + nl), nl);
    return [px[0] + (out[0] - px[0]) * w, px[1] + (out[1] - px[1]) * w, px[2] + (out[2] - px[2]) * w];
  };
}

/** Is a colour too grey for hue-based selection? */
export const isNeutralColor = (hexValue: string) => rgbToHsl(...hexToRgb(hexValue))[1] < 0.18;

/** The per-pixel colour part of an object's effects (recolour then adjust), or null when it has none. */
export function objectColorFunction(effects: ObjectEffect[]): ((rgb: [number, number, number]) => [number, number, number]) | null {
  const steps: ((rgb: [number, number, number]) => [number, number, number])[] = [];
  for (const e of effects) {
    if (e.type === 'recolor' && isNeutralColor(e.from)) steps.push(colorizeNeutral(e));
    else if (e.type === 'recolor') steps.push((px) => applyReplace({ id: 'o', from: e.from, to: e.to, range: e.range, softness: e.softness, strength: e.strength, keepLightness: e.keepLightness }, px));
    else if (e.type === 'adjust') {
      const g: Partial<GradeSettings> = {};
      for (const k of ADJUST_KEYS) if (e[k]) g[k] = e[k];
      if (Object.keys(g).length) steps.push(gradeFunction(g));
    }
  }
  if (!steps.length) return null;
  return (rgb) => steps.reduce((acc, f) => f(acc), rgb);
}

export const spatialEffect = (effects: ObjectEffect[]) => effects.find((e) => e.type === 'blur' || e.type === 'pixelate') as Extract<ObjectEffect, { type: 'blur' | 'pixelate' }> | undefined;

/** Short human summary: "Colour → blue · Blur". */
export function describeEffects(effects: ObjectEffect[]): string {
  if (!effects.length) return 'No effect yet';
  return effects
    .map((e) => {
      if (e.type === 'recolor') return `Colour → ${colorName(e.to)}`;
      if (e.type === 'blur') return 'Blur';
      if (e.type === 'pixelate') return 'Pixelate';
      const parts = ADJUST_KEYS.filter((k) => e[k]).map((k) => `${k} ${e[k] > 0 ? '+' : ''}${Math.round(e[k] * (k === 'hue' ? 1 : 100))}${k === 'hue' ? '°' : ''}`);
      return parts.length ? `Adjust (${parts.join(', ')})` : 'Adjust';
    })
    .join(' · ');
}

const NAMED: [string, number][] = [['red', 0], ['orange', 30], ['yellow', 55], ['green', 120], ['teal', 170], ['blue', 220], ['purple', 275], ['pink', 320], ['red', 360]];

/** Rough English colour name of a hex value (for labels and the assistant). */
export function colorName(hexValue: string): string {
  const [h, s, l] = rgbToHsl(...hexToRgb(hexValue));
  if (l < 0.12) return 'black';
  if (l > 0.9) return 'white';
  if (s < 0.15) return l < 0.45 ? 'dark grey' : 'grey';
  if (h >= 12 && h <= 48 && l < 0.42) return 'brown';
  if (h >= 30 && h <= 50 && s < 0.45 && l >= 0.42) return 'beige';
  let best = NAMED[0]!;
  for (const n of NAMED) if (Math.abs(n[1] - h) < Math.abs(best[1] - h)) best = n;
  return best[0];
}

/** Named colours the user can ask for ("make it blue"). */
export const COLOR_WORDS: Record<string, string> = {
  red: '#D92B2B', orange: '#F07C1E', yellow: '#F2C823', green: '#2E9E4F', teal: '#1E9C9C', blue: '#2563EB', navy: '#1E2F6B', purple: '#7C3AED', pink: '#E84A8A', white: '#F5F5F5', black: '#151515', grey: '#7A7A7A', gray: '#7A7A7A', brown: '#7B4A26', gold: '#C9A227',
  // Georgian
  წითელი: '#D92B2B', ნარინჯისფერი: '#F07C1E', ყვითელი: '#F2C823', მწვანე: '#2E9E4F', ლურჯი: '#2563EB', ცისფერი: '#3B9BEA', იისფერი: '#7C3AED', ვარდისფერი: '#E84A8A', თეთრი: '#F5F5F5', შავი: '#151515', რუხი: '#7A7A7A', ყავისფერი: '#7B4A26', ოქროსფერი: '#C9A227',
  // Russian
  красный: '#D92B2B', оранжевый: '#F07C1E', жёлтый: '#F2C823', желтый: '#F2C823', зелёный: '#2E9E4F', зеленый: '#2E9E4F', синий: '#2563EB', голубой: '#3B9BEA', фиолетовый: '#7C3AED', розовый: '#E84A8A', белый: '#F5F5F5', чёрный: '#151515', черный: '#151515', серый: '#7A7A7A', коричневый: '#7B4A26',
};

export const rgbHex = (r: number, g: number, b: number) => rgbToHex([r / 255, g / 255, b / 255]);
