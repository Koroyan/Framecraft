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
  const wL = chroma > 18 ? 0.45 : chroma > 8 ? 0.7 : 1;
  const cost = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dL = (p.L[i]! - mL) * wL;
    const dA = p.A[i]! - mA;
    const dB = p.B[i]! - mB;
    cost[i] = Math.sqrt(dL * dL + dA * dA + dB * dB) + 0.3 * (p.gL[i]! * wL + p.gC[i]!);
  }
  const D = new Float32Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const sorted = new Float32Array(n);
  let m = 0;
  const heap = new Heap(Math.min(n, 1 << 16));
  D[seed] = 0;
  heap.push(0, seed);
  while (heap.size) {
    const [d, i] = heap.pop();
    if (done[i] || d > D[i]!) continue;
    if (d > MAX_T) break;
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
  const sortedSlice = sorted.subarray(0, m);
  const minArea = Math.max(24, Math.round(n * 0.0006));
  return { seed, D, sorted: sortedSlice, auto: autoThreshold(sortedSlice, n, minArea), minArea };
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

/** One call: prepare, grow from the click, take the automatic threshold (scaled by `tightness`). */
export function smartSelect(img: ImageLike, x: number, y: number, tightness = 1): Region | null {
  const p = prepareFrame(img);
  const sel = selectFrom(p, x, y);
  return regionAt(p, sel, sel.auto * tightness);
}
