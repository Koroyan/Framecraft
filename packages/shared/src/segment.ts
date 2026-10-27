/*
 * Click-to-select ("smart select") without a model download: from the clicked pixel, every pixel
 * gets the smallest possible "worst colour difference" along any path back to the click (a minimax
 * geodesic in CIELAB, with an edge penalty), computed once with a Dijkstra pass. Thresholding that
 * map gives nested selections; the automatic threshold is where the selection is most stable (the
 * object's edge), and the tightness control just moves the threshold — no recomputation.
 *
 * It is strong on objects that differ in colour or brightness from their surroundings (clothing,
 * products, cars, signs) and weaker on busy textures; the editor always offers add / subtract
 * clicks and brush / lasso / rectangle corrections.
 */

export type ImageLike = { data: Uint8ClampedArray | Uint8Array; width: number; height: number; channels?: 3 | 4 };

export type PreparedFrame = {
  width: number;
  height: number;
  /** Working CIELAB (L weighted later), lightly smoothed. */
  L: Float32Array;
  A: Float32Array;
  B: Float32Array;
  /** Gradient magnitude per channel group. */
  gL: Float32Array;
  gC: Float32Array;
  rgb: Uint8Array;
};

export type Selection = {
  seed: number;
  /** Minimax distance of every pixel (Infinity = never reached). */
  D: Float32Array;
  /** Distances of pixels in the order they joined (ascending). */
  sorted: Float32Array;
  auto: number;
  minArea: number;
  /** The colour the growth measured against (re-used to find the object on other frames). */
  ref: ColorRef;
};

export type Region = {
  /** Outline in normalised coordinates (0–1), at most ~180 points. */
  polygon: [number, number][];
  /** Fraction of the frame covered. */
  area: number;
  bounds: { x0: number; y0: number; x1: number; y1: number };
  /** Mean colour of the selected pixels (#RRGGBB). */
  color: string;
  threshold: number;
  mask: Uint8Array;
};

// ------------------------------------------------------------------ preparation

const LIN = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

function boxBlur(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const a = src[row + Math.max(0, x - 1)]!;
      const b = src[row + x]!;
      const c = src[row + Math.min(w - 1, x + 1)]!;
      tmp[row + x] = (a + b + c) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w;
    const row = y * w;
    const dn = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) out[row + x] = (tmp[up + x]! + tmp[row + x]! + tmp[dn + x]!) / 3;
  }
  return out;
}

function sobel(ch: Float32Array, w: number, h: number, out: Float32Array, weight: number) {
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = ch[i - w + 1]! + 2 * ch[i + 1]! + ch[i + w + 1]! - ch[i - w - 1]! - 2 * ch[i - 1]! - ch[i + w - 1]!;
      const gy = ch[i + w - 1]! + 2 * ch[i + w]! + ch[i + w + 1]! - ch[i - w - 1]! - 2 * ch[i - w]! - ch[i - w + 1]!;
      out[i] = out[i]! + (weight * Math.sqrt(gx * gx + gy * gy)) / 4;
    }
  }
}

/** Convert a frame once (CIELAB + gradients); reuse it for every click on the same frame. */
export function prepareFrame(img: ImageLike): PreparedFrame {
  const { width: w, height: h } = img;
  const ch = img.channels ?? 4;
  const n = w * h;
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  const rgb = new Uint8Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += ch) {
    const r8 = img.data[j]!, g8 = img.data[j + 1]!, b8 = img.data[j + 2]!;
    rgb[i * 3] = r8;
    rgb[i * 3 + 1] = g8;
    rgb[i * 3 + 2] = b8;
    const r = LIN[r8]!, g = LIN[g8]!, b = LIN[b8]!;
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const fy = f(Y);
    L[i] = 116 * fy - 16;
    A[i] = 500 * (f(X) - fy);
    B[i] = 200 * (fy - f(Z));
  }
  const Ls = boxBlur(L, w, h);
  const As = boxBlur(A, w, h);
  const Bs = boxBlur(B, w, h);
  const gL = new Float32Array(n);
  const gC = new Float32Array(n);
  sobel(Ls, w, h, gL, 1);
  sobel(As, w, h, gC, 1);
  sobel(Bs, w, h, gC, 1);
  return { width: w, height: h, L: Ls, A: As, B: Bs, gL, gC, rgb };
}

// ------------------------------------------------------------------ selection

/** Min-heap of pixel indices keyed by a float (lazy deletion). */
class Heap {
  private keys: Float32Array;
  private vals: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.keys = new Float32Array(cap);
    this.vals = new Int32Array(cap);
  }
  push(k: number, v: number) {
    if (this.size === this.keys.length) {
      const nk = new Float32Array(this.keys.length * 2);
      nk.set(this.keys);
      const nv = new Int32Array(this.vals.length * 2);
      nv.set(this.vals);
      this.keys = nk;
      this.vals = nv;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= k) break;
      this.keys[i] = this.keys[p]!;
      this.vals[i] = this.vals[p]!;
      i = p;
    }
    this.keys[i] = k;
    this.vals[i] = v;
  }
  pop(): [number, number] {
    const k0 = this.keys[0]!;
    const v0 = this.vals[0]!;
    const k = this.keys[--this.size]!;
    const v = this.vals[this.size]!;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1]! < this.keys[c]!) c++;
      if (this.keys[c]! >= k) break;
      this.keys[i] = this.keys[c]!;
      this.vals[i] = this.vals[c]!;
      i = c;
    }
    this.keys[i] = k;
    this.vals[i] = v;
    return [k0, v0];
  }
}

const MAX_T = 70;

/** Grow from the clicked pixel (x, y in the frame's pixels). */
export function selectFrom(p: PreparedFrame, x: number, y: number): Selection {
  const { width: w, height: h } = p;
  const n = w * h;
  const sx = Math.min(w - 1, Math.max(0, Math.round(x)));
  const sy = Math.min(h - 1, Math.max(0, Math.round(y)));
  const seed = sy * w + sx;
  // Seed colour: neighbours similar to the clicked pixel (never straddle an edge).
  let mL = 0, mA = 0, mB = 0, cnt = 0;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const xx = sx + dx, yy = sy + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const i = yy * w + xx;
      const d = Math.hypot(p.L[i]! - p.L[seed]!, p.A[i]! - p.A[seed]!, p.B[i]! - p.B[seed]!);
      if (d > 12) continue;
      mL += p.L[i]!;
      mA += p.A[i]!;
      mB += p.B[i]!;
      cnt++;
    }
  mL /= cnt;
  mA /= cnt;
  mB /= cnt;
  // Colourful objects: hue matters more than shading (folds, highlights) → weigh lightness down.
  const chroma = Math.hypot(mA, mB);
  const ref: ColorRef = { L: mL, A: mA, B: mB, wL: chroma > 18 ? 0.45 : chroma > 8 ? 0.7 : 1 };
  const { D, sorted } = grow(p, colorCost(p, ref), [seed]);
  const minArea = Math.max(24, Math.round(n * 0.0006));
  return { seed, D, sorted, auto: autoThreshold(sorted, n, minArea), minArea, ref };
}

/** The object's colour as selected (CIELAB) and how much lightness counts. */
export type ColorRef = { L: number; A: number; B: number; wL: number };

/** Per-pixel cost of joining the object: colour distance to it plus an edge penalty. */
function colorCost(p: PreparedFrame, ref: ColorRef, allowed?: Uint8Array): Float32Array {
  const n = p.width * p.height;
  const cost = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (allowed && !allowed[i]) {
      cost[i] = Infinity;
      continue;
    }
    const dL = (p.L[i]! - ref.L) * ref.wL;
    const dA = p.A[i]! - ref.A;
    const dB = p.B[i]! - ref.B;
    cost[i] = Math.sqrt(dL * dL + dA * dA + dB * dB) + 0.3 * (p.gL[i]! * ref.wL + p.gC[i]!);
  }
  return cost;
}

/** Minimax geodesic growth from the seeds (Dijkstra); distances in joining order. */
function grow(p: PreparedFrame, cost: Float32Array, seeds: number[], limit = MAX_T) {
  const { width: w, height: h } = p;
  const n = w * h;
  void h;
  const D = new Float32Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const sorted = new Float32Array(n);
  let m = 0;
  const heap = new Heap(Math.min(n, 1 << 16));
  for (const s of seeds) {
    D[s] = 0;
    heap.push(0, s);
  }
  while (heap.size) {
    const [d, i] = heap.pop();
    if (done[i] || d > D[i]!) continue;
    if (d > limit) break;
    done[i] = 1;
    sorted[m++] = d;
    const xx = i % w;
    const relax = (j: number) => {
      if (done[j]) return;
      const nd = Math.max(d, cost[j]!);
      if (nd < D[j]!) {
        D[j] = nd;
        heap.push(nd, j);
      }
    };
    if (xx > 0) relax(i - 1);
    if (xx < w - 1) relax(i + 1);
    if (i >= w) relax(i - w);
    if (i < n - w) relax(i + w);
  }
  return { D, sorted: sorted.subarray(0, m) };
}

/** Count of pixels with D ≤ t (sorted ascending). */
function areaAt(sorted: Float32Array, t: number) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The threshold at the object's edge: the middle of the first stable plateau of the area curve
 * (later plateaus are usually leaks into the background); else the most stable threshold.
 */
function autoThreshold(sorted: Float32Array, n: number, minArea: number): number {
  const ts: number[] = [];
  for (let t = 3; t <= MAX_T; t *= 1.14) ts.push(t);
  const areas = ts.map((t) => areaAt(sorted, t));
  const valid = (k: number) => areas[k]! >= minArea && areas[k]! <= n * 0.6;
  const stability = (k: number) => (areas[k + 1]! - areas[k - 1]!) / Math.max(1, areas[k]!);
  const STABLE = 0.12;
  for (let k = 1; k < ts.length - 1; k++) {
    if (!valid(k) || stability(k) >= STABLE) continue;
    let j = k;
    while (j + 1 < ts.length - 1 && valid(j + 1) && stability(j + 1) < STABLE) j++;
    return ts[Math.round((k + j) / 2)]!;
  }
  let best = -1;
  let bs = Infinity;
  for (let k = 1; k < ts.length - 1; k++) {
    if (!valid(k)) continue;
    const s = stability(k);
    if (s < bs) {
      bs = s;
      best = k;
    }
  }
  if (best >= 0) return ts[best]!;
  const k = areas.findIndex((a) => a >= minArea);
  return ts[Math.max(0, k)] ?? 10;
}

// ------------------------------------------------------------------ region → outline

function dilate(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] = src[i] || (x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1]) || (y > 0 && src[i - w]) || (y < h - 1 && src[i + w]) ? 1 : 0;
    }
  return out;
}
function erode(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] = src[i] && (x === 0 || src[i - 1]) && (x === w - 1 || src[i + 1]) && (y === 0 || src[i - w]) && (y === h - 1 || src[i + w]) ? 1 : 0;
    }
  return out;
}

function flood(mask: Uint8Array, w: number, h: number, starts: number[], value: number): Uint8Array {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let sp = 0;
  for (const s of starts) {
    if (mask[s] !== value || seen[s]) continue;
    seen[s] = 1;
    stack[sp++] = s;
  }
  while (sp) {
    const i = stack[--sp]!;
    const x = i % w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < mask.length - w ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || seen[j] || mask[j] !== value) continue;
      seen[j] = 1;
      stack[sp++] = j;
    }
  }
  void h;
  return seen;
}

/**
 * Outer boundary of a mask by marching squares, as pixel-corner coordinates, clockwise. Starts at
 * the topmost-leftmost pixel `first`; saddle cells are resolved by the incoming direction.
 */
function trace(mask: Uint8Array, w: number, h: number, first: number): [number, number][] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const UP = 0, RIGHT = 1, DOWN = 2, LEFT = 3, NONE = -1;
  const sx = (first % w) - 1;
  const sy = Math.floor(first / w) - 1;
  let x = sx, y = sy;
  let prev = NONE;
  const out: [number, number][] = [];
  for (let guard = 0; guard < (w + 2) * (h + 2) * 2; guard++) {
    const state = (inside(x, y) ? 1 : 0) | (inside(x + 1, y) ? 2 : 0) | (inside(x, y + 1) ? 4 : 0) | (inside(x + 1, y + 1) ? 8 : 0);
    let next: number;
    switch (state) {
      case 1: case 5: case 13: next = UP; break;
      case 2: case 3: case 7: next = RIGHT; break;
      case 4: case 12: case 14: next = LEFT; break;
      case 8: case 10: case 11: next = DOWN; break;
      case 6: next = prev === UP ? LEFT : RIGHT; break;
      case 9: next = prev === RIGHT ? UP : DOWN; break;
      default: next = NONE;
    }
    if (next === NONE) break;
    if (next !== prev) out.push([x + 1, y + 1]); // keep corners only (straight runs add nothing)
    prev = next;
    if (next === UP) y--;
    else if (next === DOWN) y++;
    else if (next === LEFT) x--;
    else x++;
    if (x === sx && y === sy) break;
  }
  return out;
}

function simplifyOpen(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const len = Math.hypot(bx - ax, by - ay);
    let far = -1, dmax = 0;
    for (let i = a + 1; i < b; i++) {
      const d = len > 1e-9 ? Math.abs((bx - ax) * (ay - pts[i]![1]) - (ax - pts[i]![0]) * (by - ay)) / len : Math.hypot(pts[i]![0] - ax, pts[i]![1] - ay);
      if (d > dmax) {
        dmax = d;
        far = i;
      }
    }
    if (dmax > eps && far > 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Douglas–Peucker on a closed outline: split at the point farthest from the start. */
function simplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 5) return pts;
  let far = 0, dmax = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i]![0] - pts[0]![0], pts[i]![1] - pts[0]![1]);
    if (d > dmax) {
        dmax = d;
        far = i;
      }
  }
  const a = simplifyOpen(pts.slice(0, far + 1), eps);
  const b = simplifyOpen([...pts.slice(far), pts[0]!], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Build the selection at threshold t (use `sel.auto`, or scale it with a tightness control). */
export function regionAt(p: PreparedFrame, sel: Selection, t: number): Region | null {
  const { width: w, height: h } = p;
  const n = w * h;
  let mask: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (sel.D[i]! <= t) mask[i] = 1;
  // Close small gaps; then grow back the 1–2 px the edge penalty kept out; fill holes; keep the clicked part.
  mask = erode(erode(dilate(dilate(mask, w, h), w, h), w, h), w, h);
  mask = dilate(dilate(mask, w, h), w, h);
  mask[sel.seed] = 1;
  const borders: number[] = [];
  for (let x = 0; x < w; x++) borders.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) borders.push(y * w, y * w + w - 1);
  const outside = flood(mask, w, h, borders, 0);
  for (let i = 0; i < n; i++) if (!mask[i] && !outside[i]) mask[i] = 1;
  const comp = flood(mask, w, h, [sel.seed], 1);
  let area = 0, r = 0, g = 0, b = 0, first = -1;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let i = 0; i < n; i++) {
    mask[i] = comp[i]!;
    if (!comp[i]) continue;
    if (first < 0) first = i;
    area++;
    r += p.rgb[i * 3]!;
    g += p.rgb[i * 3 + 1]!;
    b += p.rgb[i * 3 + 2]!;
    const x = i % w, y = (i / w) | 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (area < Math.min(sel.minArea, 12) || first < 0) return null;
  const outline = trace(mask, w, h, first);
  let eps = 0.7;
  let poly = simplify(outline, eps);
  while (poly.length > 180 && eps < 12) poly = simplify(outline, (eps *= 1.5));
  if (poly.length < 3) poly = [[x0, y0], [x1 + 1, y0], [x1 + 1, y1 + 1], [x0, y1 + 1]];
  const hx = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return {
    polygon: poly.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]),
    area: area / n,
    bounds: { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h },
    color: `#${hx(r / area)}${hx(g / area)}${hx(b / area)}`.toUpperCase(),
    threshold: t,
    mask,
  };
}

/**
 * Outlines of a mask's separate parts (pixel-corner coordinates), largest first, each simplified to
 * at most `maxPts` points; parts under `minArea` pixels are left out.
 */
export function maskOutlines(mask: Uint8Array, w: number, h: number, maxPts = 120, minArea = 30): [number, number][][] {
  const seen = new Uint8Array(mask.length);
  const out: { area: number; poly: [number, number][] }[] = [];
  for (let i = 0; i < mask.length && out.length < 8; i++) {
    if (!mask[i] || seen[i]) continue;
    const comp = flood(mask, w, h, [i], 1);
    let area = 0;
    for (let j = 0; j < comp.length; j++)
      if (comp[j]) {
        seen[j] = 1;
        area++;
      }
    if (area < minArea) continue;
    const outline = trace(comp, w, h, i);
    let eps = 0.7;
    let poly = simplify(outline, eps);
    while (poly.length > maxPts && eps < 12) poly = simplify(outline, (eps *= 1.5));
    if (poly.length >= 3) out.push({ area, poly });
  }
  return out.sort((a, b) => b.area - a.area).map((o) => o.poly);
}

/** One call: prepare, grow from the click, take the automatic threshold (scaled by `tightness`). */
export function smartSelect(img: ImageLike, x: number, y: number, tightness = 1): Region | null {
  const p = prepareFrame(img);
  const sel = selectFrom(p, x, y);
  return regionAt(p, sel, sel.auto * tightness);
}

// ------------------------------------------------------------------ the same object on other frames

/** Even-odd scanline fill of a polygon given in pixels (pixels whose centre is inside get `value`). */
export function fillPolygon(buf: Uint8Array, w: number, h: number, pts: [number, number][], value: number) {
  if (pts.length < 3) return;
  let y0 = h, y1 = 0;
  for (const [, y] of pts) {
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const ys = Math.max(0, Math.floor(y0));
  const ye = Math.min(h - 1, Math.ceil(y1));
  const xs: number[] = [];
  for (let y = ys; y <= ye; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]!;
      const [xj, yj] = pts[j]!;
      if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const b = Math.min(w - 1, Math.floor(xs[k + 1]! - 0.5));
      if (b >= a) buf.fill(value, y * w + a, y * w + b + 1);
    }
  }
}

/**
 * Up to `max` points well inside a mask (a few pixels from its edge) around its middle, spread out,
 * normalised (0–1). The middle of an object stays on it when it turns; its outer parts may not.
 */
export function interiorPoints(mask: Uint8Array, w: number, h: number, max = 12): [number, number][] {
  let core = mask;
  for (let k = 0; k < 3; k++) {
    const e = erode(core, w, h);
    if (!e.some((v) => v)) break;
    core = e;
  }
  let cx = 0, cy = 0, cnt = 0;
  for (let i = 0; i < core.length; i++)
    if (core[i]) {
      cx += i % w;
      cy += (i / w) | 0;
      cnt++;
    }
  if (!cnt) return [];
  cx /= cnt;
  cy /= cnt;
  const step = Math.max(1, Math.floor(Math.sqrt(cnt / 3000)));
  const cand: { x: number; y: number; d: number }[] = [];
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) if (core[y * w + x]) cand.push({ x, y, d: Math.hypot(x - cx, y - cy) });
  cand.sort((a, b) => a.d - b.d);
  const inner = cand.slice(0, Math.max(1, Math.ceil(cand.length * 0.5)));
  // Farthest-point sampling from the most central point: few points, well spread.
  const out = [inner[0]!];
  const dmin = inner.map((c) => Math.hypot(c.x - inner[0]!.x, c.y - inner[0]!.y));
  while (out.length < max) {
    let bi = -1, bd = 1.5;
    for (let i = 0; i < inner.length; i++)
      if (dmin[i]! > bd) {
        bd = dmin[i]!;
        bi = i;
      }
    if (bi < 0) break;
    const c = inner[bi]!;
    out.push(c);
    for (let i = 0; i < inner.length; i++) dmin[i] = Math.min(dmin[i]!, Math.hypot(inner[i]!.x - c.x, inner[i]!.y - c.y));
  }
  return out.map((c) => [(c.x + 0.5) / w, (c.y + 0.5) / h]);
}

export type AdaptiveGroup = {
  /** Points (frame pixels) that should be on the object; growth starts from those matching `ref`. */
  seeds: [number, number][];
  ref: ColorRef;
  /** Edge threshold of the click this part came from (same frame scale). */
  threshold: number;
};

export type AdaptiveOptions = {
  /** Search window in the frame's pixels: the object is only looked for inside it. */
  window: { x0: number; y0: number; x1: number; y1: number };
  /** One group per clicked part (each has its own colour). */
  groups: AdaptiveGroup[];
  /**
   * Window sides the object is not expected to reach. A region running out there is background
   * (a white car next to a white coat): it grows in from those sides with the same colour measure,
   * and each pixel goes to whichever — the object's points or the sides — reaches it more easily,
   * so the cut falls on the weakest link between them.
   */
  open?: { left: boolean; top: boolean; right: boolean; bottom: boolean };
};

export type AdaptiveMask = {
  /** 1 = object, for the window's pixels (row-major, `width` × `height`). */
  mask: Uint8Array;
  x0: number;
  y0: number;
  width: number;
  height: number;
  area: number;
  /** Part of what matched was given to the background from the window's sides (try a bigger window). */
  cut: boolean;
};

/** Seeds that match the colour (the best pixel within 2 px of each point). */
function pickSeeds(points: [number, number][], cost: Float32Array, w: number, h: number, x0: number, y0: number, t: number): number[] {
  const out: number[] = [];
  for (const [sx, sy] of points) {
    const cx = Math.round(sx - x0);
    const cy = Math.round(sy - y0);
    let best = -1;
    let bc = t;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
        const i = yy * w + xx;
        if (cost[i]! <= bc) {
          bc = cost[i]!;
          best = i;
        }
      }
    if (best >= 0) out.push(best);
  }
  return out;
}

type Sides = NonNullable<AdaptiveOptions['open']>;
const BG_EASE = 0.9;

/** Pixels within `band` of the open sides of a w × h window. */
function sidePixels(w: number, h: number, open: Sides, band: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if ((open.top && y < band) || (open.bottom && y >= h - band) || (open.left && x < band) || (open.right && x >= w - band)) out.push(y * w + x);
  return out;
}

/**
 * Find a selected object again on another frame: the same colour-and-edge growth as the click(s),
 * started from points that should be on it (the selection moved by its track), inside a window
 * around where the track puts it. Points that no longer match its colour (it turned, a part left
 * the picture) are skipped; null when none match.
 */
export function adaptiveMask(img: ImageLike, o: AdaptiveOptions): AdaptiveMask | null {
  const W = img.width;
  const H = img.height;
  const x0 = Math.max(0, Math.floor(o.window.x0));
  const y0 = Math.max(0, Math.floor(o.window.y0));
  const x1 = Math.min(W, Math.ceil(o.window.x1));
  const y1 = Math.min(H, Math.ceil(o.window.y1));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 6 || h < 6 || !o.groups.length) return null;
  const ch = img.channels ?? 4;
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    let j = ((y0 + y) * W + x0) * ch;
    let k = y * w * 3;
    for (let x = 0; x < w; x++, j += ch, k += 3) {
      data[k] = img.data[j]!;
      data[k + 1] = img.data[j + 1]!;
      data[k + 2] = img.data[j + 2]!;
    }
  }
  const p = prepareFrame({ data, width: w, height: h, channels: 3 });
  const n = w * h;
  let mask: Uint8Array = new Uint8Array(n);
  const sides = o.open ? sidePixels(w, h, o.open, Math.max(3, Math.round(0.015 * Math.max(w, h)))) : [];
  let cut = false;
  // The parts are one object (a coat's shaded side and its lit side): one growth where every
  // pixel is measured against the nearest part's colour, scaled so each part's own threshold is 1.
  const cost = new Float32Array(n).fill(Infinity);
  let seeds: number[] = [];
  for (const g of o.groups) {
    const c = colorCost(p, g.ref);
    seeds.push(...pickSeeds(g.seeds, c, w, h, x0, y0, g.threshold));
    for (let i = 0; i < n; i++) {
      const v = c[i]! / g.threshold;
      if (v < cost[i]!) cost[i] = v;
    }
  }
  if (!seeds.length) return null;
  // What the window's sides reach is background. Points the sides reach almost unchanged sit on it
  // and are dropped (the object turned away from them — or it outgrew the window: then a roomier
  // one is tried).
  const B = sides.length ? grow(p, cost, sides, 1 / BG_EASE).D : null;
  if (B) {
    const kept = seeds.filter((i) => B[i]! > 0.15);
    if (kept.length < seeds.length) cut = true;
    seeds = kept;
  }
  // Only the pixels within the threshold are needed: stop growing there.
  const { D } = grow(p, cost, seeds, 1);
  let lost = 0;
  let found = 0;
  for (let i = 0; i < n; i++) {
    if (D[i]! > 1) continue;
    found++;
    // Each pixel goes to whichever reaches it more easily: the object's points or the sides
    // (the background slightly favoured, so the cut lands on the weak link next to the object
    // rather than somewhere along a long background strip).
    if (B && B[i]! * BG_EASE < D[i]!) lost++;
    else mask[i] = 1;
  }
  if (lost > 0.02 * found + 20) cut = true;
  if (!seeds.length) return { mask, x0, y0, width: w, height: h, area: 0, cut };
  // As for the click: close small gaps, grow back the edge pixels.
  mask = erode(erode(dilate(dilate(mask, w, h), w, h), w, h), w, h);
  mask = dilate(dilate(mask, w, h), w, h);
  for (const s of seeds) mask[s] = 1;
  // Fill holes.
  const borders: number[] = [];
  for (let x = 0; x < w; x++) borders.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) borders.push(y * w, y * w + w - 1);
  const outside = flood(mask, w, h, borders, 0);
  for (let i = 0; i < n; i++) if (!mask[i] && !outside[i]) mask[i] = 1;
  // Keep the parts that hold a point, except crumbs (a point that landed on a bit of background).
  const parts: { seen: Uint8Array; area: number }[] = [];
  const taken = new Uint8Array(n);
  for (const sd of seeds) {
    if (taken[sd]) continue;
    const seen = flood(mask, w, h, [sd], 1);
    let area = 0;
    for (let i = 0; i < n; i++)
      if (seen[i]) {
        taken[i] = 1;
        area++;
      }
    parts.push({ seen, area });
  }
  const biggest = parts.reduce((m, q) => Math.max(m, q.area), 0);
  mask.fill(0);
  let area = 0;
  for (const q of parts) {
    if (q.area < 0.08 * biggest) continue;
    for (let i = 0; i < n; i++) if (q.seen[i]) mask[i] = 1;
    area += q.area;
  }
  return area ? { mask, x0, y0, width: w, height: h, area, cut } : null;
}
