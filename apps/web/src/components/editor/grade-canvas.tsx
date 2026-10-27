'use client';

import { useEffect, useRef, useState } from 'react';
import { useFoundOutlines } from '@/lib/object-ui';
import { adaptedMaskAt, adapts, applyReplace, maskOutlines, buildLut, gradeFunction, gradeSchema, maskIsEmpty, maskTransformAt, needsLut, objectActiveAt, objectColorFunction, parseCube, spatialEffect, type AdaptedMask, type EditMask, type GradeSettings, type Lut3d, type ObjectEdit } from '@framecraft/shared';

/*
 * Live colour preview: draws the playing <video> through the same 3D LUT the export uses
 * (WebGL2 3D texture, trilinear), cropped exactly like the export (cover + re-frame position) — plus
 * masked colour replacements and object edits (colour / adjust / blur / pixelate inside a mask that
 * follows its tracked object). Blur, pixelate and feathering are close approximations of FFmpeg's.
 */

const REPS = 2;
const OBJS = 4;
const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2((p.x+1.0)*0.5, 1.0-(p.y+1.0)*0.5); gl_Position = vec4(p,0.0,1.0); }`;

function fragmentShader() {
  const decl: string[] = [];
  const body: string[] = [];
  for (let i = 0; i < REPS; i++) {
    decl.push(`uniform sampler3D uRep${i}; uniform sampler2D uMask${i}; uniform float uRep${i}On;`);
    body.push(`if (uRep${i}On > 0.5) c = mix(c, L(uRep${i}, c), texture(uMask${i}, s).r);`);
  }
  for (let i = 0; i < OBJS; i++) {
    decl.push(`uniform sampler3D uOL${i}; uniform sampler2D uOM${i}; uniform float uOOn${i}; uniform float uOLut${i}; uniform float uOSp${i}; uniform vec2 uOPar${i};`);
    body.push(`if (uOOn${i} > 0.5) { float m = texture(uOM${i}, s).r; if (m > 0.002) {
      vec3 e = c;
      if (uOSp${i} > 0.5 && uOSp${i} < 1.5) e = G(blurAt(s, uOPar${i}));
      else if (uOSp${i} > 1.5) { vec2 q = (floor(uv / uOPar${i}) + 0.5) * uOPar${i}; e = G(texture(uVideo, uCrop.xy + q * uCrop.zw).rgb); }
      if (uOLut${i} > 0.5) e = L(uOL${i}, e);
      c = mix(c, e, m); } }`);
  }
  return `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler2D uVideo; uniform sampler3D uLut; uniform float uLutOn; uniform float uSize; uniform vec4 uCrop;
${decl.join('\n')}
in vec2 uv; out vec4 o;
vec3 L(sampler3D t, vec3 c){ return texture(t, c*(uSize-1.0)/uSize + 0.5/uSize).rgb; }
vec3 G(vec3 c){ return uLutOn > 0.5 ? L(uLut, c) : c; }
const vec2 TAPS[12] = vec2[12](vec2(1.0,0.0),vec2(0.5,0.866),vec2(-0.5,0.866),vec2(-1.0,0.0),vec2(-0.5,-0.866),vec2(0.5,-0.866),vec2(0.433,0.25),vec2(0.0,0.5),vec2(-0.433,0.25),vec2(-0.433,-0.25),vec2(0.0,-0.5),vec2(0.433,-0.25));
vec3 blurAt(vec2 s, vec2 r){ vec3 acc = texture(uVideo, s).rgb * 0.16; float w = 0.16;
  for (int k = 0; k < 12; k++) { float wk = k < 6 ? 0.05 : 0.09; vec2 d = TAPS[k] * r * 2.0; acc += (texture(uVideo, s + d).rgb + texture(uVideo, s + d * 0.5).rgb) * wk; w += 2.0 * wk; }
  return acc / w; }
void main(){
  vec2 s = uCrop.xy + uv * uCrop.zw;
  vec3 c = G(texture(uVideo, s).rgb);
  ${body.join('\n  ')}
  o = vec4(c, 1.0);
}`;
}

const cubeCache = new Map<string, Promise<Lut3d>>();
export function loadCube(url: string): Promise<Lut3d> {
  if (!cubeCache.has(url)) cubeCache.set(url, fetch(url).then((r) => r.text()).then(parseCube));
  return cubeCache.get(url)!;
}

function lutTexture(gl: WebGL2RenderingContext, lut: Lut3d, tex: WebGLTexture | null) {
  const t = tex ?? gl.createTexture()!;
  const data = new Uint8Array((lut.data.length / 3) * 4);
  for (let i = 0, j = 0; i < lut.data.length; i += 3, j += 4) {
    data[j] = Math.round(Math.min(1, Math.max(0, lut.data[i]!)) * 255);
    data[j + 1] = Math.round(Math.min(1, Math.max(0, lut.data[i + 1]!)) * 255);
    data[j + 2] = Math.round(Math.min(1, Math.max(0, lut.data[i + 2]!)) * 255);
    data[j + 3] = 255;
  }
  gl.bindTexture(gl.TEXTURE_3D, t);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

/** An object's shape found on a frame, ready to draw (white = object). */
export type FoundShape = { a: AdaptedMask; canvas: HTMLCanvasElement };

export function foundShape(a: AdaptedMask): FoundShape {
  const c = document.createElement('canvas');
  c.width = a.width;
  c.height = a.height;
  const g = c.getContext('2d')!;
  const img = g.createImageData(a.width, a.height);
  for (let i = 0; i < a.mask.length; i++) if (a.mask[i]) img.data.fill(255, i * 4, i * 4 + 4);
  g.putImageData(img, 0, 0);
  return { a, canvas: c };
}

/**
 * Draw a mask (normalised, source coordinates) where its track puts it at source time t, feathered.
 * `shape` (the object found on a frame) stands for the added polygons; if it was found on a slightly
 * different frame it is moved by the track in between.
 */
export function drawMask(c: HTMLCanvasElement, mask: EditMask, t: number, shape?: FoundShape | null) {
  const g = c.getContext('2d')!;
  const W = c.width;
  const H = c.height;
  const tr = maskTransformAt(mask, t);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.filter = mask.feather ? `blur(${Math.max(0.5, mask.feather * W)}px)` : 'none';
  // p → c + (p − c)·s + d
  g.translate((tr.cx + tr.dx) * W, (tr.cy + tr.dy) * H);
  g.scale(tr.s, tr.s);
  g.translate(-tr.cx * W, -tr.cy * H);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const paint = (sub: boolean) => (g.fillStyle = g.strokeStyle = sub ? '#000' : '#fff');
  for (const r of mask.rects) {
    paint(r.subtract);
    g.beginPath();
    if (r.ellipse) g.ellipse((r.x + r.w / 2) * W, (r.y + r.h / 2) * H, (r.w / 2) * W, (r.h / 2) * H, 0, 0, Math.PI * 2);
    else g.rect(r.x * W, r.y * H, r.w * W, r.h * H);
    g.fill();
  }
  let drawn = false;
  for (const p of mask.polygons) {
    if (shape && !p.subtract) {
      if (drawn) continue;
      drawn = true;
      const ta = maskTransformAt(mask, shape.a.t);
      const k = tr.s / (ta.s || 1);
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.translate((tr.cx + tr.dx) * W, (tr.cy + tr.dy) * H);
      g.scale(k, k);
      g.translate(-(ta.cx + ta.dx) * W, -(ta.cy + ta.dy) * H);
      const { a } = shape;
      g.drawImage(shape.canvas, (a.x0 / a.frameWidth) * W, (a.y0 / a.frameHeight) * H, (a.width / a.frameWidth) * W, (a.height / a.frameHeight) * H);
      g.restore();
      continue;
    }
    paint(p.subtract);
    g.beginPath();
    p.points.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)));
    g.closePath();
    g.fill();
  }
  for (const s of mask.strokes) {
    paint(s.subtract);
    g.lineWidth = s.radius * 2 * W;
    g.beginPath();
    s.points.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)));
    g.stroke();
  }
  if (mask.invert) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'difference';
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
  }
}

/** Source-uv crop (offset xy, size zw) that shows the source like CSS object-fit: cover + object-position. */
export function coverCrop(vw: number, vh: number, cw: number, ch: number, objectPosition?: string): [number, number, number, number] {
  if (!vw || !vh || !cw || !ch) return [0, 0, 1, 1];
  const k = Math.max(cw / vw, ch / vh);
  const sw = vw * k;
  const sh = vh * k;
  const [px, py] = (objectPosition ?? '50% 50%').split(' ').map((v) => parseFloat(v) / 100) as [number, number];
  return [((sw - cw) * (Number.isFinite(px) ? px : 0.5)) / sw, ((sh - ch) * (Number.isFinite(py) ? py : 0.5)) / sh, cw / sw, ch / sh];
}

type Slot = { lut: WebGLTexture | null; mask: WebGLTexture; canvas: HTMLCanvasElement };
/** Last shape found for an object (re-found when the frame changes; at most ~14×/s while playing). */
type Found = { id: string; key: string; t: number; at: number; shape: FoundShape | null };
/** A frame handed to the worker and not answered yet. */
type Job = { key: string; since: number };

/** The video's current frame, `res` pixels wide (null when its pixels can't be read). */
function readFrame(v: HTMLVideoElement, res: number, cv: HTMLCanvasElement) {
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!vw || !vh) return null;
  const h = Math.max(2, Math.round((res * vh) / vw));
  if (cv.width !== res || cv.height !== h) {
    cv.width = res;
    cv.height = h;
  }
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  try {
    g.drawImage(v, 0, 0, res, h);
    return { data: g.getImageData(0, 0, res, h).data, width: res, height: h };
  } catch {
    return null;
  }
}

const UNITS: Record<string, number> = { uVideo: 0, uLut: 1 };
for (let i = 0; i < REPS; i++) {
  UNITS[`uRep${i}`] = 2 + i * 2;
  UNITS[`uMask${i}`] = 3 + i * 2;
}
for (let i = 0; i < OBJS; i++) {
  UNITS[`uOL${i}`] = 2 + REPS * 2 + i * 2;
  UNITS[`uOM${i}`] = 3 + REPS * 2 + i * 2;
}

export function GradeCanvas({ video, adjust, lutUrl, srcTime, objectPosition, objects }: { video: React.RefObject<HTMLVideoElement | null>; adjust?: Partial<GradeSettings>; lutUrl?: string | null; srcTime?: () => number; objectPosition?: string; objects?: ObjectEdit[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [supported, setSupported] = useState(true);
  const [custom, setCustom] = useState<Lut3d | null>(null);
  const state = useRef<{ gl: WebGL2RenderingContext; prog: WebGLProgram; vtex: WebGLTexture; lut: WebGLTexture | null; reps: Slot[]; objs: Slot[]; repMasks: EditMask[]; objList: ObjectEdit[]; dummy3d: WebGLTexture; dummy2d: WebGLTexture; found: (Found | undefined)[]; grab: HTMLCanvasElement; worker: Worker | null; jobs: (Job | undefined)[]; seq: number } | null>(null);
  const g = gradeSchema.parse(adjust ?? {});
  const masked = (g.replace ?? []).filter((r) => r.mask && !maskIsEmpty(r.mask)).slice(0, REPS);
  const objList = (objects ?? []).filter((o) => o.enabled && o.effects.length && !maskIsEmpty(o.mask)).slice(0, OBJS);
  const active = needsLut(g) || masked.length > 0 || objList.length > 0 || Boolean(g.lut && custom);
  // Latest values for the draw loop without restarting it.
  const live = useRef({ srcTime, objectPosition });
  live.current = { srcTime, objectPosition };

  useEffect(() => {
    if (!lutUrl) return setCustom(null);
    void loadCube(lutUrl).then(setCustom).catch(() => setCustom(null));
  }, [lutUrl]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const gl = c.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) return setSupported(false);
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fragmentShader()));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return setSupported(false);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex2d = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const slot = (): Slot => ({ lut: null, mask: tex2d(), canvas: document.createElement('canvas') });
    // Every sampler gets its own fixed unit (a 2D and a 3D sampler may never share one).
    for (const [name, unit] of Object.entries(UNITS)) gl.uniform1i(gl.getUniformLocation(prog, name), unit);
    const dummy3d = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, dummy3d);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    const dummy2d = tex2d();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    // Objects that follow shape changes are found again off the main thread (smooth playback).
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('../../lib/adapt.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      worker = null; // found on the main thread instead
    }
    const st: NonNullable<typeof state.current> = { gl, prog, vtex: tex2d(), lut: null, reps: Array.from({ length: REPS }, slot), objs: Array.from({ length: OBJS }, slot), repMasks: [], objList: [], dummy3d, dummy2d, found: [], grab: document.createElement('canvas'), worker, jobs: [], seq: 0 };
    state.current = st;
    worker?.addEventListener('message', (e: MessageEvent<{ slot: number; key: string; t: number; shape: AdaptedMask | null; outline: [number, number][][] }>) => {
      const { slot: i, key, t, shape, outline } = e.data;
      if (st.jobs[i]?.key === key) st.jobs[i] = undefined;
      const id = key.slice(0, key.indexOf('|'));
      st.found[i] = { id, key, t, at: performance.now(), shape: shape ? foundShape(shape) : null };
      useFoundOutlines.getState().put(id, shape && outline.length ? { t, polys: outline } : null);
    });
    return () => worker?.terminate();
  }, []);

  // (Re)bake LUTs when the grade or the objects change (debounced so slider drags stay smooth).
  const key = JSON.stringify(adjust ?? {}) + (custom ? 'L' : '') + JSON.stringify(objList.map((o) => o.effects));
  useEffect(() => {
    const s = state.current;
    if (!s) return;
    const id = setTimeout(() => {
      const { gl } = s;
      gl.useProgram(s.prog);
      if (needsLut(g) || (g.lut && custom)) s.lut = lutTexture(gl, buildLut(gradeFunction(g, custom), 25), s.lut);
      masked.forEach((rep, i) => (s.reps[i]!.lut = lutTexture(gl, buildLut((px) => applyReplace({ ...rep, mask: undefined }, px), 25), s.reps[i]!.lut)));
      s.repMasks = masked.map((r) => r.mask!);
      objList.forEach((o, i) => {
        const fn = objectColorFunction(o.effects);
        if (fn) s.objs[i]!.lut = lutTexture(gl, buildLut(fn, 25), s.objs[i]!.lut);
      });
      s.objList = objList;
    }, 60);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // Masks and ranges (geometry) update immediately.
  useEffect(() => {
    if (state.current) state.current.objList = objList;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(objList.map((o) => [o.mask, o.startSec, o.endSec, o.enabled, o.adapt]))]);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = state.current;
      const v = video.current;
      const c = canvas.current;
      if (!s || !v || !c || v.readyState < 2) return;
      const { gl } = s;
      const rect = c.getBoundingClientRect();
      const w = Math.min(1280, Math.round(rect.width * (window.devicePixelRatio || 1)));
      const h = Math.max(2, Math.round((w * rect.height) / Math.max(1, rect.width)));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      const crop = coverCrop(v.videoWidth, v.videoHeight, rect.width, rect.height, live.current.objectPosition);
      gl.viewport(0, 0, w, h);
      gl.useProgram(s.prog);
      const U = (n: string) => gl.getUniformLocation(s.prog, n);
      const bind = (unit: number, target: number, tex: WebGLTexture) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(target, tex);
      };
      bind(0, gl.TEXTURE_2D, s.vtex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      } catch {
        return; // cross-origin video without CORS: the plain <video> underneath stays visible
      }
      gl.uniform1f(U('uSize'), 25);
      gl.uniform4f(U('uCrop'), crop[0], crop[1], crop[2], crop[3]);
      const lutOn = Boolean(s.lut && (needsLut(g) || (g.lut && custom)));
      gl.uniform1f(U('uLutOn'), lutOn ? 1 : 0);
      bind(UNITS.uLut, gl.TEXTURE_3D, lutOn ? s.lut! : s.dummy3d);
      const t = live.current.srcTime ? live.current.srcTime() : v.currentTime;
      // Objects that follow shape changes: find them again on this frame (in the worker; while
      // playing at most ~14×/s — in between, the last shape is moved along by the track).
      let frame: ReturnType<typeof readFrame> | undefined;
      const findShape = (o: ObjectEdit, i: number): FoundShape | null => {
        if (!adapts(o) || !o.adapt) return null;
        const key = `${o.id}|${JSON.stringify([o.adapt, o.mask.polygons, o.mask.track?.points.length, o.mask.track?.points[0], o.atSec])}`;
        const f = s.found[i];
        const now = performance.now();
        const same = f && f.key === key ? f : undefined;
        const fresh = same && Math.abs(same.t - t) < 0.004;
        const busy = s.jobs[i] && now - s.jobs[i]!.since < 1500;
        if (!fresh && !busy && (!same || v.paused || now - same.at >= 70)) {
          if (frame === undefined || (frame && frame.width !== o.adapt.res)) frame = readFrame(v, o.adapt.res, s.grab);
          if (!frame) s.found[i] = { id: o.id, key, t, at: now, shape: null };
          else if (s.worker) {
            const data = frame.data.slice();
            s.jobs[i] = { key, since: now };
            s.worker.postMessage({ id: ++s.seq, slot: i, key, t, obj: { mask: o.mask, adapt: o.adapt }, frame: { data, width: frame.width, height: frame.height } }, [data.buffer]);
          } else {
            const a = adaptedMaskAt(o, frame, t);
            s.found[i] = { id: o.id, key, t, at: now, shape: a ? foundShape(a) : null };
            const outline = a ? maskOutlines(a.mask, a.width, a.height).map((poly) => poly.map(([x, y]) => [(a.x0 + x) / a.frameWidth, (a.y0 + y) / a.frameHeight] as [number, number])) : [];
            useFoundOutlines.getState().put(o.id, a && outline.length ? { t, polys: outline } : null);
          }
        }
        // Until the answer arrives, the object's previous shape (same object) is better than none.
        const show = s.found[i];
        return show && show.id === o.id ? show.shape : null;
      };
      const maskSize = (cv: HTMLCanvasElement) => {
        cv.width = 480;
        cv.height = Math.max(2, Math.round((480 * (v.videoHeight || 9)) / (v.videoWidth || 16)));
      };
      const bindSlot = (slot: Slot, lutUnit: number, maskUnit: number, on: boolean) => {
        bind(lutUnit, gl.TEXTURE_3D, on && slot.lut ? slot.lut : s.dummy3d);
        bind(maskUnit, gl.TEXTURE_2D, on ? slot.mask : s.dummy2d);
        if (on) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, slot.canvas);
      };
      for (let i = 0; i < REPS; i++) {
        const slot = s.reps[i]!;
        const on = Boolean(slot.lut && s.repMasks[i]);
        gl.uniform1f(U(`uRep${i}On`), on ? 1 : 0);
        if (on) {
          maskSize(slot.canvas);
          drawMask(slot.canvas, s.repMasks[i]!, t);
        }
        bindSlot(slot, UNITS[`uRep${i}`]!, UNITS[`uMask${i}`]!, on);
      }
      for (let i = 0; i < OBJS; i++) {
        const o = s.objList[i];
        const slot = s.objs[i]!;
        const on = Boolean(o && objectActiveAt(o, t));
        gl.uniform1f(U(`uOOn${i}`), on ? 1 : 0);
        if (on && o) {
          const colour = Boolean(objectColorFunction(o.effects) && slot.lut);
          gl.uniform1f(U(`uOLut${i}`), colour ? 1 : 0);
          const sp = spatialEffect(o.effects);
          // Blur sigma / pixel block in the export are relative to the output height (1080 lines).
          if (sp?.type === 'blur') {
            const sigmaPx = (sp.amount / 1080) * rect.height;
            gl.uniform1f(U(`uOSp${i}`), 1);
            gl.uniform2f(U(`uOPar${i}`), (sigmaPx / rect.width) * crop[2], (sigmaPx / rect.height) * crop[3]);
          } else if (sp?.type === 'pixelate') {
            const block = (sp.size / 1080) * rect.height;
            gl.uniform1f(U(`uOSp${i}`), 2);
            gl.uniform2f(U(`uOPar${i}`), block / rect.width, block / rect.height);
          } else gl.uniform1f(U(`uOSp${i}`), 0);
          maskSize(slot.canvas);
          drawMask(slot.canvas, o.mask, t, findShape(o, i));
        }
        bindSlot(slot, UNITS[`uOL${i}`]!, UNITS[`uOM${i}`]!, on);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);

  // Never pretend: without WebGL2 the picture here shows no colour/object effects, the export does.
  if (!supported) return active ? <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-black/75 px-2 py-0.5 text-[10px] text-white">Colour preview needs WebGL — the export applies it exactly</span> : null;
  // The canvas always exists (hidden while there is nothing to draw), so its WebGL context is ready
  // the moment a first colour or object effect is added — not only after a reload.
  return (
    <canvas
      ref={canvas}
      aria-hidden
      data-testid="grade-canvas"
      className={active ? 'pointer-events-none absolute inset-0 size-full' : 'hidden'}
      style={active ? { filter: [g.blur ? `blur(${(g.blur * 0.5).toFixed(1)}px)` : '', g.glow ? `brightness(${1 + g.glow * 0.12}) saturate(${1 + g.glow * 0.1})` : ''].filter(Boolean).join(' ') || undefined } : undefined}
    />
  );
}

/** Film grain overlay (approximation of the export's noise filter). */
export function Grain({ amount }: { amount?: number }) {
  if (!amount) return null;
  return (
    <svg className="pointer-events-none absolute inset-0 size-full mix-blend-overlay" style={{ opacity: Math.min(0.6, amount * 0.7) }} aria-hidden>
      <filter id="fc-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
      </filter>
      <rect width="100%" height="100%" filter="url(#fc-grain)" />
    </svg>
  );
}
