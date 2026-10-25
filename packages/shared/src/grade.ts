import { z } from 'zod';
import { editMaskSchema } from './masks';

/*
 * Colour grading as one pure function RGB → RGB, baked into a 3D LUT. The browser preview (WebGL2,
 * 3D texture, trilinear) and the export (FFmpeg lut3d, trilinear) sample the same LUT, so the
 * colour you see is the colour you export. Spatial effects (blur, sharpen, vignette, grain, glow)
 * and masked colour replacements are separate passes.
 */

const rgbTriple = z.object({ r: z.number().min(-1).max(1).default(0), g: z.number().min(-1).max(1).default(0), b: z.number().min(-1).max(1).default(0) });
const curve = z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(2).max(12);

export const HSL_BANDS = [
  { key: 'red', label: 'Red', hue: 0 },
  { key: 'orange', label: 'Orange', hue: 30 },
  { key: 'yellow', label: 'Yellow', hue: 60 },
  { key: 'green', label: 'Green', hue: 120 },
  { key: 'aqua', label: 'Aqua', hue: 180 },
  { key: 'blue', label: 'Blue', hue: 225 },
  { key: 'purple', label: 'Purple', hue: 270 },
  { key: 'magenta', label: 'Magenta', hue: 315 },
] as const;
export type HslBand = (typeof HSL_BANDS)[number]['key'];
const hslAdjust = z.object({ h: z.number().min(-60).max(60).default(0), s: z.number().min(-1).max(1).default(0), l: z.number().min(-1).max(1).default(0) });

/** Replace one colour range by another (e.g. red jacket → blue). With a mask, only inside it. */
export const colorReplaceSchema = z.object({
  id: z.string().min(1).max(40),
  /** Picked source colour. */
  from: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Hue width of the selection (0–1 → 0–90°). */
  range: z.number().min(0.02).max(1).default(0.25),
  /** Soft falloff at the edge of the range (0–1). */
  softness: z.number().min(0).max(1).default(0.5),
  /** Target colour (its hue and, by `keepLightness`, its saturation). */
  to: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  keepLightness: z.boolean().default(true),
  strength: z.number().min(0).max(1).default(1),
  /** Optional spatial limit (can follow a tracked object); then it is a masked pass, not part of the LUT. */
  mask: editMaskSchema.optional(),
});
export type ColorReplace = z.infer<typeof colorReplaceSchema>;

export const gradeSchema = z.object({
  exposure: z.number().min(-2).max(2).default(0),
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(-1).max(1).default(0),
  highlights: z.number().min(-1).max(1).default(0),
  shadows: z.number().min(-1).max(1).default(0),
  whites: z.number().min(-1).max(1).default(0),
  blacks: z.number().min(-1).max(1).default(0),
  saturation: z.number().min(-1).max(1).default(0),
  vibrance: z.number().min(-1).max(1).default(0),
  temperature: z.number().min(-1).max(1).default(0),
  tint: z.number().min(-1).max(1).default(0),
  hue: z.number().min(-180).max(180).default(0),
  fade: z.number().min(0).max(1).default(0),
  blur: z.number().min(0).max(20).default(0),
  sharpen: z.number().min(0).max(2).default(0),
  vignette: z.number().min(0).max(1).default(0),
  grain: z.number().min(0).max(1).default(0),
  glow: z.number().min(0).max(1).default(0),
  lift: rgbTriple.optional(),
  gamma: rgbTriple.optional(),
  gain: rgbTriple.optional(),
  curves: z.object({ master: curve.optional(), r: curve.optional(), g: curve.optional(), b: curve.optional() }).optional(),
  hsl: z.record(z.enum(HSL_BANDS.map((b) => b.key) as [HslBand, ...HslBand[]]), hslAdjust).optional(),
  replace: z.array(colorReplaceSchema).max(4).optional(),
  /** Custom .cube LUT (uploaded asset) blended by `strength`. */
  lut: z.object({ assetId: z.string().uuid(), strength: z.number().min(0).max(1).default(1) }).optional(),
});
export type GradeSettings = z.infer<typeof gradeSchema>;

// ------------------------------------------------------------------ colour helpers

export const hexToRgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
export const rgbToHex = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h / 360 + 1 / 3), f(h / 360), f(h / 360 - 1 / 3)];
}

const hueDist = (a: number, b: number) => {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
};

/** Monotone cubic interpolation through curve points (Fritsch–Carlson); x sorted ascending. */
export function curveFn(points: [number, number][] | undefined): ((x: number) => number) | null {
  if (!points || points.length < 2) return null;
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  const dx = p.slice(0, -1).map((q, i) => p[i + 1]![0] - q[0] || 1e-6);
  const m = p.slice(0, -1).map((q, i) => (p[i + 1]![1] - q[1]) / dx[i]!);
  const t = p.map((_, i) => (i === 0 ? m[0]! : i === n - 1 ? m[n - 2]! : m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const h = a * a + b * b;
    if (h > 9) {
      const k = 3 / Math.sqrt(h);
      t[i] = k * a * m[i]!;
      t[i + 1] = k * b * m[i]!;
    }
  }
  return (x: number) => {
    if (x <= p[0]![0]) return p[0]![1];
    if (x >= p[n - 1]![0]) return p[n - 1]![1];
    let i = 0;
    while (x > p[i + 1]![0]) i++;
    const h = dx[i]!;
    const u = (x - p[i]![0]) / h;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
    const h10 = u ** 3 - 2 * u ** 2 + u;
    const h01 = -2 * u ** 3 + 3 * u ** 2;
    const h11 = u ** 3 - u ** 2;
    return h00 * p[i]![1] + h10 * h * t[i]! + h01 * p[i + 1]![1] + h11 * h * t[i + 1]!;
  };
}

// ------------------------------------------------------------------ the grade function

export type Lut3d = { size: number; data: Float32Array };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Weight (0–1) of a pixel for a colour replacement, by hue distance, with soft falloff; greys excluded. */
export function replaceWeight(rep: Pick<ColorReplace, 'from' | 'range' | 'softness'>, h: number, s: number, l: number): number {
  const [fh, fs] = rgbToHsl(...hexToRgb(rep.from));
  const width = rep.range * 90;
  const soft = Math.max(1, rep.softness * width);
  const d = hueDist(h, fh);
  let w = d <= width ? 1 : d >= width + soft ? 0 : 1 - (d - width) / soft;
  // Colourless pixels never match a colour; keep near-black/white out too.
  const satGate = clamp01((s - Math.min(0.12, fs * 0.5)) / 0.12);
  const lumGate = clamp01(Math.min(l, 1 - l) / 0.06);
  w *= satGate * lumGate;
  return w;
}

export function applyReplace(rep: ColorReplace, rgb: [number, number, number], weight?: number): [number, number, number] {
  const [h, s, l] = rgbToHsl(...rgb);
  const w = (weight ?? replaceWeight(rep, h, s, l)) * rep.strength;
  if (w <= 0) return rgb;
  const [fh, fs] = rgbToHsl(...hexToRgb(rep.from));
  const [th, ts, tl] = rgbToHsl(...hexToRgb(rep.to));
  const [fl] = [rgbToHsl(...hexToRgb(rep.from))[2]];
  // Move the hue onto the target; scale saturation relative to the picked colour; keep shading.
  const nh = h + ((((th - fh + 540) % 360) - 180));
  const ns = clamp01(fs > 0.02 ? (s * ts) / fs : ts);
  const nl = rep.keepLightness ? l : clamp01(l + (tl - fl));
  const out = hslToRgb(nh, ns, nl);
  return [rgb[0] + (out[0] - rgb[0]) * w, rgb[1] + (out[1] - rgb[1]) * w, rgb[2] + (out[2] - rgb[2]) * w];
}

/** Compile a grade into a per-pixel function (curves and bands prepared once). */
export function gradeFunction(input: Partial<GradeSettings> | undefined, lut?: Lut3d | null): (rgb: [number, number, number]) => [number, number, number] {
  const a = gradeSchema.parse(input ?? {});
  const exp = 2 ** a.exposure;
  const temp = [1 + 0.18 * a.temperature + 0.06 * a.tint, 1 - 0.12 * a.tint, 1 - 0.18 * a.temperature + 0.06 * a.tint];
  const sat = 1 + a.saturation;
  const slope = 1 + a.contrast;
  const tone = a.highlights || a.shadows ? curveFn([[0, 0], [0.25, 0.25 + 0.12 * a.shadows], [0.5, 0.5], [0.75, 0.75 + 0.12 * a.highlights], [1, 1]]) : null;
  const blackPoint = -0.12 * a.blacks;
  const whitePoint = 1 - 0.12 * a.whites;
  const lift = a.lift ?? { r: 0, g: 0, b: 0 };
  const gam = a.gamma ?? { r: 0, g: 0, b: 0 };
  const gain = a.gain ?? { r: 0, g: 0, b: 0 };
  const lgg = [
    [lift.r * 0.5, 2 ** -gam.r, 1 + gain.r],
    [lift.g * 0.5, 2 ** -gam.g, 1 + gain.g],
    [lift.b * 0.5, 2 ** -gam.b, 1 + gain.b],
  ];
  const hasLgg = [lift, gam, gain].some((x) => x.r || x.g || x.b);
  const cm = curveFn(a.curves?.master);
  const cc = [curveFn(a.curves?.r), curveFn(a.curves?.g), curveFn(a.curves?.b)];
  const bands = a.hsl ? HSL_BANDS.flatMap((b) => (a.hsl![b.key] && (a.hsl![b.key]!.h || a.hsl![b.key]!.s || a.hsl![b.key]!.l) ? [{ hue: b.hue, ...a.hsl![b.key]! }] : [])) : [];
  const replaces = (a.replace ?? []).filter((r) => !r.mask);
  const rad = (a.hue * Math.PI) / 180;
  const ch = Math.cos(rad);
  const sh = Math.sin(rad);
  const hue = a.hue
    ? [0.213 + ch * 0.787 - sh * 0.213, 0.715 - ch * 0.715 - sh * 0.715, 0.072 - ch * 0.072 + sh * 0.928, 0.213 - ch * 0.213 + sh * 0.143, 0.715 + ch * 0.285 + sh * 0.14, 0.072 - ch * 0.072 - sh * 0.283, 0.213 - ch * 0.213 - sh * 0.787, 0.715 - ch * 0.715 + sh * 0.715, 0.072 + ch * 0.928 + sh * 0.072]
    : null;

  return (input3) => {
    let r = input3[0] * exp * temp[0]!;
    let g = input3[1] * exp * temp[1]!;
    let b = input3[2] * exp * temp[2]!;
    if (hue) [r, g, b] = [hue[0]! * r + hue[1]! * g + hue[2]! * b, hue[3]! * r + hue[4]! * g + hue[5]! * b, hue[6]! * r + hue[7]! * g + hue[8]! * b];
    r = clamp01(r);
    g = clamp01(g);
    b = clamp01(b);
    // Saturation and vibrance (vibrance boosts muted colours more than saturated ones).
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (sat !== 1 || a.vibrance) {
      const cur = Math.max(r, g, b) - Math.min(r, g, b);
      const k = sat * (1 + a.vibrance * (1 - cur) * (a.vibrance > 0 ? 1 : 0.6));
      r = clamp01(lum + (r - lum) * k);
      g = clamp01(lum + (g - lum) * k);
      b = clamp01(lum + (b - lum) * k);
    }
    if (bands.length || replaces.length) {
      let [hh, ss, ll] = rgbToHsl(r, g, b);
      for (const band of bands) {
        const d = hueDist(hh, band.hue);
        const w = d >= 40 ? 0 : 0.5 + 0.5 * Math.cos((d / 40) * Math.PI);
        if (w <= 0 || ss < 0.02) continue;
        hh += band.h * w;
        ss = clamp01(ss * (1 + band.s * w));
        ll = clamp01(ll + band.l * 0.3 * w * ss);
      }
      [r, g, b] = hslToRgb(hh, ss, ll);
      for (const rep of replaces) [r, g, b] = applyReplace(rep, [r, g, b]);
    }
    const ch3 = [r, g, b];
    for (let i = 0; i < 3; i++) {
      let v = ch3[i]!;
      v = (v - blackPoint) / Math.max(0.05, whitePoint - blackPoint); // blacks / whites
      v = clamp01(v * slope + 0.5 * (1 - slope) + 0.5 * a.brightness);
      if (tone) v = clamp01(tone(v));
      if (hasLgg) {
        const [l0, gm, gn] = lgg[i]!;
        v = clamp01(gn! * Math.pow(clamp01(v + l0! * (1 - v)), gm!));
      }
      if (cm) v = clamp01(cm(v));
      const c = cc[i];
      if (c) v = clamp01(c(v));
      if (a.fade) v = v * (1 - 0.22 * a.fade) + 0.1 * a.fade;
      ch3[i] = v;
    }
    let out = ch3 as [number, number, number];
    if (lut && input && (input as GradeSettings).lut) {
      const k = (input as GradeSettings).lut!.strength ?? 1;
      const l = sampleLut(lut, out);
      out = [out[0] + (l[0] - out[0]) * k, out[1] + (l[1] - out[1]) * k, out[2] + (l[2] - out[2]) * k];
    }
    return out;
  };
}

export const isNeutralGrade = (a?: Partial<GradeSettings>) =>
  !a ||
  Object.entries(a).every(([k, v]) => {
    if (v === undefined || v === null) return true;
    if (typeof v === 'number') return v === 0;
    if (k === 'replace') return !(v as unknown[]).length;
    if (k === 'lift' || k === 'gamma' || k === 'gain') return !Object.values(v as Record<string, number>).some(Boolean);
    if (k === 'hsl') return !Object.values(v as Record<string, Record<string, number>>).some((b) => b.h || b.s || b.l);
    if (k === 'curves') return !Object.values(v as Record<string, unknown>).some(Boolean);
    return false;
  });

/** Grade settings that need the colour LUT (anything that is a per-pixel colour transform). */
export const needsLut = (a?: Partial<GradeSettings>) => {
  if (!a) return false;
  const { blur: _b, sharpen: _s, vignette: _v, grain: _g, glow: _gl, ...rest } = a;
  void _b; void _s; void _v; void _g; void _gl;
  return !isNeutralGrade({ ...rest, replace: (a.replace ?? []).filter((r) => !r.mask) });
};

// ------------------------------------------------------------------ 3D LUTs

/** Bake a grade into an N³ RGB LUT (red fastest, as in .cube files). */
export function buildLut(fn: (rgb: [number, number, number]) => [number, number, number], size = 33): Lut3d {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const o = fn([r / (size - 1), g / (size - 1), b / (size - 1)]);
        data[i++] = o[0];
        data[i++] = o[1];
        data[i++] = o[2];
      }
  return { size, data };
}

export function sampleLut(lut: Lut3d, [r, g, b]: [number, number, number]): [number, number, number] {
  const n = lut.size - 1;
  const fr = clamp01(r) * n;
  const fg = clamp01(g) * n;
  const fb = clamp01(b) * n;
  const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
  const r1 = Math.min(n, r0 + 1), g1 = Math.min(n, g0 + 1), b1 = Math.min(n, b0 + 1);
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  const at = (ri: number, gi: number, bi: number, c: number) => lut.data[((bi * lut.size + gi) * lut.size + ri) * 3 + c]!;
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) * (1 - dr) + at(r1, g0, b0, c) * dr;
    const c10 = at(r0, g1, b0, c) * (1 - dr) + at(r1, g1, b0, c) * dr;
    const c01 = at(r0, g0, b1, c) * (1 - dr) + at(r1, g0, b1, c) * dr;
    const c11 = at(r0, g1, b1, c) * (1 - dr) + at(r1, g1, b1, c) * dr;
    out.push((c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db);
  }
  return out as [number, number, number];
}

export function lutToCube(lut: Lut3d, title = 'Framecraft grade'): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${lut.size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let i = 0; i < lut.data.length; i += 3) lines.push(`${lut.data[i]!.toFixed(6)} ${lut.data[i + 1]!.toFixed(6)} ${lut.data[i + 2]!.toFixed(6)}`);
  return `${lines.join('\n')}\n`;
}

/** Parse a .cube 3D LUT (Adobe/Resolve format). Throws on anything unexpected. */
export function parseCube(text: string): Lut3d {
  let size = 0;
  const values: number[] = [];
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^TITLE/i.test(line)) continue;
    if (/^LUT_1D_SIZE/i.test(line)) throw new Error('1D LUTs are not supported — export a 3D .cube');
    const m = line.match(/^LUT_3D_SIZE\s+(\d+)/i);
    if (m) {
      size = Number(m[1]);
      if (size < 2 || size > 65) throw new Error('LUT size must be between 2 and 65');
      continue;
    }
    if (/^DOMAIN_MIN/i.test(line)) {
      min = line.split(/\s+/).slice(1).map(Number);
      continue;
    }
    if (/^DOMAIN_MAX/i.test(line)) {
      max = line.split(/\s+/).slice(1).map(Number);
      continue;
    }
    const parts = line.split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) throw new Error(`Unexpected line in .cube: "${line.slice(0, 40)}"`);
    values.push(...parts.map((v, i) => (v - min[i]!) / ((max[i]! - min[i]!) || 1)));
  }
  if (!size || values.length !== size ** 3 * 3) throw new Error('Incomplete .cube file');
  return { size, data: Float32Array.from(values) };
}

/** Looks: starting points that set real grade values (all editable afterwards). */
export const LOOKS: { key: string; label: string; grade: Partial<GradeSettings> }[] = [
  { key: 'cinematic', label: 'Cinematic teal & orange', grade: { contrast: 0.18, saturation: -0.05, lift: { r: -0.04, g: 0.0, b: 0.08 }, gain: { r: 0.06, g: 0.02, b: -0.06 }, highlights: -0.15, vignette: 0.25 } },
  { key: 'luxury', label: 'Luxury warm', grade: { exposure: 0.05, contrast: 0.12, temperature: 0.25, vibrance: 0.15, highlights: -0.2, blacks: 0.1, glow: 0.25, vignette: 0.2 } },
  { key: 'clean', label: 'Clean bright', grade: { exposure: 0.15, contrast: 0.08, whites: 0.2, vibrance: 0.2, shadows: 0.15 } },
  { key: 'vintage', label: 'Vintage film', grade: { contrast: -0.1, saturation: -0.25, fade: 0.45, temperature: 0.2, tint: 0.05, grain: 0.35, vignette: 0.35 } },
  { key: 'bw', label: 'Black & white', grade: { saturation: -1, contrast: 0.2, grain: 0.15 } },
  { key: 'moody', label: 'Moody', grade: { exposure: -0.15, contrast: 0.22, saturation: -0.2, temperature: -0.15, shadows: -0.2, vignette: 0.4 } },
  { key: 'pop', label: 'Social pop', grade: { contrast: 0.15, saturation: 0.25, vibrance: 0.3, sharpen: 0.4 } },
  { key: 'soft', label: 'Soft focus', grade: { contrast: -0.12, highlights: 0.1, glow: 0.5, fade: 0.15 } },
];
