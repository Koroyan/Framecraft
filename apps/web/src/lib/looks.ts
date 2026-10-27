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
