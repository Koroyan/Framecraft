import { z } from 'zod';
import { clipDuration, clipAdjustSchema, type CameraKeyframe, type ClipAdjust, type ClipCamera, type Timeline, type TimelineClip } from './schemas';

/*
 * Editing primitives shared by the browser editor and the server renderer, so the preview and the
 * exported MP4 use the same maths: colour grade, 2D camera interpolation, the shot sequence that the
 * story graph and the timeline both show, AI edit modes, and the AI assistant's plan operations.
 */

// ------------------------------------------------------------------ colour grade

export type Grade = {
  /** Row-major 3×3 colour matrix (applied first). */
  matrix: number[];
  /** Per-channel linear map after the matrix: out = in·slope + intercept (0–1 range). */
  slope: number;
  intercept: number;
  /** Tone curve values at 0, .25, .5, .75, 1 (piecewise linear), or null when flat. */
  curve: number[] | null;
  blur: number;
  sharpen: number;
  vignette: number;
};

const LUM = [0.2126, 0.7152, 0.0722];
const mul3 = (a: number[], b: number[]) => {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
  return r;
};

export const isNeutralAdjust = (a?: Partial<ClipAdjust>) => !a || Object.values(a).every((v) => !v);

export function gradeOf(input?: Partial<ClipAdjust>): Grade {
  const a = clipAdjustSchema.parse(input ?? {});
  const g = 2 ** a.exposure;
  const balance = [g * (1 + 0.18 * a.temperature + 0.06 * a.tint), 0, 0, 0, g * (1 - 0.12 * a.tint), 0, 0, 0, g * (1 - 0.18 * a.temperature + 0.06 * a.tint)];
  const s = 1 + a.saturation;
  const sat = [
    LUM[0]! + (1 - LUM[0]!) * s, LUM[1]! * (1 - s), LUM[2]! * (1 - s),
    LUM[0]! * (1 - s), LUM[1]! + (1 - LUM[1]!) * s, LUM[2]! * (1 - s),
    LUM[0]! * (1 - s), LUM[1]! * (1 - s), LUM[2]! + (1 - LUM[2]!) * s,
  ];
  // Hue rotation (same coefficients as SVG feColorMatrix type="hueRotate").
  const rad = (a.hue * Math.PI) / 180;
  const c = Math.cos(rad);
  const n = Math.sin(rad);
  const hue = [
    0.213 + c * 0.787 - n * 0.213, 0.715 - c * 0.715 - n * 0.715, 0.072 - c * 0.072 + n * 0.928,
    0.213 - c * 0.213 + n * 0.143, 0.715 + c * 0.285 + n * 0.14, 0.072 - c * 0.072 - n * 0.283,
    0.213 - c * 0.213 - n * 0.787, 0.715 - c * 0.715 + n * 0.715, 0.072 + c * 0.928 + n * 0.072,
  ];
  const slope = 1 + a.contrast;
  const intercept = 0.5 * (1 - slope) + 0.5 * a.brightness;
  const curve = a.highlights || a.shadows ? [0, 0.25 + 0.12 * a.shadows, 0.5, 0.75 + 0.12 * a.highlights, 1] : null;
  return { matrix: mul3(hue, mul3(sat, balance)).map((v) => Math.round(v * 10000) / 10000), slope, intercept, curve, blur: a.blur, sharpen: a.sharpen, vignette: a.vignette };
}

/** Apply a grade to one RGB pixel (0–1), exactly as the renderer does (used by tests and pickers). */
export function gradePixel(g: Grade, rgb: [number, number, number]): [number, number, number] {
  const m = g.matrix;
  const out = [0, 1, 2].map((i) => m[i * 3]! * rgb[0] + m[i * 3 + 1]! * rgb[1] + m[i * 3 + 2]! * rgb[2]);
  return out.map((v) => {
    let x = Math.min(1, Math.max(0, Math.min(1, Math.max(0, v)) * g.slope + g.intercept));
    if (g.curve) x = curveAt(g.curve, x);
    return x;
  }) as [number, number, number];
}

export function curveAt(curve: number[], x: number): number {
  const seg = Math.min(3, Math.floor(x * 4));
  const u = x * 4 - seg;
  return curve[seg]! + (curve[seg + 1]! - curve[seg]!) * u;
}

// ------------------------------------------------------------------ 2D camera

const smooth = (u: number) => u * u * (3 - 2 * u);

/** Keep the framing window inside the frame (pan range shrinks as zoom drops). */
export function clampKeyframe<T extends Pick<CameraKeyframe, 'x' | 'y' | 'scale'>>(k: T): T {
  const half = 0.5 / k.scale;
  return { ...k, x: Math.min(1 - half, Math.max(half, k.x)), y: Math.min(1 - half, Math.max(half, k.y)) };
}

export function cameraAt(cam: Pick<ClipCamera, 'keyframes' | 'easing'> | undefined, t: number): Omit<CameraKeyframe, 't'> {
  const ks = [...(cam?.keyframes ?? [])].sort((a, b) => a.t - b.t);
  const pick = (k: CameraKeyframe) => clampKeyframe({ x: k.x, y: k.y, scale: k.scale, rotation: k.rotation });
  if (!ks.length) return { x: 0.5, y: 0.5, scale: 1, rotation: 0 };
  if (t <= ks[0]!.t) return pick(ks[0]!);
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]!;
    const b = ks[i + 1]!;
    if (t <= b.t) {
      const raw = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      const u = cam?.easing === 'linear' ? raw : smooth(raw);
      const lerp = (p: number, q: number) => p + (q - p) * u;
      return clampKeyframe({ x: lerp(a.x, b.x), y: lerp(a.y, b.y), scale: lerp(a.scale, b.scale), rotation: lerp(a.rotation, b.rotation) });
    }
  }
  return pick(ks[ks.length - 1]!);
}

export const CAMERA_MOVES = [
  { key: 'static', label: 'Static' },
  { key: 'push_in', label: 'Slow push in' },
  { key: 'pull_out', label: 'Pull out' },
  { key: 'pan_left', label: 'Pan left' },
  { key: 'pan_right', label: 'Pan right' },
  { key: 'tilt_up', label: 'Tilt up' },
  { key: 'tilt_down', label: 'Tilt down' },
  { key: 'dolly', label: 'Smooth digital dolly' },
  { key: 'zoom_to', label: 'Zoom to point (face / product)' },
  { key: 'handheld', label: 'Handheld' },
  { key: 'tracking', label: 'Smooth tracking' },
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number]['key'];

/** Keyframes for a preset. `intensity` 0–1; `target` is the point to zoom to (zoom_to). */
export function cameraPreset(preset: CameraMove, durationSec: number, intensity = 0.5, target = { x: 0.5, y: 0.5 }): ClipCamera {
  const d = Math.max(0.2, durationSec);
  const i = Math.min(1, Math.max(0.05, intensity));
  const k = (t: number, x: number, y: number, scale: number, rotation = 0): CameraKeyframe => clampKeyframe({ t: Math.round(t * 1000) / 1000, x, y, scale: Math.round(scale * 1000) / 1000, rotation });
  const zoom = 1 + 0.45 * i;
  const travel = (s: number) => (0.5 - 0.5 / s) * 0.95;
  let keyframes: CameraKeyframe[];
  switch (preset) {
    case 'static':
      keyframes = [k(0, 0.5, 0.5, 1)];
      break;
    case 'push_in':
      keyframes = [k(0, 0.5, 0.5, 1), k(d, 0.5, 0.5, zoom)];
      break;
    case 'pull_out':
      keyframes = [k(0, 0.5, 0.5, zoom), k(d, 0.5, 0.5, 1)];
      break;
    case 'pan_left':
    case 'pan_right': {
      const s = 1.15 + 0.25 * i;
      const dx = travel(s);
      const dir = preset === 'pan_right' ? 1 : -1;
      keyframes = [k(0, 0.5 - dir * dx, 0.5, s), k(d, 0.5 + dir * dx, 0.5, s)];
      break;
    }
    case 'tilt_up':
    case 'tilt_down': {
      const s = 1.15 + 0.25 * i;
      const dy = travel(s);
      const dir = preset === 'tilt_down' ? 1 : -1;
      keyframes = [k(0, 0.5, 0.5 - dir * dy, s), k(d, 0.5, 0.5 + dir * dy, s)];
      break;
    }
    case 'dolly':
      keyframes = [k(0, 0.5, 0.52, 1.02), k(d, 0.5, 0.48, 1 + 0.3 * i)];
      break;
    case 'zoom_to':
      keyframes = [k(0, 0.5, 0.5, 1), k(d, target.x, target.y, 1 + 1.2 * i)];
      break;
    case 'tracking': {
      const s = 1.12 + 0.2 * i;
      keyframes = [k(0, 0.5 - travel(s) * 0.8, 0.5, s), k(d / 2, 0.5, 0.49, s * 1.02), k(d, 0.5 + travel(s) * 0.8, 0.5, s)];
      break;
    }
    case 'handheld': {
      const s = 1.06 + 0.06 * i;
      const steps = Math.min(15, Math.max(4, Math.round(d * 2.5)));
      const amp = (0.5 - 0.5 / s) * 0.7;
      keyframes = Array.from({ length: steps + 1 }, (_, j) => k((d * j) / steps, 0.5 + amp * Math.sin(j * 2.1) * 0.8, 0.5 + amp * Math.cos(j * 1.7) * 0.6, s, Math.sin(j * 1.3) * 0.6 * i));
      break;
    }
  }
  return { keyframes, easing: preset === 'handheld' ? 'linear' : 'ease', preset };
}

// ------------------------------------------------------------------ sequence (story graph ⇄ timeline)

/** One node of the story graph: a shot's run of consecutive clips (or a standalone clip). */
export type SequenceNode = { key: string; shotId?: string; clipIds: string[] };

export function sequenceOf(t: Pick<Timeline, 'clips'>): SequenceNode[] {
  const out: SequenceNode[] = [];
  for (const c of t.clips) {
    const last = out[out.length - 1];
    if (c.shotId && last?.shotId === c.shotId) last.clipIds.push(c.id);
    else out.push({ key: c.shotId && !out.some((n) => n.shotId === c.shotId) ? c.shotId : c.id, shotId: c.shotId, clipIds: [c.id] });
  }
  return out;
}

/** Move a node's clips to directly after another node (null = first). A list cannot form cycles. */
export function moveNodeAfter<T extends Pick<Timeline, 'clips'>>(t: T, key: string, afterKey: string | null): T {
  if (key === afterKey) return t;
  const seq = sequenceOf(t);
  const node = seq.find((n) => n.key === key);
  if (!node) return t;
  const moving = t.clips.filter((c) => node.clipIds.includes(c.id));
  const rest = t.clips.filter((c) => !node.clipIds.includes(c.id));
  let at = 0;
  if (afterKey) {
    const after = seq.find((n) => n.key === afterKey);
    if (!after) return t;
    at = Math.max(...after.clipIds.map((id) => rest.findIndex((c) => c.id === id))) + 1;
  }
  rest.splice(at, 0, ...moving);
  return { ...t, clips: rest };
}

export function removeNode<T extends Pick<Timeline, 'clips'>>(t: T, key: string): T {
  const node = sequenceOf(t).find((n) => n.key === key);
  return node ? { ...t, clips: t.clips.filter((c) => !node.clipIds.includes(c.id)) } : t;
}

/** Put a shot (its active version) into the movie after `afterKey` (null = first). */
export function insertShot<T extends Pick<Timeline, 'clips'>>(t: T, shot: { shotId: string; assetId: string; versionId?: string; durationSec: number; label?: string }, afterKey: string | null, clipId: string): T {
  const clip: TimelineClip = { id: clipId, assetId: shot.assetId, shotId: shot.shotId, versionId: shot.versionId, inSec: 0, outSec: Math.max(0.2, shot.durationSec), volume: 1, label: shot.label, speed: 1, reverse: false, fadeInSec: 0, fadeOutSec: 0, opacity: 1 };
  const next = { ...t, clips: [...t.clips, clip] };
  return moveNodeAfter(next, sequenceOf(next).at(-1)!.key, afterKey);
}

/**
 * Point every clip of a shot at another version (non-destructive: the old file stays). Trims are
 * kept when they fit the new file; a clip that played the whole old take plays the whole new one.
 */
export function swapShotVersion<T extends Pick<Timeline, 'clips'>>(t: T, shotId: string, v: { assetId: string; versionId?: string; durationSec: number; previousDurationSec?: number }): T {
  return {
    ...t,
    clips: t.clips.map((c) => {
      if (c.shotId !== shotId) return c;
      const wasWhole = c.inSec <= 0.05 && v.previousDurationSec !== undefined && c.outSec >= v.previousDurationSec - 0.1;
      const outSec = wasWhole ? v.durationSec : Math.min(c.outSec, v.durationSec);
      const inSec = Math.min(c.inSec, Math.max(0, outSec - 0.2));
      return { ...c, assetId: v.assetId, versionId: v.versionId, inSec, outSec };
    }),
  };
}

// ------------------------------------------------------------------ AI edit modes

export const AI_EDIT_MODES = [
  { key: 'fix', label: 'Fix', hint: 'Correct an artifact (hands, faces, glitches)', scope: 'range' },
  { key: 'replace', label: 'Replace', hint: 'Swap the selected object for something else', scope: 'range' },
  { key: 'remove', label: 'Remove', hint: 'Erase an unwanted element', scope: 'range' },
  { key: 'add', label: 'Add', hint: 'Introduce an object or detail', scope: 'range' },
  { key: 'restyle', label: 'Restyle', hint: 'Change the look or visual style', scope: 'range' },
  { key: 'relight', label: 'Relight', hint: 'Change the lighting', scope: 'range' },
  { key: 'background', label: 'Background', hint: 'Replace the background, keep the subject', scope: 'range' },
  { key: 'motion', label: 'Modify motion', hint: 'Ask for a different movement (may not be followed exactly)', scope: 'range' },
  { key: 'enhance', label: 'Enhance', hint: 'Cleaner detail and consistency (AI re-render, not an upscaler)', scope: 'range' },
  { key: 'reframe', label: 'Reframe', hint: 'Outpaint to another aspect ratio (whole shot)', scope: 'shot' },
  { key: 'camera_remix', label: 'Camera remix', hint: 'Generative new viewpoint — may change geometry (whole shot)', scope: 'shot' },
] as const;
export type AiEditMode = (typeof AI_EDIT_MODES)[number]['key'];
export const aiEditModeSchema = z.enum(AI_EDIT_MODES.map((m) => m.key) as [AiEditMode, ...AiEditMode[]]);

/** Normalised (0–1) spatial selection. Brush strokes are polylines with a radius. */
export const editMaskSchema = z.object({
  rects: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1), ellipse: z.boolean().default(false), subtract: z.boolean().default(false) })).max(20).default([]),
  polygons: z.array(z.object({ points: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(3).max(400), subtract: z.boolean().default(false) })).max(20).default([]),
  strokes: z.array(z.object({ points: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(1).max(2000), radius: z.number().min(0.002).max(0.3), subtract: z.boolean().default(false) })).max(50).default([]),
  /** Soft edge as a fraction of the frame width. */
  feather: z.number().min(0).max(0.1).default(0.015),
  invert: z.boolean().default(false),
});
export type EditMask = z.infer<typeof editMaskSchema>;
export const maskIsEmpty = (m?: EditMask | null) => !m || (!m.rects.length && !m.polygons.length && !m.strokes.length);

/** Rough description of where the mask is, for the model prompt (the provider takes no mask input). */
export function describeMaskRegion(m: EditMask): string | null {
  if (maskIsEmpty(m)) return null;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  const add = (x: number, y: number) => ((x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y)));
  m.rects.filter((r) => !r.subtract).forEach((r) => (add(r.x, r.y), add(r.x + r.w, r.y + r.h)));
  m.polygons.filter((p) => !p.subtract).forEach((p) => p.points.forEach(([x, y]) => add(x, y)));
  m.strokes.filter((s) => !s.subtract).forEach((s) => s.points.forEach(([x, y]) => (add(x - s.radius, y - s.radius), add(x + s.radius, y + s.radius))));
  if (x1 <= x0) return null;
  const h = (v: number) => (v < 0.36 ? 'left' : v > 0.64 ? 'right' : 'centre');
  const vv = (v: number) => (v < 0.36 ? 'top' : v > 0.64 ? 'bottom' : 'middle');
  const area = (x1 - x0) * (y1 - y0);
  return `${area < 0.06 ? 'a small area' : area < 0.25 ? 'an area' : 'a large area'} in the ${vv((y0 + y1) / 2)}-${h((x0 + x1) / 2)} of the frame`;
}

// ------------------------------------------------------------------ AI assistant plan

export const planOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('trim'), shot: z.number().int().min(1), durationSec: z.number().min(0.2).max(600).optional(), inSec: z.number().min(0).optional(), outSec: z.number().min(0.1).optional() }),
  z.object({ op: z.literal('speed'), shot: z.number().int().min(1), speed: z.number().min(0.25).max(4) }),
  z.object({ op: z.literal('transition'), shot: z.number().int().min(1), type: z.enum(['cut', 'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideup', 'circleopen', 'fadeblack']), durationSec: z.number().min(0.1).max(3).default(0.5) }),
  z.object({ op: z.literal('color'), shot: z.number().int().min(1), adjust: clipAdjustSchema.partial() }),
  z.object({ op: z.literal('match_color'), shot: z.number().int().min(1), fromShot: z.number().int().min(1) }),
  z.object({ op: z.literal('camera'), shot: z.number().int().min(1), preset: z.enum(CAMERA_MOVES.map((p) => p.key) as [CameraMove, ...CameraMove[]]), intensity: z.number().min(0).max(1).default(0.5) }),
  z.object({ op: z.literal('fade'), shot: z.number().int().min(1), inSec: z.number().min(0).max(5).default(0), outSec: z.number().min(0).max(5).default(0) }),
  z.object({ op: z.literal('move'), shot: z.number().int().min(1), afterShot: z.number().int().min(0) }),
  z.object({ op: z.literal('remove'), shot: z.number().int().min(1) }),
  z.object({ op: z.literal('text'), text: z.string().min(1).max(300), startSec: z.number().min(0), endSec: z.number().min(0.1), position: z.enum(['top', 'center', 'bottom']).default('bottom') }),
  z.object({ op: z.literal('ai_edit'), shot: z.number().int().min(1), mode: aiEditModeSchema, instruction: z.string().min(3).max(900), startSec: z.number().min(0).optional(), endSec: z.number().min(0).optional() }),
]);
export type PlanOp = z.infer<typeof planOpSchema>;
export const isGenerativeOp = (op: PlanOp) => op.op === 'ai_edit';

/**
 * Apply one deterministic plan operation to the timeline. Shots are numbered by their order in the
 * movie (1-based). Returns the timeline unchanged for generative ops (those go through AI edit jobs).
 */
export function applyPlanOp<T extends Timeline>(t: T, op: PlanOp, newClipId: () => string): T {
  void newClipId;
  if (op.op === 'text') {
    return { ...t, texts: [...t.texts, { id: `txt-${Math.random().toString(36).slice(2, 10)}`, text: op.text, startSec: op.startSec, endSec: Math.max(op.endSec, op.startSec + 0.5), position: op.position, fontSize: 64, color: '#FFFFFF', background: true }] };
  }
  if (op.op === 'ai_edit') return t;
  const seq = sequenceOf(t);
  const node = seq[op.shot - 1];
  if (!node) return t;
  const ids = new Set(node.clipIds);
  const each = (fn: (c: TimelineClip, i: number, all: TimelineClip[]) => TimelineClip): T => {
    const own = t.clips.filter((c) => ids.has(c.id));
    return { ...t, clips: t.clips.map((c) => (ids.has(c.id) ? fn(c, own.indexOf(c), own) : c)) };
  };
  switch (op.op) {
    case 'trim':
      return each((c, i, all) => {
        if (op.inSec !== undefined || op.outSec !== undefined) return { ...c, inSec: op.inSec ?? c.inSec, outSec: Math.max((op.inSec ?? c.inSec) + 0.2, op.outSec ?? c.outSec) };
        if (op.durationSec === undefined || i !== all.length - 1) return c;
        const before = all.slice(0, -1).reduce((s, x) => s + clipDuration(x), 0);
        const want = Math.max(0.2, op.durationSec - before) * (c.speed || 1);
        return { ...c, outSec: Math.max(c.inSec + 0.2, Math.min(c.outSec, c.inSec + want)) };
      });
    case 'speed':
      return each((c) => ({ ...c, speed: op.speed }));
    case 'transition':
      return each((c, i, all) => (i === all.length - 1 ? { ...c, transition: op.type === 'cut' ? undefined : { type: op.type, durationSec: op.durationSec } } : c));
    case 'color':
      return each((c) => ({ ...c, adjust: clipAdjustSchema.parse({ ...c.adjust, ...op.adjust }) }));
    case 'match_color': {
      const from = seq[op.fromShot - 1];
      const src = from && t.clips.find((c) => c.id === from.clipIds[0]);
      return src ? each((c) => ({ ...c, adjust: src.adjust ? { ...src.adjust } : undefined })) : t;
    }
    case 'camera':
      return each((c) => ({ ...c, camera: cameraPreset(op.preset, clipDuration(c), op.intensity) }));
    case 'fade':
      return each((c, i, all) => ({ ...c, fadeInSec: i === 0 ? op.inSec : c.fadeInSec, fadeOutSec: i === all.length - 1 ? op.outSec : c.fadeOutSec }));
    case 'move':
      return moveNodeAfter(t, node.key, op.afterShot ? (seq[op.afterShot - 1]?.key ?? null) : null);
    case 'remove':
      return removeNode(t, node.key);
  }
}
