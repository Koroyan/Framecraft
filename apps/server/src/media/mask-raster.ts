import fsp from 'node:fs/promises';
import type { EditMask } from '@framecraft/shared';

/** Rasterise a normalised selection to an 8-bit greyscale PGM (white = edit here). */
export async function writeMaskPgm(mask: EditMask, width: number, height: number, file: string): Promise<void> {
  const px = new Uint8Array(width * height);
  const paint = (inside: (x: number, y: number) => boolean, value: number, box: [number, number, number, number]) => {
    const [x0, y0, x1, y1] = [Math.max(0, Math.floor(box[0] * width)), Math.max(0, Math.floor(box[1] * height)), Math.min(width - 1, Math.ceil(box[2] * width)), Math.min(height - 1, Math.ceil(box[3] * height))];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside((x + 0.5) / width, (y + 0.5) / height)) px[y * width + x] = value;
  };
  for (const r of mask.rects) {
    const inside = r.ellipse
      ? (x: number, y: number) => ((x - (r.x + r.w / 2)) / (r.w / 2)) ** 2 + ((y - (r.y + r.h / 2)) / (r.h / 2)) ** 2 <= 1
      : (x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    paint(inside, r.subtract ? 0 : 255, [r.x, r.y, r.x + r.w, r.y + r.h]);
  }
  for (const poly of mask.polygons) {
    const pts = poly.points;
    const inside = (x: number, y: number) => {
      let c = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]!;
        const [xj, yj] = pts[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    paint(inside, poly.subtract ? 0 : 255, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  for (const s of mask.strokes) {
    // Brush: distance (in frame-width units) from each pixel to the polyline ≤ radius.
    const aspect = height / width;
    const pts = s.points.map(([x, y]) => [x, y * aspect] as const);
    const inside = (x: number, y: number) => {
      const py = y * aspect;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i]!;
        const [bx, by] = pts[Math.min(i + 1, pts.length - 1)]!;
        const dx = bx - ax;
        const dy = by - ay;
        const len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (py - ay) * dy) / len)) : 0;
        if ((x - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2 <= s.radius ** 2) return true;
      }
      return false;
    };
    const xs = s.points.map((p) => p[0]);
    const ys = s.points.map((p) => p[1]);
    paint(inside, s.subtract ? 0 : 255, [Math.min(...xs) - s.radius, Math.min(...ys) - s.radius / aspect, Math.max(...xs) + s.radius, Math.max(...ys) + s.radius / aspect]);
  }
  if (mask.invert) for (let i = 0; i < px.length; i++) px[i] = 255 - px[i]!;
  await fsp.writeFile(file, Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), Buffer.from(px)]));
}

