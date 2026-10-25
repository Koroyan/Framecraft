'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, Image as ImageIcon, Lock, Plus, Trash2, Type, Unlock, Video } from 'lucide-react';
import { LAYER_ANIMS, layerSchema, layerStateAt, rasterHash, SHAPES, TEXT_FONTS, type Layer, type LayerInput, type Timeline } from '@framecraft/shared';
import { api, type Asset } from '@/lib/api';
import { newId } from '@/lib/editor-store';
import { Button, Field, Input, NativeSelect, Textarea } from '@/components/ui';
import { cn, seconds } from '@/lib/utils';

/*
 * Layers on the preview: text / shapes are server-rendered PNGs (the same picture the export
 * composites); images and picture-in-picture videos are drawn directly. Positions and animations
 * come from @framecraft/shared layerStateAt — the function the FFmpeg expressions are built from.
 */

type Raster = { url: string; width: number; height: number; rows: number };
const rasterCache = new Map<string, Promise<Raster>>();

export function useRaster(layer: Layer, frameHeight: number): Raster | null {
  const [r, setR] = useState<Raster | null>(null);
  const needs = layer.kind === 'text' || layer.kind === 'shape';
  const key = needs ? `${rasterHash(layer)}:${Math.round(frameHeight / 120) * 120}` : '';
  useEffect(() => {
    if (!needs) return;
    let alive = true;
    const id = setTimeout(() => {
      if (!rasterCache.has(key)) rasterCache.set(key, api<Raster>('/api/layers/raster', { body: { layer, frameHeight: Math.max(240, Math.round(frameHeight / 120) * 120) } }).catch((e) => { rasterCache.delete(key); throw e; }));
      void rasterCache.get(key)!.then((x) => alive && setR(x)).catch(() => undefined);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return needs ? r : null;
}

function LayerView({ layer, t, playing, assets, frameH, selected, onSelect, hidden }: { layer: Layer; t: number; playing: boolean; assets: Map<string, Asset>; frameH: number; selected: boolean; onSelect: () => void; hidden: boolean }) {
  const st = layerStateAt(layer, t);
  const raster = useRaster(layer, frameH);
  const vid = useRef<HTMLVideoElement>(null);
  const asset = layer.assetId ? assets.get(layer.assetId) : undefined;
  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    const want = layer.inSec + (t - layer.startSec);
    if (Math.abs(v.currentTime - want) > 0.3) v.currentTime = Math.max(0, want);
    if (playing && st.visible) void v.play().catch(() => undefined);
    else v.pause();
  }, [t, playing, st.visible, layer.inSec, layer.startSec]);
  if (!st.visible || hidden) return null;
  const aspect = raster ? raster.width / (raster.height / raster.rows) : layer.kind === 'video' || layer.kind === 'image' ? undefined : 3;
  const c = layer.crop;
  const style: React.CSSProperties = {
    left: `${st.x * 100}%`,
    top: `${st.y * 100}%`,
    width: `${layer.w * st.scale * 100}%`,
    aspectRatio: aspect ? String(aspect) : undefined,
    transform: `translate(-50%, -50%) rotate(${st.rotation}deg) scale(${layer.flipH ? -1 : 1}, ${layer.flipV ? -1 : 1})`,
    opacity: st.opacity,
  };
  let body: React.ReactNode;
  if (raster) {
    // Sprite rows (typewriter / words): show the current row.
    body = <div className="size-full" style={{ backgroundImage: `url(${raster.url})`, backgroundSize: `100% ${raster.rows * 100}%`, backgroundPosition: `0 ${raster.rows > 1 ? (st.row / (raster.rows - 1)) * 100 : 0}%`, backgroundRepeat: 'no-repeat' }} />;
  } else if (layer.kind === 'text') {
    body = <div className="whitespace-pre text-center font-bold text-white [text-shadow:0_0_3px_#000]" style={{ fontSize: `${(layer.text?.size ?? 60) / 18}vmin` }}>{layer.text?.content}</div>;
  } else if (asset) {
    const crop = c ? { clipPath: `inset(${c.t * 100}% ${c.r * 100}% ${c.b * 100}% ${c.l * 100}%)` } : undefined;
    body = layer.kind === 'video' ? <video ref={vid} src={asset.url} muted={layer.volume === 0} playsInline className="block w-full" style={crop} /> : <img src={asset.url} alt="" className="block w-full" draggable={false} style={crop} />;
  } else body = null;
  return (
    <div className={cn('absolute cursor-pointer', selected && 'outline outline-1 outline-iris-300/70')} style={style} onPointerDown={(e) => { e.stopPropagation(); onSelect(); }}>
      {body}
    </div>
  );
}

/** Drag / scale / rotate the selected layer directly on the preview, with centre and thirds snapping. */
function TransformBox({ layer, t, frame, onChange }: { layer: Layer; t: number; frame: React.RefObject<HTMLDivElement | null>; onChange: (patch: Partial<Layer>) => void }) {
  const st = layerStateAt(layer, t);
  const drag = useRef<{ mode: 'move' | 'scale' | 'rotate'; x0: number; y0: number; l: Layer; cx: number; cy: number } | null>(null);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  if (!st.visible) return null;
  const snap = (v: number) => {
    for (const s of [0.5, 1 / 3, 2 / 3]) if (Math.abs(v - s) < 0.012) return { v: s, hit: s === 0.5 };
    return { v, hit: false };
  };
  const write = (x: number, y: number, extra: Partial<Layer> = {}) => {
    // With keyframes, dragging edits (or adds) the keyframe at the playhead.
    if (layer.keyframes.length) {
      const local = Math.round((t - layer.startSec) * 100) / 100;
      const rest = layer.keyframes.filter((k) => Math.abs(k.t - local) > 0.04);
      const cur = layerStateAt({ ...layer, animIn: { type: 'none', durationSec: 0.4 }, animOut: { type: 'none', durationSec: 0.4 }, follow: undefined }, t);
      onChange({ keyframes: [...rest, { t: local, x, y, scale: cur.scale, rotation: extra.rotation ?? cur.rotation }].sort((a, b) => a.t - b.t), ...(extra.w ? { w: extra.w } : {}) });
    } else onChange({ x, y, ...extra });
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const r = frame.current?.getBoundingClientRect();
    if (!d || !r) return;
    if (d.mode === 'move') {
      const nx = snap(d.l.x + (e.clientX - d.x0) / r.width);
      const ny = snap(d.l.y + (e.clientY - d.y0) / r.height);
      setGuides({ v: nx.hit, h: ny.hit });
      write(Math.round(nx.v * 1000) / 1000, Math.round(ny.v * 1000) / 1000);
    } else if (d.mode === 'scale') {
      const dist0 = Math.hypot(d.x0 - d.cx, d.y0 - d.cy);
      const dist = Math.hypot(e.clientX - d.cx, e.clientY - d.cy);
      onChange({ w: Math.round(Math.min(3, Math.max(0.02, d.l.w * (dist / Math.max(1, dist0)))) * 1000) / 1000 });
    } else {
      const a = (Math.atan2(e.clientY - d.cy, e.clientX - d.cx) * 180) / Math.PI + 90;
      const snapped = Math.abs(a % 45) < 3 ? Math.round(a / 45) * 45 : a;
      if (layer.keyframes.length) write(st.x, st.y, { rotation: Math.round(snapped) });
      else onChange({ rotation: Math.round(snapped) });
    }
  };
  const start = (mode: 'move' | 'scale' | 'rotate') => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = frame.current!.getBoundingClientRect();
    drag.current = { mode, x0: e.clientX, y0: e.clientY, l: { ...layer, x: st.x, y: st.y }, cx: r.left + st.x * r.width, cy: r.top + st.y * r.height };
  };
  const end = () => {
    drag.current = null;
    setGuides({ v: false, h: false });
  };
  const handles = (
    <>
      <span role="slider" aria-label="Scale" aria-valuenow={Math.round(layer.w * 100)} tabIndex={-1} className="absolute -bottom-2 -right-2 size-4 cursor-nwse-resize rounded-sm border-2 border-ink-900 bg-white" onPointerDown={start('scale')} onPointerMove={move} onPointerUp={end} />
      <span role="slider" aria-label="Rotate" aria-valuenow={Math.round(st.rotation)} tabIndex={-1} className="absolute -top-7 left-1/2 size-4 -translate-x-1/2 cursor-grab rounded-full border-2 border-ink-900 bg-iris-300" onPointerDown={start('rotate')} onPointerMove={move} onPointerUp={end} />
    </>
  );
  return (
    <>
      {guides.v && <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-signal-amber" />}
      {guides.h && <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-signal-amber" />}
      <div
        role="group"
        aria-label={`Selected layer ${layer.name ?? layer.kind} — drag to move`}
        tabIndex={0}
        className="absolute cursor-move touch-none border-2 border-iris-400"
        style={{ left: `${st.x * 100}%`, top: `${st.y * 100}%`, width: `${layer.w * st.scale * 100}%`, aspectRatio: '3', transform: `translate(-50%, -50%) rotate(${st.rotation}deg)` }}
        onPointerDown={start('move')}
        onPointerMove={move}
        onPointerUp={end}
        onKeyDown={(e) => {
          const s = e.shiftKey ? 0.02 : 0.005;
          const d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key];
          if (!d) return;
          e.preventDefault();
          write(st.x + d[0]!, st.y + d[1]!);
        }}
      >
        {handles}
      </div>
    </>
  );
}

/** All visible layers for the preview, plus the transform box of the selected one. */
export function LayerStage({ timeline, t, playing, assets, selectedId, onSelect, onChange, frame, frameH }: { timeline: Timeline; t: number; playing: boolean; assets: Map<string, Asset>; selectedId: string | null; onSelect: (id: string | null) => void; onChange: (id: string, patch: Partial<Layer>) => void; frame: React.RefObject<HTMLDivElement | null>; frameH: number }) {
  const hidden = new Set(timeline.tracks.filter((x) => x.hidden).map((x) => x.index));
  const locked = new Set(timeline.tracks.filter((x) => x.locked).map((x) => x.index));
  const layers = [...timeline.layers].sort((a, b) => a.track - b.track || a.startSec - b.startSec);
  const sel = layers.find((l) => l.id === selectedId);
  return (
    <>
      {layers.map((l) => <LayerView key={l.id} layer={l} t={t} playing={playing} assets={assets} frameH={frameH} selected={l.id === selectedId} onSelect={() => onSelect(l.id)} hidden={hidden.has(l.track)} />)}
      {sel && !locked.has(sel.track) && !hidden.has(sel.track) && <TransformBox layer={sel} t={t} frame={frame} onChange={(p) => onChange(sel.id, p)} />}
    </>
  );
}

// ------------------------------------------------------------------ templates

type Template = { key: string; label: string; make: (start: number, brand?: string) => LayerInput };
export const LAYER_TEMPLATES: Template[] = [
  { key: 'title', label: 'Big title', make: (s) => ({ id: newId('ly'), name: 'Title', kind: 'text', track: 2, startSec: s, endSec: s + 3, x: 0.5, y: 0.25, w: 0.85, text: { content: 'სათაური · Title', font: 'black', size: 110, color: '#FFFFFF', shadow: { color: '#000000', opacity: 0.5, offset: 4 } }, animIn: { type: 'pop', durationSec: 0.45 }, animOut: { type: 'fade', durationSec: 0.3 } }) },
  { key: 'caption', label: 'TikTok caption', make: (s) => ({ id: newId('ly'), name: 'Caption', kind: 'text', track: 2, startSec: s, endSec: s + 2.5, x: 0.5, y: 0.72, w: 0.8, text: { content: 'Your caption here', font: 'black', size: 70, color: '#FFFFFF', stroke: { color: '#000000', width: 6 } }, animIn: { type: 'words', durationSec: 1 } }) },
  { key: 'lower', label: 'Lower third', make: (s) => ({ id: newId('ly'), name: 'Lower third', kind: 'text', track: 2, startSec: s, endSec: s + 4, x: 0.35, y: 0.82, w: 0.6, text: { content: 'Name · Role', font: 'semibold', size: 54, color: '#FFFFFF', align: 'left', background: { color: '#111111', opacity: 0.7, padding: 20 } }, animIn: { type: 'slide_right', durationSec: 0.4 }, animOut: { type: 'fade', durationSec: 0.3 } }) },
  { key: 'type', label: 'Typewriter', make: (s) => ({ id: newId('ly'), name: 'Typewriter', kind: 'text', track: 2, startSec: s, endSec: s + 4, x: 0.5, y: 0.5, w: 0.8, text: { content: 'ხელით შექმნილი', font: 'mono', size: 72, color: '#FFFFFF' }, animIn: { type: 'typewriter', durationSec: 1.6 } }) },
  { key: 'price', label: 'Price tag', make: (s) => ({ id: newId('ly'), name: 'Price', kind: 'shape', track: 3, startSec: s, endSec: s + 3, x: 0.78, y: 0.3, w: 0.3, rotation: -6, shape: { type: 'pill', fill: '#FFD23F', aspect: 2.4, label: '00 ₾', labelColor: '#111111' }, animIn: { type: 'pop', durationSec: 0.4 } }) },
  { key: 'cta', label: 'CTA button', make: (s) => ({ id: newId('ly'), name: 'CTA', kind: 'shape', track: 3, startSec: s, endSec: s + 3, x: 0.5, y: 0.8, w: 0.6, shape: { type: 'pill', fill: '#7C5CFF', aspect: 4.2, label: 'შეუკვეთე ახლა', labelColor: '#FFFFFF' }, animIn: { type: 'slide_up', durationSec: 0.45 } }) },
  { key: 'sale', label: 'Sale badge', make: (s) => ({ id: newId('ly'), name: 'Badge', kind: 'shape', track: 3, startSec: s, endSec: s + 3, x: 0.2, y: 0.2, w: 0.22, rotation: 12, shape: { type: 'burst', fill: '#FF3B5C', aspect: 1, label: 'NEW', labelColor: '#FFFFFF' }, animIn: { type: 'pop', durationSec: 0.35 } }) },
  { key: 'bubble', label: 'Speech bubble', make: (s) => ({ id: newId('ly'), name: 'Bubble', kind: 'shape', track: 3, startSec: s, endSec: s + 2.5, x: 0.6, y: 0.3, w: 0.4, shape: { type: 'bubble', fill: '#FFFFFF', aspect: 1.8, label: 'Wow!', labelColor: '#111111' }, animIn: { type: 'pop', durationSec: 0.3 } }) },
  { key: 'arrow', label: 'Arrow / callout', make: (s) => ({ id: newId('ly'), name: 'Arrow', kind: 'shape', track: 3, startSec: s, endSec: s + 2.5, x: 0.4, y: 0.5, w: 0.25, shape: { type: 'arrow', fill: '#FFD23F', aspect: 2.2 }, animIn: { type: 'slide_left', durationSec: 0.4 } }) },
];

// ------------------------------------------------------------------ inspector

export function LayersPanel({ timeline, apply, playhead, selectedId, setSelectedId, onPickAsset, logoAssetId }: { timeline: Timeline; apply: (fn: (t: Timeline) => Timeline) => void; playhead: number; selectedId: string | null; setSelectedId: (id: string | null) => void; onPickAsset: (kind: 'image' | 'video', cb: (a: Asset) => void) => void; logoAssetId?: string }) {
  const sel = timeline.layers.find((l) => l.id === selectedId);
  const add = (l: LayerInput) => {
    const layer = layerSchema.parse(l);
    apply((t) => ({ ...t, layers: [...t.layers, layer] }));
    setSelectedId(layer.id);
  };
  const upd = (patch: Partial<Layer>) => sel && apply((t) => ({ ...t, layers: t.layers.map((x) => (x.id === sel.id ? layerSchema.parse({ ...x, ...patch }) : x)) }));
  const start = Math.round(playhead * 10) / 10;
  const total = Math.max(1, timeline.clips.reduce((s, c) => s + (c.outSec - c.inSec), 0));
  const tracks = [...new Set([1, 2, 3, ...timeline.layers.map((l) => l.track)])].sort((a, b) => b - a);
  const meta = (i: number) => timeline.tracks.find((x) => x.index === i) ?? { index: i, locked: false, hidden: false };
  const setMeta = (i: number, patch: { locked?: boolean; hidden?: boolean }) => apply((t) => ({ ...t, tracks: [...t.tracks.filter((x) => x.index !== i), { ...meta(i), ...patch }] }));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => add({ id: newId('ly'), name: 'Text', kind: 'text', track: 2, startSec: start, endSec: start + 3, x: 0.5, y: 0.5, w: 0.7, text: { content: 'ტექსტი · Text', font: 'bold', size: 72, color: '#FFFFFF' }, animIn: { type: 'fade', durationSec: 0.3 } })}><Type /> Text</Button>
        <Button size="sm" variant="secondary" onClick={() => onPickAsset('image', (a) => add({ id: newId('ly'), name: a.originalName ?? 'Image', kind: 'image', track: 3, assetId: a.id, startSec: start, endSec: start + 3, x: 0.75, y: 0.25, w: 0.3 }))}><ImageIcon /> Image</Button>
        <Button size="sm" variant="secondary" onClick={() => onPickAsset('video', (a) => add({ id: newId('ly'), name: a.originalName ?? 'Video', kind: 'video', track: 1, assetId: a.id, startSec: start, endSec: Math.min(total, start + Math.max(1, (a.durationMs ?? 4000) / 1000)), x: 0.72, y: 0.3, w: 0.38 }))}><Video /> PiP video</Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {LAYER_TEMPLATES.map((tpl) => <button key={tpl.key} type="button" onClick={() => add(tpl.make(start))} className="rounded-full border hairline px-2.5 py-1 text-[11px] text-fog-200 hover:border-white/25">{tpl.label}</button>)}
        {logoAssetId && <button type="button" onClick={() => add({ id: newId('ly'), name: 'Logo', kind: 'image', track: 4, assetId: logoAssetId, startSec: start, endSec: total, x: 0.86, y: 0.08, w: 0.18 })} className="rounded-full border hairline px-2.5 py-1 text-[11px] text-fog-200 hover:border-white/25">Brand logo</button>}
      </div>

      <div className="space-y-1">
        {tracks.map((i) => {
          const m = meta(i);
          const items = timeline.layers.filter((l) => l.track === i);
          return (
            <div key={i} className="rounded-lg bg-white/[0.02] p-1.5">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-fog-400">
                Track V{i + 1}
                <span className="flex gap-1">
                  <button type="button" aria-label={m.hidden ? 'Show track' : 'Hide track'} onClick={() => setMeta(i, { hidden: !m.hidden })}>{m.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}</button>
                  <button type="button" aria-label={m.locked ? 'Unlock track' : 'Lock track'} onClick={() => setMeta(i, { locked: !m.locked })}>{m.locked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}</button>
                </span>
              </div>
              {items.map((l) => (
                <button key={l.id} type="button" onClick={() => setSelectedId(l.id)} className={cn('mt-1 flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs', l.id === selectedId ? 'bg-iris-500/20 text-white' : 'text-fog-200 hover:bg-white/[0.04]')}>
                  <span className="truncate">{l.name ?? l.kind}{l.text ? ` · ${l.text.content}` : l.shape?.label ? ` · ${l.shape.label}` : ''}</span>
                  <span className="tabular-nums text-fog-400">{seconds(l.startSec)}–{seconds(l.endSec)}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {sel && (
        <div className="space-y-2.5 rounded-xl border hairline p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-white">{sel.name ?? sel.kind}</span>
            <span className="flex gap-1">
              <Button size="icon" variant="ghost" aria-label="Bring forward" onClick={() => upd({ track: Math.min(10, sel.track + 1) })}><ArrowUp /></Button>
              <Button size="icon" variant="ghost" aria-label="Send backward" onClick={() => upd({ track: Math.max(1, sel.track - 1) })}><ArrowDown /></Button>
              <Button size="icon" variant="ghost" aria-label="Duplicate layer" onClick={() => add({ ...sel, id: newId('ly'), startSec: sel.startSec + 0.5, endSec: sel.endSec + 0.5 })}><Copy /></Button>
              <Button size="icon" variant="ghost" aria-label="Delete layer" onClick={() => { apply((t) => ({ ...t, layers: t.layers.filter((x) => x.id !== sel.id) })); setSelectedId(null); }}><Trash2 /></Button>
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start (s)"><Input type="number" step={0.1} min={0} value={sel.startSec} onChange={(e) => upd({ startSec: Number(e.target.value) })} /></Field>
            <Field label="End (s)"><Input type="number" step={0.1} min={0.1} value={sel.endSec} onChange={(e) => upd({ endSec: Number(e.target.value) })} /></Field>
          </div>
          {sel.text && (
            <>
              <Textarea rows={2} value={sel.text.content} maxLength={500} onChange={(e) => upd({ text: { ...sel.text!, content: e.target.value || ' ' } })} />
              <div className="grid grid-cols-2 gap-2">
                <NativeSelect value={sel.text.font} onChange={(e) => upd({ text: { ...sel.text!, font: e.target.value as Layer['text'] extends infer T ? T extends { font: infer F } ? F : never : never } })}>
                  {TEXT_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                </NativeSelect>
                <Input type="number" min={10} max={300} aria-label="Font size" value={sel.text.size} onChange={(e) => upd({ text: { ...sel.text!, size: Number(e.target.value) } })} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-fog-300">
                <label className="flex items-center gap-1">Colour <input type="color" value={sel.text.color} onChange={(e) => upd({ text: { ...sel.text!, color: e.target.value.toUpperCase() } })} className="h-6 w-8 border-0 bg-transparent" /></label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(sel.text.gradientTo)} onChange={(e) => upd({ text: { ...sel.text!, gradientTo: e.target.checked ? '#FFB020' : undefined } })} /> gradient</label>
                {sel.text.gradientTo && <input type="color" aria-label="Gradient end colour" value={sel.text.gradientTo} onChange={(e) => upd({ text: { ...sel.text!, gradientTo: e.target.value.toUpperCase() } })} className="h-6 w-8 border-0 bg-transparent" />}
                <label className="flex items-center gap-1">Outline <input type="range" min={0} max={12} value={sel.text.stroke?.width ?? 0} onChange={(e) => upd({ text: { ...sel.text!, stroke: { color: sel.text!.stroke?.color ?? '#000000', width: Number(e.target.value) } } })} className="w-16" /></label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(sel.text.shadow)} onChange={(e) => upd({ text: { ...sel.text!, shadow: e.target.checked ? { color: '#000000', opacity: 0.6, offset: 4 } : undefined } })} /> shadow</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(sel.text.background)} onChange={(e) => upd({ text: { ...sel.text!, background: e.target.checked ? { color: '#000000', opacity: 0.6, padding: 18 } : undefined } })} /> background</label>
              </div>
            </>
          )}
          {sel.shape && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <NativeSelect value={sel.shape.type} onChange={(e) => upd({ shape: { ...sel.shape!, type: e.target.value as (typeof SHAPES)[number] } })}>{SHAPES.map((x) => <option key={x}>{x}</option>)}</NativeSelect>
              <input type="color" aria-label="Fill colour" value={sel.shape.fill} onChange={(e) => upd({ shape: { ...sel.shape!, fill: e.target.value.toUpperCase() } })} className="h-9 w-full rounded border-0 bg-transparent" />
              <Input className="col-span-2" placeholder="Label" value={sel.shape.label ?? ''} maxLength={80} onChange={(e) => upd({ shape: { ...sel.shape!, label: e.target.value || undefined } })} />
            </div>
          )}
          {(['x', 'y', 'w', 'rotation', 'opacity'] as const).map((k) => (
            <label key={k} className="block text-xs text-fog-300">
              <span className="flex justify-between">{{ x: 'Horizontal', y: 'Vertical', w: 'Size', rotation: 'Rotation', opacity: 'Opacity' }[k]}<span className="tabular-nums">{k === 'rotation' ? `${sel[k]}°` : `${Math.round(sel[k] * 100)}%`}</span></span>
              <input type="range" className="w-full" min={k === 'rotation' ? -180 : k === 'w' ? 0.03 : 0} max={k === 'rotation' ? 180 : k === 'w' ? 1.5 : 1} step={k === 'rotation' ? 1 : 0.005} value={sel[k]} onChange={(e) => upd({ [k]: Number(e.target.value) })} />
            </label>
          ))}
          <div className="flex flex-wrap gap-3 text-xs text-fog-300">
            <label className="flex items-center gap-1"><input type="checkbox" checked={sel.flipH} onChange={(e) => upd({ flipH: e.target.checked })} /> Flip ↔</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={sel.flipV} onChange={(e) => upd({ flipV: e.target.checked })} /> Flip ↕</label>
            {(sel.kind === 'video' || sel.kind === 'image') && <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(sel.chromaKey)} onChange={(e) => upd({ chromaKey: e.target.checked ? { color: '#00FF00', similarity: 0.15, blend: 0.05 } : undefined })} /> Green screen</label>}
            {sel.kind === 'video' && <label className="flex items-center gap-1">Sound <input type="range" min={0} max={1} step={0.05} value={sel.volume} onChange={(e) => upd({ volume: Number(e.target.value) })} className="w-16" /></label>}
          </div>
          {(sel.kind === 'video' || sel.kind === 'image') && (
            <div className="grid grid-cols-4 gap-1 text-[10px] text-fog-400">
              {(['l', 't', 'r', 'b'] as const).map((k) => (
                <label key={k}>Crop {k}<input type="range" className="w-full" min={0} max={0.45} step={0.01} value={sel.crop?.[k] ?? 0} onChange={(e) => upd({ crop: { l: 0, t: 0, r: 0, b: 0, ...sel.crop, [k]: Number(e.target.value) } })} /></label>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Animate in">
              <NativeSelect value={sel.animIn.type} onChange={(e) => upd({ animIn: { ...sel.animIn, type: e.target.value as Layer['animIn']['type'] } })}>{LAYER_ANIMS.filter((a) => sel.kind === 'text' || (a !== 'typewriter' && a !== 'words')).map((a) => <option key={a} value={a}>{a.replace('_', ' ')}</option>)}</NativeSelect>
            </Field>
            <Field label="Animate out">
              <NativeSelect value={sel.animOut.type} onChange={(e) => upd({ animOut: { ...sel.animOut, type: e.target.value as Layer['animOut']['type'] } })}>{LAYER_ANIMS.filter((a) => a !== 'typewriter' && a !== 'words').map((a) => <option key={a} value={a}>{a.replace('_', ' ')}</option>)}</NativeSelect>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Button size="sm" variant="ghost" onClick={() => {
              const local = Math.max(0, Math.round((playhead - sel.startSec) * 100) / 100);
              const st = layerStateAt({ ...sel, animIn: { type: 'none', durationSec: 0.4 }, animOut: { type: 'none', durationSec: 0.4 }, follow: undefined }, playhead);
              upd({ keyframes: [...sel.keyframes.filter((k) => Math.abs(k.t - local) > 0.04), { t: local, x: st.x, y: st.y, scale: st.scale, rotation: st.rotation }].sort((a, b) => a.t - b.t) });
            }}><Plus /> Keyframe at playhead</Button>
            {sel.keyframes.length > 0 && <span className="text-fog-400">{sel.keyframes.length} keyframes · drag the layer to set the position at the playhead</span>}
            {sel.keyframes.length > 0 && <Button size="sm" variant="ghost" onClick={() => upd({ keyframes: [] })}>Clear</Button>}
            {sel.follow && <span className="rounded bg-iris-500/20 px-1.5 py-0.5 text-iris-100">follows a tracked object <button type="button" onClick={() => upd({ follow: undefined })}>✕</button></span>}
          </div>
        </div>
      )}
    </div>
  );
}
