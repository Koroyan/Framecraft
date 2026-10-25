import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { revealUnits, type Layer, type TextStyle } from '@framecraft/shared';
import { ffmpeg, withWorkdir } from './ffmpeg';

/*
 * Rasterise text and shape layers to PNG with FFmpeg (drawtext / geq). The browser preview shows
 * the same PNG the export composites, so titles look identical in both. Typewriter / word reveals
 * become a vertical sprite (one row per step) that the renderer crops over time.
 */

const FONTS: Record<TextStyle['font'], string[]> = {
  sans: ['C:/Windows/Fonts/segoeui.ttf', '/usr/share/fonts/truetype/noto/NotoSansGeorgian-Regular.ttf', '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
  semibold: ['C:/Windows/Fonts/seguisb.ttf', '/usr/share/fonts/truetype/noto/NotoSansGeorgian-SemiBold.ttf', '/usr/share/fonts/truetype/noto/NotoSans-SemiBold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  bold: ['C:/Windows/Fonts/segoeuib.ttf', '/usr/share/fonts/truetype/noto/NotoSansGeorgian-Bold.ttf', '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  black: ['C:/Windows/Fonts/seguibl.ttf', '/usr/share/fonts/truetype/noto/NotoSansGeorgian-Black.ttf', '/usr/share/fonts/truetype/noto/NotoSans-Black.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  serif: ['C:/Windows/Fonts/sylfaen.ttf', '/usr/share/fonts/truetype/noto/NotoSerifGeorgian-Regular.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'],
  mono: ['C:/Windows/Fonts/consola.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'],
};

/** Windows fonts without Georgian glyphs, and the closest font that has them. */
const NO_GEORGIAN: Record<string, TextStyle['font']> = { 'seguibl.ttf': 'bold', 'consola.ttf': 'sans' };
const GEORGIAN = /[Ⴀ-ჿᲐ-Ჿⴀ-⴯]/;

export function fontFile(font: TextStyle['font'], content = ''): string {
  const pick = (f: TextStyle['font']) => [process.env.FFMPEG_FONT_FILE, ...FONTS[f], ...FONTS.sans].find((p): p is string => Boolean(p && fs.existsSync(p)));
  let f = pick(font);
  // Georgian text in a font that lacks it would render as empty boxes: use the nearest weight that has it.
  const alt = f && GEORGIAN.test(content) ? NO_GEORGIAN[path.basename(f).toLowerCase()] : undefined;
  if (alt) f = pick(alt);
  if (!f) throw new Error('No font with Georgian/Cyrillic glyphs found on the server (install fonts-noto-core)');
  return f;
}

const ffColor = (hex: string, alpha = 1) => `0x${hex.slice(1)}@${alpha.toFixed(3)}`;

/** Bounding box of non-transparent pixels in a raw RGBA buffer. */
function alphaBox(buf: Buffer, w: number, h: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (buf[(y * w + x) * 4 + 3]! > 4) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export type RasterResult = { file: string; width: number; height: number; rows: number };

/** Render a text or shape layer at `frameHeight` (pixel sizes are defined at 1080). */
export async function rasterizeLayer(layer: Layer, frameHeight: number, outFile: string): Promise<RasterResult> {
  return withWorkdir(async (dir) => {
    const k = frameHeight / 1080;
    if (layer.kind === 'shape' && layer.shape) return rasterShape(layer, k, dir, outFile);
    if (layer.kind !== 'text' || !layer.text) throw new Error('Only text and shape layers are rasterised');
    const st = layer.text;
    const size = Math.max(8, Math.round(st.size * k));
    await fsp.copyFile(fontFile(st.font, st.content), path.join(dir, 'font.ttf'));
    const units = revealUnits(layer) ?? [st.content];
    const full = st.content;
    const lines = full.split('\n').length;
    const pad = Math.round((st.background ? st.background.padding : 0) * k) + Math.round(((st.stroke?.width ?? 0) + (st.shadow?.offset ?? 0)) * k) + 4;
    const W = Math.min(4096, Math.round(size * 0.75 * Math.max(...full.split('\n').map((l) => Array.from(l).length)) + pad * 2 + size));
    const rowH = Math.round(size * 1.35 * lines + pad * 2 + size * 0.3);
    const H = rowH * units.length;
    const filters: string[] = [];
    units.forEach((u, i) => {
      fs.writeFileSync(path.join(dir, `t${i}.txt`), u);
      const parts = [
        'fontfile=font.ttf',
        `textfile=t${i}.txt`,
        `fontsize=${size}`,
        `fontcolor=${st.gradientTo ? 'white' : ffColor(st.color)}`,
        `x=${pad}`,
        `y=${i * rowH + pad}`,
        'line_spacing=' + Math.round(size * 0.2),
      ];
      if (st.stroke?.width) parts.push(`borderw=${Math.max(1, Math.round(st.stroke.width * k))}`, `bordercolor=${ffColor(st.stroke.color)}`);
      if (st.shadow?.opacity) parts.push(`shadowx=${Math.round(st.shadow.offset * k)}`, `shadowy=${Math.round(st.shadow.offset * k)}`, `shadowcolor=${ffColor(st.shadow.color, st.shadow.opacity)}`);
      if (st.background) parts.push('box=1', `boxcolor=${ffColor(st.background.color, st.background.opacity)}`, `boxborderw=${Math.round(st.background.padding * k)}`);
      filters.push(`drawtext=${parts.join(':')}`);
    });
    // Gradient fill: colour the text by a vertical gradient through its own alpha.
    if (st.gradientTo) {
      const [r1, g1, b1] = [1, 3, 5].map((o) => parseInt(st.color.slice(o, o + 2), 16));
      const [r2, g2, b2] = [1, 3, 5].map((o) => parseInt(st.gradientTo!.slice(o, o + 2), 16));
      // Weight by whiteness so anti-aliased edges blend and the (dark) stroke/shadow stay as they are.
      const w = `clip((min(r(X,Y),g(X,Y))-100)/155,0,1)`;
      const grad = (a: number, b: number) => `(${a}+(${b - a})*mod(Y,${rowH})/${rowH})`;
      const mix = (ch: 'r' | 'g' | 'b', a: number, b: number) => `'${ch}(X,Y)*(1-${w})+${grad(a, b)}*${w}'`;
      filters.push(`geq=r=${mix('r', r1!, r2!)}:g=${mix('g', g1!, g2!)}:b=${mix('b', b1!, b2!)}:a='alpha(X,Y)'`);
    }
    const raw = path.join(dir, 'text.rgba');
    await ffmpeg(['-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H},format=rgba`, '-vf', filters.join(','), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', raw], { cwd: dir });
    const buf = await fsp.readFile(raw);
    // One crop for every row (same box), so the reveal never jumps.
    let box = { x0: W, y0: rowH, x1: 0, y1: 0 };
    for (let i = 0; i < units.length; i++) {
      const b = alphaBox(buf.subarray(i * rowH * W * 4, (i + 1) * rowH * W * 4), W, rowH);
      if (b) box = { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) };
    }
    if (box.x1 <= box.x0) box = { x0: 0, y0: 0, x1: 1, y1: 1 };
    const cw = Math.max(2, Math.ceil((box.x1 - box.x0 + 3) / 2) * 2);
    const ch = Math.max(2, Math.ceil((box.y1 - box.y0 + 3) / 2) * 2);
    // Stack the cropped rows into the sprite.
    const crops = units.map((_, i) => `[0:v]crop=${cw}:${ch}:${Math.max(0, box.x0 - 1)}:${i * rowH + Math.max(0, box.y0 - 1)}[r${i}]`);
    const stack = units.length > 1 ? `${units.map((_, i) => `[r${i}]`).join('')}vstack=inputs=${units.length}[o]` : '[r0]null[o]';
    await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', raw, '-filter_complex', `${crops.join(';')};${stack}`, '-map', '[o]', '-frames:v', '1', outFile], { cwd: dir });
    return { file: outFile, width: cw, height: ch, rows: units.length };
  });
}

async function rasterShape(layer: Layer, k: number, dir: string, outFile: string): Promise<RasterResult> {
  const sh = layer.shape!;
  const H = Math.max(16, Math.round(220 * k));
  const W = Math.max(16, Math.round(H * sh.aspect));
  const [r, g, b] = [1, 3, 5].map((o) => parseInt(sh.fill.slice(o, o + 2), 16));
  // Alpha masks in normalised coordinates u,v ∈ [0,1].
  const u = `(X/${W})`;
  const v = `(Y/${H})`;
  const rr = Math.min(W, H) / 2;
  const masks: Record<string, string> = {
    rect: '1',
    pill: `lte(hypot(max(0,abs(X-${W / 2})-${W / 2 - rr}),max(0,abs(Y-${H / 2})-${H / 2 - rr})),${rr})`,
    ellipse: `lte(pow((${u}-0.5)*2,2)+pow((${v}-0.5)*2,2),1)`,
    bubble: `max(lte(hypot(max(0,abs(X-${W / 2})-${W / 2 - rr * 0.8}),max(0,abs(Y-${H * 0.4})-${H * 0.4 - rr * 0.8})),${rr * 0.8})*lt(Y,${H * 0.8}),gte(${v},0.75)*lte(${v},1)*gte(${u},0.18)*lte(${u},0.18+(1-${v})*0.6))`,
    arrow: `max(gte(${u},0)*lte(${u},0.62)*gte(${v},0.32)*lte(${v},0.68),gte(${u},0.55)*lte(abs(${v}-0.5),(1-${u})/0.9))`,
    burst: `lte(hypot(${u}-0.5,${v}-0.5),0.4+0.08*cos(16*atan2(${v}-0.5,${u}-0.5)))`,
  };
  const a = `255*${sh.opacity}*(${masks[sh.type]})`;
  const vf = [`geq=r='${r}':g='${g}':b='${b}':a='${a}'`];
  if (sh.label) {
    await fsp.copyFile(fontFile('bold'), path.join(dir, 'font.ttf'));
    fs.writeFileSync(path.join(dir, 'label.txt'), sh.label);
    vf.push(`drawtext=fontfile=font.ttf:textfile=label.txt:fontsize=${Math.round(H * 0.42)}:fontcolor=${ffColor(sh.labelColor)}:x=(w-text_w)/2${sh.type === 'arrow' ? '*0.62' : ''}:y=(h-text_h)/2${sh.type === 'bubble' ? '*0.8' : ''}`);
  }
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H},format=rgba`, '-vf', vf.join(','), '-frames:v', '1', outFile], { cwd: dir });
  return { file: outFile, width: W, height: H, rows: 1 };
}
