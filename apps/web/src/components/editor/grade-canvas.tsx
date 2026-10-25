'use client';

import { useEffect, useRef, useState } from 'react';
import { applyReplace, buildLut, gradeFunction, gradeSchema, maskIsEmpty, motionAt, needsLut, parseCube, type EditMask, type GradeSettings, type Lut3d } from '@framecraft/shared';

/*
 * Live colour preview: draws the playing <video> through the same 3D LUT the export uses
 * (WebGL2 3D texture, trilinear) — plus masked colour replacements, each with its own LUT and a
 * mask that follows its tracked object. Blur / vignette / grain / glow are close CSS approximations.
 */

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2((p.x+1.0)*0.5, 1.0-(p.y+1.0)*0.5); gl_Position = vec4(p,0.0,1.0); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler2D uVideo; uniform sampler3D uLut; uniform float uLutOn;
uniform sampler3D uRep0; uniform sampler2D uMask0; uniform float uRep0On;
uniform sampler3D uRep1; uniform sampler2D uMask1; uniform float uRep1On;
uniform float uSize;
in vec2 uv; out vec4 o;
vec3 L(sampler3D s, vec3 c){ return texture(s, c*(uSize-1.0)/uSize + 0.5/uSize).rgb; }
void main(){
  vec3 c = texture(uVideo, uv).rgb;
  if (uLutOn > 0.5) c = L(uLut, c);
  if (uRep0On > 0.5) c = mix(c, L(uRep0, c), texture(uMask0, uv).r);
  if (uRep1On > 0.5) c = mix(c, L(uRep1, c), texture(uMask1, uv).r);
  o = vec4(c, 1.0);
}`;

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

/** Draw a mask (normalised, source coordinates) at the video's current time, feathered. */
export function drawMask(c: HTMLCanvasElement, mask: EditMask, t: number) {
  const g = c.getContext('2d')!;
  const W = c.width;
  const H = c.height;
  const off = motionAt(mask.track, t);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.filter = mask.feather ? `blur(${Math.max(0.5, mask.feather * W)}px)` : 'none';
  g.translate(off.dx * W, off.dy * H);
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
  for (const p of mask.polygons) {
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

export function GradeCanvas({ video, adjust, lutUrl, srcTime }: { video: React.RefObject<HTMLVideoElement | null>; adjust?: Partial<GradeSettings>; lutUrl?: string | null; srcTime?: () => number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [supported, setSupported] = useState(true);
  const [custom, setCustom] = useState<Lut3d | null>(null);
  const state = useRef<{ gl: WebGL2RenderingContext; prog: WebGLProgram; vtex: WebGLTexture; lut: WebGLTexture | null; reps: (WebGLTexture | null)[]; masks: WebGLTexture[]; maskCanvases: HTMLCanvasElement[]; repMasks: EditMask[] } | null>(null);
  const g = gradeSchema.parse(adjust ?? {});
  const masked = (g.replace ?? []).filter((r) => r.mask && !maskIsEmpty(r.mask)).slice(0, 2);
  const active = needsLut(g) || masked.length > 0 || Boolean(g.lut && custom);

  useEffect(() => {
    if (!lutUrl) return setCustom(null);
    void loadCube(lutUrl).then(setCustom).catch(() => setCustom(null));
  }, [lutUrl]);

  // GL setup once.
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
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
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
    state.current = { gl, prog, vtex: tex2d(), lut: null, reps: [null, null], masks: [tex2d(), tex2d()], maskCanvases: [document.createElement('canvas'), document.createElement('canvas')], repMasks: [] };
  }, []);

  // (Re)bake LUTs when the grade changes (debounced so slider drags stay smooth).
  const key = JSON.stringify(adjust ?? {}) + (custom ? 'L' : '');
  useEffect(() => {
    const s = state.current;
    if (!s) return;
    const id = setTimeout(() => {
      const { gl } = s;
      gl.useProgram(s.prog);
      if (needsLut(g) || (g.lut && custom)) s.lut = lutTexture(gl, buildLut(gradeFunction(g, custom), 25), s.lut);
      masked.forEach((rep, i) => (s.reps[i] = lutTexture(gl, buildLut((px) => applyReplace({ ...rep, mask: undefined }, px), 25), s.reps[i] ?? null)));
      s.repMasks = masked.map((r) => r.mask!);
    }, 60);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Draw loop.
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
      gl.viewport(0, 0, w, h);
      gl.useProgram(s.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, s.vtex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      gl.uniform1i(gl.getUniformLocation(s.prog, 'uVideo'), 0);
      gl.uniform1f(gl.getUniformLocation(s.prog, 'uSize'), 25);
      gl.uniform1f(gl.getUniformLocation(s.prog, 'uLutOn'), s.lut && (needsLut(g) || (g.lut && custom)) ? 1 : 0);
      if (s.lut) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, s.lut);
        gl.uniform1i(gl.getUniformLocation(s.prog, 'uLut'), 1);
      }
      const t = srcTime ? srcTime() : v.currentTime;
      for (let i = 0; i < 2; i++) {
        const on = Boolean(s.reps[i] && s.repMasks[i]);
        gl.uniform1f(gl.getUniformLocation(s.prog, `uRep${i}On`), on ? 1 : 0);
        if (!on) continue;
        const mc = s.maskCanvases[i]!;
        mc.width = Math.min(480, w);
        mc.height = Math.max(2, Math.round((mc.width * h) / w));
        drawMask(mc, s.repMasks[i]!, t);
        gl.activeTexture(gl.TEXTURE2 + i * 2);
        gl.bindTexture(gl.TEXTURE_3D, s.reps[i]!);
        gl.uniform1i(gl.getUniformLocation(s.prog, `uRep${i}`), 2 + i * 2);
        gl.activeTexture(gl.TEXTURE3 + i * 2);
        gl.bindTexture(gl.TEXTURE_2D, s.masks[i]!);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mc);
        gl.uniform1i(gl.getUniformLocation(s.prog, `uMask${i}`), 3 + i * 2);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);

  if (!supported || !active) return null;
  return (
    <canvas
      ref={canvas}
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full"
      style={{ filter: [g.blur ? `blur(${(g.blur * 0.5).toFixed(1)}px)` : '', g.glow ? `brightness(${1 + g.glow * 0.12}) saturate(${1 + g.glow * 0.1})` : ''].filter(Boolean).join(' ') || undefined }}
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
