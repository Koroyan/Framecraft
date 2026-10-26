'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Crosshair, Droplet, EyeOff, Loader2, Palette, Plus, Scissors, Sparkles, SunMedium, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { applyTransform, colorName, describeEffects, lostSpans, maskBounds, maskTransformAt, mergeTrack, OBJECT_SCOPES, prepareFrame, regionAt, selectFrom, type EditMask, type ObjectEdit, type ObjectEffect, type ObjectScope, type PreparedFrame, type Selection, type Timeline, type TimelineClip } from '@framecraft/shared';
import { api, ApiError } from '@/lib/api';
import { newId, useEditor } from '@/lib/editor-store';
import { useObjectUi } from '@/lib/object-ui';
import type { EditEstimate } from '@/lib/studio';
import { Button, Dialog, Field, Segmented, Spinner, Textarea } from '@/components/ui';
import { cn, newKey, seconds } from '@/lib/utils';
import { coverCrop } from './grade-canvas';
import type { PreviewFrame } from './preview';

/*
 * Object editing on the preview: click an object → it is outlined → a toolbar offers what can be
 * done to *that* object (colour, light, blur, AI) and for *which seconds* (this frame, whole clip,
 * until it disappears, custom). Moving objects are tracked (free, on our server); uncertain frames
 * are marked and fixed by dragging the outline there. Manual effects are free and exported exactly
 * as previewed; AI edits always show their price and run only after confirmation.
 */

type Apply = (fn: (t: Timeline) => Timeline) => void;
type Track = NonNullable<EditMask['track']> & { lost: number; reliable: { start: number; end: number } };

export const PALETTE: [string, string][] = [['Red', '#D92B2B'], ['Orange', '#F07C1E'], ['Yellow', '#F2C823'], ['Green', '#2E9E4F'], ['Teal', '#1E9C9C'], ['Blue', '#2563EB'], ['Navy', '#1E2F6B'], ['Purple', '#7C3AED'], ['Pink', '#E84A8A'], ['White', '#F2F2F2'], ['Grey', '#7A7A7A'], ['Black', '#151515']];

// The last click's prepared frame and growth map (re-used for tightness, add and subtract).
const last: { key: string; prep: PreparedFrame | null; sel: Selection | null; objectId: string | null; poly: number } = { key: '', prep: null, sel: null, objectId: null, poly: 0 };

function grab(video: HTMLVideoElement): { data: Uint8ClampedArray; width: number; height: number } | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const w = 480;
  const h = Math.max(2, Math.round((480 * vh) / vw));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  try {
    g.drawImage(video, 0, 0, w, h);
    return { data: g.getImageData(0, 0, w, h).data, width: w, height: h };
  } catch {
    return null; // pixels not readable (storage without CORS)
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pointInPoly = (x: number, y: number, pts: [number, number][]) => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

export function findClip(t: Timeline, clipId: string | undefined): TimelineClip | undefined {
  return clipId ? t.clips.find((c) => c.id === clipId) : undefined;
}
export function findObject(t: Timeline, ref: { clipId: string; objectId: string } | null) {
  if (!ref) return { clip: undefined, obj: undefined };
  const clip = findClip(t, ref.clipId);
  return { clip, obj: clip?.objects?.find((o) => o.id === ref.objectId) };
}

function updateObject(apply: Apply, clipId: string, objectId: string, fn: (o: ObjectEdit) => ObjectEdit | null) {
  apply((t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id !== clipId ? c : { ...c, objects: (c.objects ?? []).flatMap((o) => (o.id !== objectId ? [o] : (() => { const r = fn(o); return r ? [r] : []; })())) })),
  }));
}

/** Range (source seconds) for a scope choice. */
function rangeFor(clip: TimelineClip, obj: ObjectEdit, scope: ObjectScope, reliable?: { start: number; end: number }) {
  const lo = Math.min(clip.inSec, clip.outSec);
  const hi = Math.max(clip.inSec, clip.outSec);
  if (scope === 'frame') return { startSec: obj.atSec, endSec: obj.atSec };
  if (scope === 'until_lost' && reliable) return { startSec: Math.max(lo, reliable.start), endSec: Math.min(hi, reliable.end) };
  if (scope === 'range') return { startSec: Math.max(lo, obj.atSec - 1), endSec: Math.min(hi, obj.atSec + 1) };
  return { startSec: lo, endSec: hi };
}

// ------------------------------------------------------------------ actions

export function useObjectActions(projectId: string, apply: Apply) {
  const ui = useObjectUi();
  void projectId;

  /** Track the object over its range (or the whole clip), free. */
  const track = async (clip: TimelineClip, obj: ObjectEdit, o: { wholeClip?: boolean } = {}): Promise<Track | null> => {
    const b = maskBounds(obj.mask);
    if (!b) return null;
    const lo = Math.min(clip.inSec, clip.outSec);
    const hi = Math.max(clip.inSec, clip.outSec);
    const startSec = o.wholeClip ? lo : Math.min(obj.startSec, obj.atSec);
    const endSec = o.wholeClip ? hi : Math.max(obj.endSec, obj.atSec + 0.05);
    useObjectUi.getState().set({ tracking: obj.id });
    try {
      const r = await api<{ track: Track }>(`/api/assets/${clip.assetId}/track`, { body: { box: { x: b.x0, y: b.y0, w: Math.max(0.005, b.x1 - b.x0), h: Math.max(0.005, b.y1 - b.y0) }, atSec: obj.atSec, startSec, endSec } });
      updateObject(apply, clip.id, obj.id, (x) => ({ ...x, mask: { ...x.mask, track: { points: r.track.points, smoothing: r.track.smoothing } } }));
      if (r.track.lost) toast.message(`Tracked — ${r.track.lost} uncertain frame${r.track.lost === 1 ? '' : 's'} (marked red). Drag the outline there to correct.`);
      else toast.success('Tracked — the selection follows the object.');
      return r.track;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Tracking failed — the selection stays where you drew it.');
      return null;
    } finally {
      useObjectUi.getState().set({ tracking: null });
    }
  };

  const setScope = async (clip: TimelineClip, obj: ObjectEdit, scope: ObjectScope) => {
    if (scope === 'until_lost') {
      const tr = await track(clip, obj, { wholeClip: true });
      if (!tr) return;
      updateObject(apply, clip.id, obj.id, (x) => ({ ...x, scope, ...rangeFor(clip, x, scope, tr.reliable) }));
      return;
    }
    updateObject(apply, clip.id, obj.id, (x) => ({ ...x, scope, ...rangeFor(clip, x, scope) }));
  };

  /** Add or replace an effect of the same kind; moving selections over more than a moment get tracked. */
  const setEffect = (clip: TimelineClip, obj: ObjectEdit, effect: ObjectEffect | null, kind: ObjectEffect['type'] | 'spatial') => {
    updateObject(apply, clip.id, obj.id, (x) => {
      const rest = x.effects.filter((e) => (kind === 'spatial' ? e.type !== 'blur' && e.type !== 'pixelate' : e.type !== kind));
      return { ...x, effects: effect ? [...rest, effect] : rest };
    });
    if (effect && !obj.mask.track && obj.scope !== 'frame' && obj.endSec - obj.startSec > 0.4 && !useObjectUi.getState().tracking) void track(clip, obj);
  };

  /** New selection (or add / subtract a region) from a click on the picture at source point (sx, sy). */
  const selectAt = (pf: PreviewFrame, sx: number, sy: number, mode: 'new' | 'add' | 'subtract') => {
    const clip = pf.clip;
    const v = pf.video.current;
    if (!clip || !v) return;
    const key = `${clip.assetId}:${pf.srcTime.toFixed(3)}`;
    if (last.key !== key || !last.prep) {
      const img = grab(v);
      if (!img) {
        toast.error('This video’s pixels can’t be read in the browser, so automatic selection is off. Use the shot editor’s brush or rectangle instead.');
        return;
      }
      last.prep = prepareFrame(img);
      last.key = key;
    }
    const prep = last.prep!;
    const sel = selectFrom(prep, sx * prep.width, sy * prep.height);
    const region = regionAt(prep, sel, sel.auto * useObjectUi.getState().tightness);
    if (!region || region.area > 0.85) {
      toast.message('No clear object there. Click the middle of the object, or use Refine to add or remove parts.');
      return;
    }
    const sub = mode === 'subtract';
    const ref = useObjectUi.getState().sel;
    const current = ref && ref.clipId === clip.id ? clip.objects?.find((o) => o.id === ref.objectId) : undefined;
    if ((mode === 'add' || sub) && current) {
      // Regions are added in the object's drawn coordinates (undo the track transform at this frame).
      const tr = maskTransformAt(current.mask, pf.srcTime);
      const inv = (x: number, y: number): [number, number] => [tr.cx + (x - tr.dx - tr.cx) / tr.s, tr.cy + (y - tr.dy - tr.cy) / tr.s];
      updateObject(apply, clip.id, current.id, (o) => ({ ...o, mask: { ...o.mask, polygons: [...o.mask.polygons, { points: region.polygon.map(([x, y]) => inv(x, y)), subtract: sub }].slice(-20) } }));
      last.sel = sel;
      last.objectId = current.id;
      last.poly = current.mask.polygons.length;
      return;
    }
    const id = newId('obj').slice(0, 40);
    const name = `${capital(colorName(region.color))} object`;
    const obj: ObjectEdit = {
      id,
      name,
      mask: { rects: [], strokes: [], polygons: [{ points: region.polygon, subtract: false }], feather: 0.006, invert: false },
      atSec: pf.srcTime,
      startSec: Math.min(clip.inSec, clip.outSec),
      endSec: Math.max(clip.inSec, clip.outSec),
      scope: 'clip',
      effects: [],
      color: region.color,
      enabled: true,
    };
    apply((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, objects: [...(c.objects ?? []), obj].slice(-8) } : c)) }));
    last.sel = sel;
    last.objectId = id;
    last.poly = 0;
    ui.set({ sel: { clipId: clip.id, objectId: id }, popover: null });
  };

  /** Re-threshold the last click with a new tightness (no recomputation). */
  const retighten = (tightness: number) => {
    useObjectUi.getState().set({ tightness });
    const ref = useObjectUi.getState().sel;
    if (!ref || !last.prep || !last.sel || last.objectId !== ref.objectId) return;
    const region = regionAt(last.prep, last.sel, last.sel.auto * tightness);
    if (!region) return;
    updateObject(apply, ref.clipId, ref.objectId, (o) => {
      const polys = [...o.mask.polygons];
      if (!polys[last.poly]) return o;
      polys[last.poly] = { ...polys[last.poly]!, points: region.polygon };
      return { ...o, mask: { ...o.mask, polygons: polys }, ...(last.poly === 0 ? { color: region.color } : {}) };
    });
  };

  /** The user dragged the outline at source time t by (ddx, ddy): move the selection, or correct the track from here on. */
  const correct = async (clip: TimelineClip, obj: ObjectEdit, t: number, ddx: number, ddy: number) => {
    if (!obj.mask.track) {
      updateObject(apply, clip.id, obj.id, (o) => ({ ...o, mask: { ...o.mask, polygons: o.mask.polygons.map((p) => ({ ...p, points: p.points.map(([x, y]) => [Math.min(1, Math.max(0, x + ddx)), Math.min(1, Math.max(0, y + ddy))] as [number, number]) })), rects: o.mask.rects.map((r) => ({ ...r, x: r.x + ddx, y: r.y + ddy })) } }));
      return;
    }
    const tr = maskTransformAt(obj.mask, t);
    const offset = { dx: tr.dx + ddx, dy: tr.dy + ddy, s: tr.s };
    const b = maskBounds(obj.mask)!;
    const [x0, y0] = applyTransform({ ...tr, ...offset }, b.x0, b.y0);
    const [x1, y1] = applyTransform({ ...tr, ...offset }, b.x1, b.y1);
    useObjectUi.getState().set({ tracking: obj.id });
    try {
      const r = await api<{ track: Track }>(`/api/assets/${clip.assetId}/track`, { body: { box: { x: Math.max(0, x0), y: Math.max(0, y0), w: Math.max(0.005, x1 - x0), h: Math.max(0.005, y1 - y0) }, atSec: t, startSec: t, endSec: Math.max(obj.endSec, t + 0.05) } });
      updateObject(apply, clip.id, obj.id, (o) => ({ ...o, mask: { ...o.mask, track: mergeTrack(o.mask.track, t, r.track, offset) } }));
      toast.success('Corrected — tracked again from this frame.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not re-track');
    } finally {
      useObjectUi.getState().set({ tracking: null });
    }
  };

  const remove = (clipId: string, objectId: string) => {
    updateObject(apply, clipId, objectId, () => null);
    ui.set({ sel: null, popover: null });
  };

  return { track, setScope, setEffect, selectAt, retighten, correct, remove };
}

// ------------------------------------------------------------------ outline + clicks (inside the picture)

export function ObjectLayer({ pf, projectId, apply }: { pf: PreviewFrame; projectId: string; apply: Apply }) {
  const { selecting, sel, tracking } = useObjectUi();
  const actions = useObjectActions(projectId, apply);
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; y0: number; moved: boolean; inside: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ dx: number; dy: number } | null>(null);
  const clip = pf.clip;
  const v = pf.video.current;
  const crop = coverCrop(v?.videoWidth || 16, v?.videoHeight || 9, pf.size.w, pf.size.h, pf.objectPosition);
  const objs = clip?.objects ?? [];
  const selected = clip && sel?.clipId === clip.id ? objs.find((o) => o.id === sel.objectId) : undefined;

  const toSrc = (clientX: number, clientY: number): [number, number] => {
    const r = el.current!.getBoundingClientRect();
    return [crop[0] + ((clientX - r.left) / r.width) * crop[2], crop[1] + ((clientY - r.top) / r.height) * crop[3]];
  };
  const shapes = (o: ObjectEdit, extra?: { dx: number; dy: number }) => {
    const tr = maskTransformAt(o.mask, pf.srcTime);
    const t2 = extra ? { ...tr, dx: tr.dx + extra.dx, dy: tr.dy + extra.dy } : tr;
    const toElem = (x: number, y: number) => {
      const [sx, sy] = applyTransform(t2, x, y);
      return [(sx - crop[0]) / crop[2], (sy - crop[1]) / crop[3]] as [number, number];
    };
    return {
      polys: o.mask.polygons.map((p) => ({ sub: p.subtract, pts: p.points.map(([x, y]) => toElem(x, y)) })),
      rects: o.mask.rects.map((r) => ({ sub: r.subtract, ellipse: r.ellipse, a: toElem(r.x, r.y), b: toElem(r.x + r.w, r.y + r.h) })),
      srcPolys: o.mask.polygons.filter((p) => !p.subtract).map((p) => p.points.map(([x, y]) => applyTransform(t2, x, y))),
    };
  };
  if (!clip) return null;
  const active = (o: ObjectEdit) => pf.srcTime >= o.startSec - 0.05 && pf.srcTime <= Math.max(o.endSec, o.startSec + 0.04) + 0.05;
  const lost = selected?.mask.track?.points.find((p) => Math.abs(p.t - pf.srcTime) < 0.07 && (p.conf ?? 1) < 0.45);

  return (
    <div
      ref={el}
      data-testid="object-layer"
      className={cn('absolute inset-0', selecting ? 'cursor-crosshair' : 'pointer-events-none')}
      onPointerDown={(e) => {
        if (!selecting) return;
        e.stopPropagation();
        const [sx, sy] = toSrc(e.clientX, e.clientY);
        const inside = Boolean(selected && shapes(selected).srcPolys.some((p) => pointInPoly(sx, sy, p)));
        drag.current = { x0: e.clientX, y0: e.clientY, moved: false, inside };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || !d.inside) return;
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 4) d.moved = true;
        if (!d.moved) return;
        const r = el.current!.getBoundingClientRect();
        setGhost({ dx: ((e.clientX - d.x0) / r.width) * crop[2], dy: ((e.clientY - d.y0) / r.height) * crop[3] });
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.moved && selected && ghost) {
          const g = ghost;
          setGhost(null);
          void actions.correct(clip, selected, pf.srcTime, g.dx, g.dy);
          return;
        }
        setGhost(null);
        const [sx, sy] = toSrc(e.clientX, e.clientY);
        if (e.shiftKey || e.altKey) return actions.selectAt(pf, sx, sy, e.altKey ? 'subtract' : 'add');
        // Clicking an existing object selects it; anywhere else makes a new selection.
        const hit = [...objs].reverse().find((o) => active(o) && shapes(o).srcPolys.some((p) => pointInPoly(sx, sy, p)));
        if (hit) useObjectUi.getState().set({ sel: { clipId: clip.id, objectId: hit.id }, popover: null });
        else actions.selectAt(pf, sx, sy, 'new');
      }}
    >
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
        {objs.map((o) => {
          const isSel = o.id === selected?.id;
          if (!isSel && !selecting) return null;
          if (!isSel && !active(o)) return null;
          const s = shapes(o, isSel && ghost ? ghost : undefined);
          const stroke = isSel ? (lost ? '#F87171' : '#FFFFFF') : 'rgba(255,255,255,0.45)';
          return (
            <g key={o.id} opacity={active(o) ? 1 : 0.35}>
              {s.polys.map((p, i) => (
                <polygon key={`p${i}`} points={p.pts.map(([x, y]) => `${x},${y}`).join(' ')} fill={p.sub ? 'rgba(0,0,0,0.25)' : isSel ? 'rgba(124,92,255,0.18)' : 'transparent'} stroke={stroke} strokeWidth={isSel ? 2 : 1} strokeDasharray={isSel ? '6 4' : '3 3'} vectorEffect="non-scaling-stroke" className={isSel ? 'animate-ants' : ''} />
              ))}
              {s.rects.map((r, i) =>
                r.ellipse ? (
                  <ellipse key={`r${i}`} cx={(r.a[0] + r.b[0]) / 2} cy={(r.a[1] + r.b[1]) / 2} rx={Math.abs(r.b[0] - r.a[0]) / 2} ry={Math.abs(r.b[1] - r.a[1]) / 2} fill="rgba(124,92,255,0.15)" stroke={stroke} strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
                ) : (
                  <rect key={`r${i}`} x={Math.min(r.a[0], r.b[0])} y={Math.min(r.a[1], r.b[1])} width={Math.abs(r.b[0] - r.a[0])} height={Math.abs(r.b[1] - r.a[1])} fill="rgba(124,92,255,0.15)" stroke={stroke} strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
                ),
              )}
            </g>
          );
        })}
      </svg>
      {selected && lost && <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-signal-red/90 px-2 py-0.5 text-[10px] font-medium text-white">Tracking unsure here — drag the outline onto the object</span>}
      {tracking && <span className="pointer-events-none absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/75 px-2.5 py-1 text-[11px] text-white"><Loader2 className="size-3 animate-spin" /> Tracking the object…</span>}
    </div>
  );
}

// ------------------------------------------------------------------ floating toolbar

function Pop({ children, className }: { children: React.ReactNode; className?: string }) {
  // Opens from the toolbar's left edge so the middle of the picture (and the live result) stays visible.
  return <div className={cn('pointer-events-auto absolute left-0 top-full z-30 mt-2 max-h-[60dvh] w-[min(284px,92vw)] overflow-y-auto rounded-2xl border hairline bg-ink-900/97 p-3 text-xs shadow-2xl backdrop-blur', className)}>{children}</div>;
}

function TBtn({ icon: Icon, label, active, onClick, disabled, title }: { icon: typeof Palette; label: string; active?: boolean; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title ?? label} aria-pressed={active} className={cn('flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs transition disabled:opacity-40', active ? 'bg-white/12 text-white' : 'text-fog-200 hover:bg-white/[0.07] hover:text-white')}>
      <Icon className="size-3.5" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export function ObjectToolbar({ pf, projectId, apply, timeline }: { pf: PreviewFrame; projectId: string; apply: Apply; timeline: Timeline }) {
  const { selecting, sel, popover, tracking, tightness, set } = useObjectUi();
  const actions = useObjectActions(projectId, apply);
  const { clip, obj } = findObject(timeline, sel);
  const onClip = Boolean(clip && pf.clip && clip.id === pf.clip.id);
  if (!obj || !clip || !onClip) {
    if (!selecting) return null;
    return (
      <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-iris-400/40 bg-ink-900/95 px-3 py-1.5 text-xs text-fog-200 shadow-xl">
        <Crosshair className="size-3.5 text-iris-300" /> Click an object in the picture. <span className="hidden text-fog-400 md:inline">Shift adds · Alt removes · Esc stops</span>
        <button type="button" onClick={() => set({ selecting: false })} className="ml-1 rounded-md px-1.5 py-0.5 text-fog-400 hover:bg-white/[0.06] hover:text-white">Done</button>
      </div>
    );
  }
  const recolor = obj.effects.find((e) => e.type === 'recolor') as Extract<ObjectEffect, { type: 'recolor' }> | undefined;
  const adjust = obj.effects.find((e) => e.type === 'adjust') as Extract<ObjectEffect, { type: 'adjust' }> | undefined;
  const spatial = obj.effects.find((e) => e.type === 'blur' || e.type === 'pixelate') as Extract<ObjectEffect, { type: 'blur' | 'pixelate' }> | undefined;
  const toggle = (p: NonNullable<typeof popover>) => set({ popover: popover === p ? null : p });
  const scopeLabel = OBJECT_SCOPES.find((s) => s.key === obj.scope)?.label ?? 'Whole clip';
  const len = Math.max(0, obj.endSec - obj.startSec);

  return (
    <div className="pointer-events-auto relative" data-testid="object-toolbar">
      <div className="flex max-w-full flex-wrap items-center gap-0.5 rounded-xl border hairline bg-ink-900/95 p-1 shadow-xl backdrop-blur">
        <span className="flex items-center gap-1.5 px-2 text-xs font-medium text-white">
          <span className="size-3 rounded-full border border-white/40" style={{ background: recolor?.to ?? obj.color ?? '#888' }} />
          <span className="max-w-[9rem] truncate">{obj.name}</span>
        </span>
        <span className="mx-0.5 h-5 w-px bg-white/10" />
        <TBtn icon={Palette} label="Colour" active={popover === 'color' || Boolean(recolor)} onClick={() => toggle('color')} />
        <TBtn icon={SunMedium} label="Adjust" active={popover === 'adjust' || Boolean(adjust)} onClick={() => toggle('adjust')} />
        <TBtn icon={Droplet} label="Blur" active={popover === 'blur' || Boolean(spatial)} onClick={() => toggle('blur')} />
        <TBtn icon={Sparkles} label="AI" active={popover === 'ai'} onClick={() => toggle('ai')} title="Remove, replace or fix with AI (paid — price shown first)" />
        <span className="mx-0.5 h-5 w-px bg-white/10" />
        <button type="button" onClick={() => toggle('scope')} className={cn('flex h-8 items-center gap-1 rounded-lg px-2 text-xs', popover === 'scope' ? 'bg-white/12 text-white' : 'text-fog-200 hover:bg-white/[0.07]')} title="Which seconds this edit changes">
          <span className="text-fog-400">For</span> {scopeLabel} <span className="text-fog-500">· {obj.scope === 'frame' ? '1 frame' : `${len.toFixed(1)} s`}</span>
        </button>
        <TBtn icon={tracking === obj.id ? Loader2 : Crosshair} label={obj.mask.track ? 'Re-track' : 'Track'} onClick={() => void actions.track(clip, obj)} disabled={Boolean(tracking)} title="Follow the object while it moves (free)" />
        <TBtn icon={Wand2} label="Refine" active={popover === 'refine'} onClick={() => toggle('refine')} />
        <span className="mx-0.5 h-5 w-px bg-white/10" />
        <button type="button" aria-label="Delete selection" title="Delete this selection and its effects" onClick={() => actions.remove(clip.id, obj.id)} className="grid size-8 place-items-center rounded-lg text-fog-400 hover:bg-white/[0.07] hover:text-signal-red"><Trash2 className="size-3.5" /></button>
        <button type="button" aria-label="Done" title="Done (Esc)" onClick={() => set({ sel: null, popover: null, selecting: false })} className="grid size-8 place-items-center rounded-lg text-fog-300 hover:bg-white/[0.07] hover:text-white"><Check className="size-4" /></button>
      </div>

      {popover === 'color' && (
        <Pop>
          <div className="mb-2 flex items-center justify-between text-fog-300">
            <span className="flex items-center gap-1.5">From <span className="size-3.5 rounded border border-white/30" style={{ background: recolor?.from ?? obj.color }} /> to</span>
            {recolor && <button type="button" className="text-fog-400 hover:text-white" onClick={() => actions.setEffect(clip, obj, null, 'recolor')}>Remove colour</button>}
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {PALETTE.map(([name, hex]) => (
              <button key={hex} type="button" title={name} aria-label={name} onClick={() => actions.setEffect(clip, obj, { type: 'recolor', from: recolor?.from ?? obj.color ?? '#808080', to: hex, range: recolor?.range ?? 0.25, softness: 0.5, strength: recolor?.strength ?? 1, keepLightness: true }, 'recolor')} className={cn('aspect-square rounded-lg border-2 transition hover:scale-105', recolor?.to === hex ? 'border-white' : 'border-transparent')} style={{ background: hex }} />
            ))}
          </div>
          <label className="mt-2 flex items-center justify-between gap-2 text-fog-300">
            Any colour <input type="color" value={recolor?.to ?? '#2563EB'} onChange={(e) => actions.setEffect(clip, obj, { type: 'recolor', from: recolor?.from ?? obj.color ?? '#808080', to: e.target.value.toUpperCase(), range: recolor?.range ?? 0.25, softness: 0.5, strength: recolor?.strength ?? 1, keepLightness: true }, 'recolor')} className="h-7 w-12 rounded border-0 bg-transparent" />
          </label>
          {recolor && (
            <>
              <Field label={`Colour tolerance · ${Math.round(recolor.range * 100)}`} hint="Wider catches more shades of the object's colour (folds, shadows).">
                <input type="range" min={0.06} max={0.6} step={0.01} value={recolor.range} onChange={(e) => actions.setEffect(clip, obj, { ...recolor, range: Number(e.target.value) }, 'recolor')} className="w-full" />
              </Field>
              <Field label={`Strength · ${Math.round(recolor.strength * 100)}%`}>
                <input type="range" min={0.1} max={1} step={0.05} value={recolor.strength} onChange={(e) => actions.setEffect(clip, obj, { ...recolor, strength: Number(e.target.value) }, 'recolor')} className="w-full" />
              </Field>
            </>
          )}
          <p className="mt-1 text-[10px] text-fog-500">Free · exact · only this object's colour changes, everything else keeps its colour.</p>
        </Pop>
      )}

      {popover === 'adjust' && (
        <Pop>
          {(
            [
              ['exposure', 'Brightness', -1.5, 1.5],
              ['contrast', 'Contrast', -0.8, 0.8],
              ['saturation', 'Saturation', -1, 1],
              ['temperature', 'Warmth', -1, 1],
            ] as const
          ).map(([k, label, lo, hi]) => (
            <Field key={k} label={`${label} · ${Math.round(((adjust?.[k] ?? 0) as number) * 100)}`}>
              <input type="range" min={lo} max={hi} step={0.02} value={(adjust?.[k] ?? 0) as number} onChange={(e) => actions.setEffect(clip, obj, { type: 'adjust', exposure: 0, brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, hue: 0, ...(adjust ?? {}), [k]: Number(e.target.value) }, 'adjust')} className="w-full" />
            </Field>
          ))}
          <div className="flex justify-between">
            <span className="text-[10px] text-fog-500">Free · only inside the selection</span>
            {adjust && <button type="button" className="text-fog-400 hover:text-white" onClick={() => actions.setEffect(clip, obj, null, 'adjust')}>Reset</button>}
          </div>
        </Pop>
      )}

      {popover === 'blur' && (
        <Pop>
          <Segmented
            size="sm"
            value={spatial?.type ?? 'none'}
            onChange={(v) => actions.setEffect(clip, obj, v === 'none' ? null : v === 'blur' ? { type: 'blur', amount: 16 } : { type: 'pixelate', size: 28 }, 'spatial')}
            options={[
              { value: 'none', label: 'None' },
              { value: 'blur', label: 'Blur' },
              { value: 'pixelate', label: 'Pixelate' },
            ]}
          />
          {spatial?.type === 'blur' && (
            <Field label={`Amount · ${Math.round(spatial.amount)}`}>
              <input type="range" min={2} max={60} step={1} value={spatial.amount} onChange={(e) => actions.setEffect(clip, obj, { type: 'blur', amount: Number(e.target.value) }, 'spatial')} className="w-full" />
            </Field>
          )}
          {spatial?.type === 'pixelate' && (
            <Field label={`Block size · ${Math.round(spatial.size)}`}>
              <input type="range" min={6} max={120} step={2} value={spatial.size} onChange={(e) => actions.setEffect(clip, obj, { type: 'pixelate', size: Number(e.target.value) }, 'spatial')} className="w-full" />
            </Field>
          )}
          <p className="mt-1 text-[10px] text-fog-500">For faces, number plates or logos. Free.</p>
        </Pop>
      )}

      {popover === 'ai' && (
        <Pop>
          <p className="mb-2 text-fog-300">Changes the pixels with a paid AI model. You see the price before anything runs, and compare before it replaces your clip.</p>
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => set({ ai: 'remove', popover: null })}><EyeOff /> Remove</Button>
            <Button size="sm" variant="secondary" onClick={() => set({ ai: 'replace', popover: null })}><Scissors /> Replace…</Button>
            <Button size="sm" variant="secondary" onClick={() => set({ ai: 'fix', popover: null })}><Wand2 /> Fix…</Button>
            <Button size="sm" variant="secondary" onClick={() => set({ ai: 'restyle', popover: null })}><Sparkles /> Restyle…</Button>
          </div>
        </Pop>
      )}

      {popover === 'scope' && (
        <Pop>
          <div className="mb-2 text-fog-300">Which seconds should change?</div>
          <div className="grid grid-cols-2 gap-1.5">
            {OBJECT_SCOPES.map((s) => (
              <button key={s.key} type="button" disabled={Boolean(tracking)} onClick={() => void actions.setScope(clip, obj, s.key)} className={cn('rounded-lg border px-2 py-1.5 text-left', obj.scope === s.key ? 'border-iris-400 bg-iris-500/15 text-white' : 'hairline text-fog-200 hover:border-white/25')}>
                {s.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-white">
            {obj.scope === 'frame' ? `Only the frame at ${seconds(obj.atSec)}` : `${seconds(obj.startSec)} → ${seconds(obj.endSec)} of this clip (${len.toFixed(1)} s)`}
          </p>
          <p className="mt-1 text-[10px] text-fog-500">Fine-tune the exact seconds in the panel on the right. “Until it disappears” tracks first.</p>
        </Pop>
      )}

      {popover === 'refine' && (
        <Pop>
          <Field label={`Selection edge · ${tightness < 0.95 ? 'tighter' : tightness > 1.05 ? 'looser' : 'automatic'}`} hint="Moves the edge of the last click's selection.">
            <input type="range" min={0.5} max={1.8} step={0.05} value={tightness} onChange={(e) => actions.retighten(Number(e.target.value))} className="w-full" />
          </Field>
          <Field label={`Soft edge · ${Math.round(obj.mask.feather * 1000)}`}>
            <input type="range" min={0} max={0.04} step={0.001} value={obj.mask.feather} onChange={(e) => updateObject(apply, clip.id, obj.id, (o) => ({ ...o, mask: { ...o.mask, feather: Number(e.target.value) } }))} className="w-full" />
          </Field>
          <ul className="mt-1 space-y-0.5 text-[11px] text-fog-300">
            <li><b className="text-white">Shift + click</b> adds a part, <b className="text-white">Alt + click</b> removes one.</li>
            <li><b className="text-white">Drag the outline</b> to move it (on a tracked object: corrects the tracking from that frame).</li>
          </ul>
          <label className="mt-2 flex items-center gap-2 text-fog-300"><input type="checkbox" checked={obj.mask.invert} onChange={(e) => updateObject(apply, clip.id, obj.id, (o) => ({ ...o, mask: { ...o.mask, invert: e.target.checked } }))} className="accent-iris-500" /> Everything except the object</label>
        </Pop>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ right panel

/** Bar over the clip's source range: the object's seconds (draggable ends), uncertain tracking (red), playhead. */
function RangeStrip({ clip, obj, srcNow, onChange, onSeek }: { clip: TimelineClip; obj: ObjectEdit; srcNow: number | null; onChange: (start: number, end: number) => void; onSeek: (src: number) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<'start' | 'end' | null>(null);
  const lo = Math.min(clip.inSec, clip.outSec);
  const hi = Math.max(clip.inSec, clip.outSec);
  const span = Math.max(0.01, hi - lo);
  const pct = (v: number) => `${((Math.min(hi, Math.max(lo, v)) - lo) / span) * 100}%`;
  const at = (x: number) => {
    const r = bar.current!.getBoundingClientRect();
    return lo + Math.min(1, Math.max(0, (x - r.left) / r.width)) * span;
  };
  const lostList = lostSpans(obj.mask);
  return (
    <div
      ref={bar}
      className="relative h-8 cursor-pointer touch-none rounded-lg bg-white/[0.05]"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        if (!drag.current) onSeek(at(e.clientX));
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const v = at(e.clientX);
        if (drag.current === 'start') onChange(Math.min(v, obj.endSec - 0.05), obj.endSec);
        else onChange(obj.startSec, Math.max(v, obj.startSec + 0.05));
      }}
      onPointerUp={() => (drag.current = null)}
    >
      {lostList.map((l, i) => <span key={i} title="Tracking unsure" className="absolute bottom-0 h-1.5 rounded bg-signal-red/80" style={{ left: pct(l.start), width: `max(3px, calc(${pct(l.end)} - ${pct(l.start)}))` }} />)}
      <span className="absolute inset-y-1 rounded-md border border-iris-400 bg-iris-500/25" style={{ left: pct(obj.startSec), width: `calc(${pct(Math.max(obj.endSec, obj.startSec + 0.04))} - ${pct(obj.startSec)})` }}>
        {(['start', 'end'] as const).map((side) => (
          <span key={side} role="slider" aria-label={side === 'start' ? 'Edit starts' : 'Edit ends'} aria-valuenow={side === 'start' ? obj.startSec : obj.endSec} tabIndex={0} className={cn('absolute inset-y-0 w-2.5 cursor-ew-resize bg-iris-400', side === 'start' ? '-left-1.5 rounded-l' : '-right-1.5 rounded-r')} onPointerDown={(e) => { e.stopPropagation(); bar.current!.setPointerCapture(e.pointerId); drag.current = side; }} />
        ))}
      </span>
      <span className="pointer-events-none absolute inset-y-0 w-px bg-fog-300/60" style={{ left: pct(obj.atSec) }} title="Selection drawn here" />
      {srcNow !== null && <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-white" style={{ left: pct(srcNow) }} />}
    </div>
  );
}

export function ObjectInspector({ projectId, timeline, apply, playhead, clipStart, setPlayhead }: { projectId: string; timeline: Timeline; apply: Apply; playhead: number; clipStart: number; setPlayhead: (t: number) => void }) {
  const { sel, tracking, set } = useObjectUi();
  const actions = useObjectActions(projectId, apply);
  const { clip, obj } = findObject(timeline, sel);
  if (!clip || !obj) return <p className="text-sm text-fog-400">Select an object in the picture.</p>;
  const sp = clip.speed || 1;
  const toTimeline = (src: number) => clipStart + (clip.reverse ? clip.outSec - src : src - clip.inSec) / sp;
  const local = playhead - clipStart;
  const srcNow = clip.freezeSec ? clip.inSec : clip.reverse ? clip.outSec - local * sp : clip.inSec + local * sp;
  const lostList = lostSpans(obj.mask);
  const next = lostList.find((l) => l.start > srcNow + 0.05) ?? lostList[0];
  const len = Math.max(0, obj.endSec - obj.startSec);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="size-4 shrink-0 rounded-full border border-white/40" style={{ background: obj.color ?? '#888' }} />
        <input value={obj.name} maxLength={60} onChange={(e) => updateObject(apply, clip.id, obj.id, (o) => ({ ...o, name: e.target.value || 'Object' }))} aria-label="Object name" className="h-8 min-w-0 flex-1 rounded-lg border hairline bg-transparent px-2 text-sm text-white focus:border-iris-500/60 focus:outline-none" />
        <label className="flex items-center gap-1 text-[11px] text-fog-300" title="Turn this object's effects on or off"><input type="checkbox" checked={obj.enabled} onChange={(e) => updateObject(apply, clip.id, obj.id, (o) => ({ ...o, enabled: e.target.checked }))} className="accent-iris-500" /> On</label>
      </div>
      <div className="rounded-xl bg-white/[0.03] p-2.5 text-xs text-fog-200">{describeEffects(obj.effects)}{!obj.effects.length && <span className="text-fog-500"> — choose below or in the toolbar above the picture.</span>}</div>
      <QuickEffects clip={clip} obj={obj} actions={actions} />

      <section className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-white">Changes these seconds</span>
          <span className="tabular-nums text-fog-300">{obj.scope === 'frame' ? `frame at ${seconds(obj.atSec)}` : `${seconds(obj.startSec)}–${seconds(obj.endSec)} · ${len.toFixed(1)} s`}</span>
        </div>
        <Segmented size="sm" value={obj.scope} onChange={(v) => void actions.setScope(clip, obj, v)} options={OBJECT_SCOPES.map((s) => ({ value: s.key, label: s.key === 'until_lost' ? 'Until gone' : s.label.replace('Whole clip', 'Whole clip').replace('Custom range', 'Custom') }))} />
        <RangeStrip clip={clip} obj={obj} srcNow={playhead >= clipStart ? srcNow : null} onSeek={(src) => setPlayhead(toTimeline(src))} onChange={(a, b) => updateObject(apply, clip.id, obj.id, (o) => ({ ...o, scope: 'range', startSec: Math.round(a * 100) / 100, endSec: Math.round(b * 100) / 100 }))} />
        <p className="text-[11px] text-fog-500">Drag the ends of the purple bar to choose exact seconds. Outside them the clip is untouched.</p>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-white">Follows the object</span>
          {tracking === obj.id ? <span className="flex items-center gap-1 text-fog-300"><Spinner className="size-3" /> tracking…</span> : obj.mask.track ? <span className="text-signal-green">tracked{lostList.length ? ` · ${lostList.length} unsure span${lostList.length === 1 ? '' : 's'}` : ''}</span> : <span className="text-fog-400">not tracked</span>}
        </div>
        <p className="text-[11px] text-fog-400">{obj.mask.track ? 'The outline moves and resizes with the object. Red marks are frames where the tracker was unsure.' : 'The selection stays where you drew it. Track it if the object moves.'}</p>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" disabled={Boolean(tracking)} onClick={() => void actions.track(clip, obj)}><Crosshair /> {obj.mask.track ? 'Track again' : 'Track'}</Button>
          {next && <Button size="sm" variant="ghost" onClick={() => setPlayhead(toTimeline(next.start))}>Go to unsure frame</Button>}
          {obj.mask.track && <Button size="sm" variant="ghost" onClick={() => updateObject(apply, clip.id, obj.id, (o) => ({ ...o, mask: { ...o.mask, track: undefined } }))}>Stop following</Button>}
        </div>
      </section>

      <section className="space-y-1.5 border-t hairline pt-3">
        <div className="text-xs font-medium text-white">With AI <span className="font-normal text-fog-500">· paid, price shown first</span></div>
        <div className="grid grid-cols-2 gap-1.5">
          <Button size="sm" variant="outline" onClick={() => set({ ai: 'remove' })}><EyeOff /> Remove</Button>
          <Button size="sm" variant="outline" onClick={() => set({ ai: 'replace' })}><Scissors /> Replace…</Button>
        </div>
      </section>

      <div className="flex justify-between border-t hairline pt-3">
        <Button size="sm" variant="ghost" onClick={() => set({ selecting: true })}><Plus /> Select another</Button>
        <Button size="sm" variant="danger" onClick={() => actions.remove(clip.id, obj.id)}><Trash2 /> Delete</Button>
      </div>
    </div>
  );
}

function QuickEffects({ clip, obj, actions }: { clip: TimelineClip; obj: ObjectEdit; actions: ReturnType<typeof useObjectActions> }) {
  const recolor = obj.effects.find((e) => e.type === 'recolor') as Extract<ObjectEffect, { type: 'recolor' }> | undefined;
  const adjust = obj.effects.find((e) => e.type === 'adjust') as Extract<ObjectEffect, { type: 'adjust' }> | undefined;
  const spatial = obj.effects.find((e) => e.type === 'blur' || e.type === 'pixelate');
  const setColour = (hex: string | null) => actions.setEffect(clip, obj, hex ? { type: 'recolor', from: recolor?.from ?? obj.color ?? '#808080', to: hex, range: recolor?.range ?? 0.25, softness: 0.5, strength: recolor?.strength ?? 1, keepLightness: true } : null, 'recolor');
  return (
    <section className="space-y-2.5">
      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs"><span className="font-medium text-white">Colour</span>{recolor && <button type="button" className="text-[11px] text-fog-400 hover:text-white" onClick={() => setColour(null)}>Original</button>}</div>
        <div className="flex flex-wrap gap-1.5">
          {PALETTE.map(([name, hex]) => (
            <button key={hex} type="button" title={name} aria-label={`Colour ${name}`} onClick={() => setColour(hex)} className={cn('size-6 rounded-md border-2 transition hover:scale-110', recolor?.to === hex ? 'border-white' : 'border-transparent')} style={{ background: hex }} />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ['exposure', 'Brightness', -1.5, 1.5],
            ['saturation', 'Saturation', -1, 1],
          ] as const
        ).map(([k, label, lo, hi]) => (
          <label key={k} className="text-[11px] text-fog-300">
            {label}
            <input type="range" min={lo} max={hi} step={0.02} value={(adjust?.[k] ?? 0) as number} onChange={(e) => actions.setEffect(clip, obj, { type: 'adjust', exposure: 0, brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, hue: 0, ...(adjust ?? {}), [k]: Number(e.target.value) }, 'adjust')} className="w-full" aria-label={`Object ${label}`} />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-fog-300">
        Hide it:
        <Segmented size="sm" value={spatial?.type ?? 'none'} onChange={(v) => actions.setEffect(clip, obj, v === 'none' ? null : v === 'blur' ? { type: 'blur', amount: 16 } : { type: 'pixelate', size: 28 }, 'spatial')} options={[{ value: 'none', label: 'No' }, { value: 'blur', label: 'Blur' }, { value: 'pixelate', label: 'Pixelate' }]} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ AI on the object (priced, confirmed)

const AI_PROMPTS: Record<NonNullable<ReturnType<typeof useObjectUi.getState>['ai']>, (name: string) => string> = {
  remove: (n) => `Remove the ${n.toLowerCase()} completely and fill the area with the background that would naturally be behind it. Keep everything else exactly the same: people, faces, camera, lighting, colours.`,
  replace: (n) => `Replace the ${n.toLowerCase()} with `,
  fix: (n) => `Fix the ${n.toLowerCase()}: `,
  restyle: (n) => `Restyle the ${n.toLowerCase()} as `,
  relight: (n) => `Relight the ${n.toLowerCase()}: `,
};

export function ObjectAiDialog({ projectId, timeline, apply, onStarted }: { projectId: string; timeline: Timeline; apply: Apply; onStarted?: () => void }) {
  const { ai, sel, set } = useObjectUi();
  const { clip, obj } = findObject(timeline, sel);
  const [instruction, setInstruction] = useState('');
  const [est, setEst] = useState<EditEstimate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<{ shotId: string; versionId?: string } | null>(null);
  const open = Boolean(ai && clip && obj);
  useEffect(() => {
    if (open && obj && ai) setInstruction(AI_PROMPTS[ai](obj.name));
    if (!open) {
      setEst(null);
      setErr(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ai]);
  // The clip must be a shot to be AI-edited (your own footage becomes one on demand, free).
  useEffect(() => {
    if (!open || !clip) return;
    if (clip.shotId) return setShot({ shotId: clip.shotId, versionId: clip.versionId });
    let alive = true;
    void api<{ shotId: string; versionId: string }>(`/api/projects/${projectId}/shots/from-clip`, { body: { assetId: clip.assetId, label: clip.label } })
      .then((r) => {
        if (!alive) return;
        setShot(r);
        apply((t) => ({ ...t, clips: t.clips.map((c) => (c.assetId === clip.assetId && !c.shotId ? { ...c, shotId: r.shotId, versionId: r.versionId } : c)) }));
      })
      .catch((e) => alive && setErr(e instanceof ApiError ? e.message : 'Could not prepare this clip for AI editing'));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clip?.id]);
  const body = useMemo(() => (shot && obj && ai ? { shotId: shot.shotId, versionId: shot.versionId, mode: ai, instruction: instruction.trim().length >= 3 ? instruction.trim() : 'edit this', startSec: obj.scope === 'frame' ? Math.max(0, obj.atSec - 0.5) : obj.startSec, endSec: obj.scope === 'frame' ? obj.atSec + 0.5 : Math.max(obj.endSec, obj.startSec + 0.2), mask: obj.mask, referenceAssetIds: [] } : null), [shot, obj, ai, instruction]);
  useEffect(() => {
    if (!body) return;
    const id = setTimeout(() => {
      api<{ estimate: EditEstimate }>('/api/edits/estimate', { body })
        .then((r) => {
          setEst(r.estimate);
          setErr(null);
        })
        .catch((e) => {
          setEst(null);
          setErr(e instanceof ApiError ? e.message : 'Could not estimate');
        });
    }, 350);
    return () => clearTimeout(id);
  }, [body]);
  if (!open || !clip || !obj || !ai) return null;
  const clipNo = timeline.clips.findIndex((c) => c.id === clip.id) + 1;
  const go = async () => {
    if (!body) return;
    setBusy(true);
    try {
      await api('/api/edits', { body: { ...body, idempotencyKey: newKey() } });
      toast.success('AI preview started. Nothing in your video changes until you compare and accept it.');
      set({ ai: null });
      onStarted?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start the edit');
    } finally {
      setBusy(false);
    }
  };
  const can = Boolean(est && (est.available || est.fixture) && instruction.trim().length >= 6);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && set({ ai: null })}
      title={`${capital(ai)} with AI — ${obj.name}`}
      description="A paid AI model changes only this object, only in these seconds. You compare before anything in your video changes."
      footer={
        <>
          <Button variant="ghost" onClick={() => set({ ai: null })}>Cancel</Button>
          <Button onClick={go} loading={busy} disabled={!can}><Sparkles /> {est && !est.available && est.fixture ? 'Run test (no AI, no charge)' : `Generate preview · ≈ ${est?.credits ?? '…'} credits`}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} maxLength={900} aria-label="What should change" />
        <div className="space-y-1 rounded-xl bg-white/[0.04] p-3 text-xs text-fog-200">
          <div><b className="text-white">What changes:</b> {obj.name} in clip {clipNo}, {est ? `${est.rangeStart.toFixed(1)}–${est.rangeEnd.toFixed(1)} s` : `${obj.startSec.toFixed(1)}–${obj.endSec.toFixed(1)} s`} of the clip.</div>
          <div><b className="text-white">What stays:</b> everything outside the selection and every other clip — exactly as it is.</div>
          {est && <div><b className="text-white">Cost:</b> {est.available ? `≈ ${est.credits} credits (${est.model}, ${est.seconds} s sent)` : est.fixture ? 'test mode — no AI model is called' : 'AI video editing is not configured on this server'}</div>}
          {est?.notes.map((n) => <div key={n} className="text-fog-400">• {n}</div>)}
        </div>
        {!shot && !err && <p className="flex items-center gap-2 text-xs text-fog-400"><Spinner className="size-3" /> Preparing the clip…</p>}
        {err && <p className="text-xs text-signal-amber">{err}</p>}
      </div>
    </Dialog>
  );
}

/** Esc stops selecting / closes the object toolbar; V toggles select mode (the selection tool key in design apps). */
export function useObjectShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || el?.isContentEditable) return;
      const s = useObjectUi.getState();
      if (e.key === 'Escape') {
        if (s.popover) s.set({ popover: null });
        else if (s.sel) s.set({ sel: null });
        else if (s.selecting) s.set({ selecting: false });
      } else if (e.key.toLowerCase() === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey) s.set({ selecting: !s.selecting });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Remove selections that never got an effect when the user moves on (keeps projects tidy). */
export function useCleanEmptyObjects(apply: Apply) {
  const sel = useObjectUi((s) => s.sel);
  const prev = useRef(sel);
  useEffect(() => {
    const was = prev.current;
    prev.current = sel;
    if (!was || (sel && sel.objectId === was.objectId)) return;
    const t = useEditor.getState().timeline;
    const o = t?.clips.find((c) => c.id === was.clipId)?.objects?.find((x) => x.id === was.objectId);
    if (o && !o.effects.length) updateObject(apply, was.clipId, was.objectId, () => null);
  }, [sel, apply]);
}

