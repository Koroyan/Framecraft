/** A rough colour preview of a look from its temperature / saturation / exposure. */
export function lookSwatch(g: Record<string, unknown>) {
  const temp = Number(g.temperature ?? 0);
  const sat = Number(g.saturation ?? 0) + Number(g.vibrance ?? 0);
  const exp = Number(g.exposure ?? 0);
  const warm = Math.round(120 + temp * 200);
  const cool = Math.round(140 - temp * 160);
  const l = Math.round(40 + exp * 60);
  return `linear-gradient(90deg, hsl(${cool + 60}, ${Math.round(30 + sat * 60)}%, ${l - 15}%), hsl(${warm - 90}, ${Math.round(45 + sat * 60)}%, ${l + 15}%))`;
}

/** Is this look what the clip currently has? (Every value the look sets matches.) */
export function lookActive(look: Record<string, unknown>, grade: Record<string, unknown> | undefined) {
  if (!grade) return false;
  const keys = Object.keys(look);
  return keys.length > 0 && keys.every((k) => {
    const a = look[k];
    const b = grade[k];
    return typeof a === 'number' ? typeof b === 'number' && Math.abs(a - b) < 1e-3 : JSON.stringify(a) === JSON.stringify(b);
  });
}

/**
 * A CSS filter that roughly shows a clip's grade on thumbnails (storyboard cards, timeline strip),
 * so a black-and-white or warmed clip looks like that everywhere — the preview and export are exact.
 */
export function gradeCss(a: Record<string, unknown> | undefined): string | undefined {
  if (!a) return undefined;
  const n = (k: string) => Number(a[k] ?? 0) || 0;
  const parts: string[] = [];
  const sat = Math.max(0, 1 + n('saturation') + 0.5 * n('vibrance'));
  if (Math.abs(sat - 1) > 0.01) parts.push(`saturate(${sat.toFixed(2)})`);
  if (n('contrast')) parts.push(`contrast(${(1 + n('contrast')).toFixed(2)})`);
  const br = Math.pow(2, n('exposure')) * (1 + n('brightness'));
  if (Math.abs(br - 1) > 0.01) parts.push(`brightness(${br.toFixed(2)})`);
  if (n('temperature') > 0.02) parts.push(`sepia(${Math.min(0.45, n('temperature') * 0.45).toFixed(2)})`);
  if (n('hue')) parts.push(`hue-rotate(${Math.round(n('hue'))}deg)`);
  return parts.join(' ') || undefined;
}
