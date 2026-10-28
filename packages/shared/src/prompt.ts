import { CAMERA_PRESETS, COLOR_GRADES, FILM_STYLES, LENSES, LIGHTING_PRESETS, STYLE_PRESETS } from './constants';
import { CARTOON_STYLES } from './cartoon';

type Directives = {
  style?: string;
  camera?: string;
  lighting?: string;
  lens?: string;
  colorGrade?: string;
  mood?: string;
  shotType?: string;
  filmStyle?: string;
};

const lookup = <T extends { key: string; prompt: string }>(list: readonly T[], key?: string) =>
  key ? list.find((x) => x.key === key)?.prompt ?? '' : '';

/**
 * Translate structured creative directives into prompt language.
 * Used for every model: camera presets become text instructions unless the
 * provider adapter maps them to a real camera-control parameter.
 */
export function directivesToText(d: Directives, opts: { includeCamera?: boolean } = {}): string[] {
  const parts: string[] = [];
  if (d.shotType) parts.push(`${d.shotType.toLowerCase()} shot`);
  if (opts.includeCamera !== false) {
    const cam = lookup(CAMERA_PRESETS, d.camera);
    if (cam) parts.push(cam);
  }
  const lens = lookup(LENSES, d.lens);
  if (lens) parts.push(lens);
  const light = lookup(LIGHTING_PRESETS, d.lighting);
  if (light) parts.push(light);
  const style = lookup(STYLE_PRESETS, d.style) || lookup(CARTOON_STYLES, d.style);
  if (style) parts.push(style);
  const film = lookup(FILM_STYLES, d.filmStyle);
  if (film) parts.push(film);
  const grade = lookup(COLOR_GRADES, d.colorGrade);
  if (grade) parts.push(grade);
  if (d.mood) parts.push(`${d.mood.toLowerCase()} mood`);
  return parts;
}

/** Deterministic prompt composition (no LLM). */
export function composePrompt(base: string, d: Directives, opts: { includeCamera?: boolean } = {}): string {
  const cleaned = base.trim().replace(/\s+/g, ' ');
  const extras = directivesToText(d, opts).filter((p) => !cleaned.toLowerCase().includes(p.toLowerCase()));
  if (!extras.length) return cleaned;
  const sep = /[.!?]$/.test(cleaned) ? ' ' : '. ';
  return `${cleaned}${sep}${extras.map((e, i) => (i === 0 ? e.charAt(0).toUpperCase() + e.slice(1) : e)).join(', ')}.`;
}
