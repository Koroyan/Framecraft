'use client';

import { useEffect, useRef, useState } from 'react';
import { gradeCss } from '@/lib/looks';
import { api } from '@/lib/api';
import { Blend, Captions, Film, Layers, Mic, Minus, Music2, Plus, Type } from 'lucide-react';
import { lostSpans, timelineDuration, type Timeline } from '@framecraft/shared';
import type { Asset } from '@/lib/api';
import { clipLen, clipStarts } from '@/lib/editor-store';
import { transitionLabel } from '@/lib/transitions';
import { cn, seconds } from '@/lib/utils';

const LANE = 'relative h-9 rounded-md bg-white/[0.025]';
const SNAP_PX = 7;

// Waveform / filmstrip images are rendered once per file on the server (free) and cached.
const derivedCache = new Map<string, Promise<string | null>>();
function useDerived(kind: 'waveform' | 'filmstrip', assetId: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!assetId) return;
    const key = `${kind}:${assetId}`;
    if (!derivedCache.has(key)) derivedCache.set(key, api<{ url: string }>(`/api/assets/${assetId}/${kind}`).then((r) => r.url).catch(() => null));
    let alive = true;
    void derivedCache.get(key)!.then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [kind, assetId]);
  return url;
}

function Wave({ assetId, className, style }: { assetId: string; className: string; style: React.CSSProperties }) {
  const url = useDerived('waveform', assetId);
  return <span className={className} style={{ ...style, backgroundImage: url ? `url(${url})` : undefined, backgroundSize: '100% 100%' }} />;
}
function Strip({ assetId, filter }: { assetId: string; filter?: string }) {
  const url = useDerived('filmstrip', assetId);
  return url ? <span className="absolute inset-0 opacity-80" style={{ backgroundImage: `url(${url})`, backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x', filter }} /> : null;
}

type Range = { start: number; end: number };

/**
 * Multi-track timeline: ruler (click or drag to scrub; Shift-drag marks a range), playhead, and lanes
 * for layers, video, voices, music/sound and captions. Clips: click selects, drag reorders, drag an
 * edge to trim (the next clips close up). Layers and audio move in time; everything snaps to the
 * playhead and clip boundaries.
 */
export function MultiTrack({
  timeline,
  assets,
  playhead,
  selected,
  onSeek,
  onSelectClip,
  selectedExtra = [],
  onMoveClip,
  selectedLayer,
  onSelectLayer,
  onLayerTiming,
  onTrimClip,
  range,
  onRange,
  selectedAudio,
  onSelectAudio,
  onAudioTiming,
  title,
  actions,
}: {
  /** Shown at the start / end of the timeline's single header row (saves a row of height). */
  title?: React.ReactNode;
  actions?: React.ReactNode;
  timeline: Timeline;
  assets: Map<string, Asset>;
  playhead: number;
  selected: string | null;
  onSeek: (t: number) => void;
  /** additive = Shift/Ctrl/Cmd-click (add to / remove from the multi-selection). */
  onSelectClip: (id: string, start: number, additive?: boolean) => void;
  selectedExtra?: string[];
  onMoveClip: (fromId: string, toIndex: number) => void;
  selectedLayer?: string | null;
  onSelectLayer?: (id: string) => void;
  onLayerTiming?: (id: string, startSec: number, endSec: number) => void;
  onTrimClip?: (id: string, inSec: number, outSec: number) => void;
  range?: Range | null;
  onRange?: (r: Range | null) => void;
  selectedAudio?: string | null;
  onSelectAudio?: (id: string) => void;
  onAudioTiming?: (id: string, startSec: number) => void;
}) {
  const layerDrag = useRef<{ id: string; mode: 'move' | 'start' | 'end'; x0: number; s: number; e: number } | null>(null);
  const clipDrag = useRef<{ id: string; side: 'start' | 'end'; x0: number; inSec: number; outSec: number; freeze?: number } | null>(null);
  const audioDrag = useRef<{ id: string; x0: number; s: number; moved: boolean } | null>(null);
  const rulerDrag = useRef<{ mode: 'seek' | 'range' | 'start' | 'end'; from: number } | null>(null);
  const layerTracks = [...new Set(timeline.layers.map((l) => l.track))].sort((a, b) => b - a);
  const locked = new Set(timeline.tracks.filter((t) => t.locked).map((t) => t.index));
  const hiddenT = new Set(timeline.tracks.filter((t) => t.hidden).map((t) => t.index));
  const total = Math.max(0.1, timelineDuration(timeline));
  const box = useRef<HTMLDivElement>(null);
  const [pps, setPps] = useState<number | null>(null); // pixels per second; null = fit to width
  const [fit, setFit] = useState(40);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFit(Math.max(4, (el.clientWidth - 8) / total)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [total]);
  const scale = pps ?? fit;
  const width = Math.max(total * scale, 0);
  const x = (t: number) => t * scale;
  const starts = clipStarts(timeline);
  // Snap targets: playhead and every clip boundary.
  const targets = [playhead, 0, total, ...starts, ...timeline.clips.map((c, i) => (starts[i] ?? 0) + clipLen(c))];
  const snap = (t: number) => {
    let best = t;
    let d = SNAP_PX / scale;
    for (const s of targets) {
      if (Math.abs(s - t) >= d) continue;
      d = Math.abs(s - t);
      best = s;
    }
    return best;
  };
  const timeAt = (clientX: number) => {
    const r = box.current!.querySelector('[data-ruler]')!.getBoundingClientRect();
    return Math.min(total, Math.max(0, (clientX - r.left) / scale));
  };

  const step = total > 120 ? 10 : total > 40 ? 5 : total > 15 ? 2 : 1;
  const voices = timeline.audio.filter((a) => a.kind === 'voice');
  const beds = timeline.audio.filter((a) => a.kind !== 'voice');

  const lanes: { key: string; icon: React.ReactNode; label: string; show: boolean }[] = [
    ...layerTracks.map((tr) => ({ key: `layer-${tr}`, icon: <Layers className="size-3.5" />, label: `Layers ${tr}${locked.has(tr) ? ' 🔒' : ''}${hiddenT.has(tr) ? ' (hidden)' : ''}`, show: true })),
    { key: 'overlay', icon: <Layers className="size-3.5" />, label: 'Overlays', show: timeline.overlays.length > 0 },
    { key: 'video', icon: <Film className="size-3.5" />, label: 'Video', show: true },
    { key: 'voice', icon: <Mic className="size-3.5" />, label: 'Voice', show: voices.length > 0 },
    { key: 'music', icon: <Music2 className="size-3.5" />, label: 'Music & sound', show: true },
    { key: 'text', icon: <Type className="size-3.5" />, label: 'Old titles', show: timeline.texts.length > 0 },
    { key: 'subs', icon: <Captions className="size-3.5" />, label: 'Subtitles', show: timeline.subtitles.length > 0 },
  ];
  const show = (k: string) => lanes.find((l) => l.key === k)?.show ?? true;

  return (
    <div>
      <div className="mb-1 flex min-h-8 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-fog-400">
        <span className="flex min-w-0 items-center gap-2">
          {title}
          <span tabIndex={0} title="Shift + drag on the ruler (or I / O) marks a range · drag clip edges to trim · Shift-click selects several clips" className="grid size-4 shrink-0 cursor-help place-items-center rounded-full border border-white/15 text-[9px] text-fog-500">?</span>
          <span className="truncate text-[11px] text-fog-500 max-2xl:hidden">Shift-drag the ruler marks a range · drag clip edges to trim · Shift-click selects several</span>
        </span>
        <span className="flex items-center gap-1">
        <span className="flex items-center gap-0.5">
          <button type="button" aria-label="Zoom out" onClick={() => setPps(Math.max(4, scale / 1.6))} className="grid size-6 place-items-center rounded-md hover:bg-white/[0.06] hover:text-white"><Minus className="size-3.5" /></button>
          <button type="button" onClick={() => setPps(null)} className={cn('rounded-md px-1.5 py-0.5 hover:bg-white/[0.06] hover:text-white', pps === null && 'text-white')}>Fit</button>
          <button type="button" aria-label="Zoom in" onClick={() => setPps(Math.min(400, scale * 1.6))} className="grid size-6 place-items-center rounded-md hover:bg-white/[0.06] hover:text-white"><Plus className="size-3.5" /></button>
        </span>
        {actions}
        </span>
      </div>
      <div className="flex gap-2">
        <div className="w-24 shrink-0 space-y-1.5 pt-6 max-sm:hidden">
          {lanes.filter((l) => l.show).map((l) => (
            <div key={l.key} className="flex h-9 items-center gap-1.5 truncate text-[11px] text-fog-400">
              {l.icon} {l.label}
            </div>
          ))}
        </div>
        <div ref={box} className="min-w-0 flex-1 overflow-x-auto pb-2">
          <div className="relative" style={{ width }}>
            {/* Ruler: click/drag scrubs, Shift-drag marks a range; range ends are draggable. */}
            <div
              data-ruler
              data-testid="timeline-ruler"
              className="relative h-5 cursor-pointer touch-none select-none border-b hairline text-[10px] text-fog-400"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const t = snap(timeAt(e.clientX));
                if (e.shiftKey && onRange) {
                  rulerDrag.current = { mode: 'range', from: t };
                  onRange({ start: t, end: Math.min(total, t + 0.1) });
                } else {
                  rulerDrag.current = { mode: 'seek', from: t };
                  onSeek(t);
                }
              }}
              onPointerMove={(e) => {
                const d = rulerDrag.current;
                if (!d) return;
                const t = snap(timeAt(e.clientX));
                if (d.mode === 'seek') onSeek(t);
                else if (d.mode === 'range') onRange?.({ start: Math.min(d.from, t), end: Math.max(d.from, t, Math.min(d.from, t) + 0.05) });
                else if (d.mode === 'start' && range) onRange?.({ start: Math.min(t, range.end - 0.05), end: range.end });
                else if (d.mode === 'end' && range) onRange?.({ start: range.start, end: Math.max(t, range.start + 0.05) });
              }}
              onPointerUp={() => (rulerDrag.current = null)}
            >
              {Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step).map((t) => (
                <span key={t} className="pointer-events-none absolute top-0 border-l border-white/10 pl-1" style={{ left: x(t) }}>{seconds(t)}</span>
              ))}
              {range && (
                <span className="absolute inset-y-0 bg-iris-500/40" style={{ left: x(range.start), width: Math.max(2, x(range.end - range.start)) }}>
                  {(['start', 'end'] as const).map((side) => (
                    <span
                      key={side}
                      role="slider"
                      aria-label={side === 'start' ? 'Range start' : 'Range end'}
                      aria-valuenow={side === 'start' ? range.start : range.end}
                      tabIndex={0}
                      className={cn('absolute inset-y-0 w-2 cursor-ew-resize bg-iris-300', side === 'start' ? '-left-1 rounded-l' : '-right-1 rounded-r')}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        (e.currentTarget.closest('[data-ruler]') as HTMLElement).setPointerCapture(e.pointerId);
                        rulerDrag.current = { mode: side, from: 0 };
                      }}
                    />
                  ))}
                </span>
              )}
            </div>
            <div className="mt-1 space-y-1.5" onClick={(e) => onSeek(snap(timeAt(e.clientX)))}>
              {/* Layer tracks: drag a bar to move it in time, drag its edges to trim. */}
              {layerTracks.map((tr) => (
                <div key={tr} className={cn(LANE, hiddenT.has(tr) && 'opacity-40')}>
                  {timeline.layers.filter((l) => l.track === tr).map((l) => {
                    const lock = locked.has(tr);
                    const down = (mode: 'move' | 'start' | 'end') => (e: React.PointerEvent) => {
                      e.stopPropagation();
                      onSelectLayer?.(l.id);
                      if (lock) return;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      layerDrag.current = { id: l.id, mode, x0: e.clientX, s: l.startSec, e: l.endSec };
                    };
                    const moveL = (e: React.PointerEvent) => {
                      const d = layerDrag.current;
                      if (!d || d.id !== l.id) return;
                      const dt = (e.clientX - d.x0) / scale;
                      const r = (v: number) => Math.round(v * 100) / 100;
                      if (d.mode === 'move') {
                        const s = snap(Math.max(0, d.s + dt));
                        onLayerTiming?.(l.id, r(s), r(s + (d.e - d.s)));
                      } else if (d.mode === 'start') onLayerTiming?.(l.id, r(Math.min(d.e - 0.1, snap(Math.max(0, d.s + dt)))), d.e);
                      else onLayerTiming?.(l.id, d.s, r(Math.max(d.s + 0.1, snap(d.e + dt))));
                    };
                    return (
                      <span
                        key={l.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`Layer ${l.name ?? l.kind}`}
                        onClick={(e) => {
                          // Like a clip: the playhead goes where you clicked (inside the layer), so it shows.
                          e.stopPropagation();
                          onSeek(Math.min(l.endSec - 0.01, Math.max(l.startSec, timeAt(e.clientX))));
                        }}
                        className={cn('absolute inset-y-1 cursor-grab truncate rounded px-2 text-[9px] leading-7', l.kind === 'text' ? 'bg-signal-amber/25 text-signal-amber' : l.kind === 'shape' ? 'bg-pink-500/25 text-pink-200' : 'bg-signal-blue/25 text-signal-blue', selectedLayer === l.id && 'ring-1 ring-white')}
                        style={{ left: x(l.startSec), width: Math.max(6, x(l.endSec - l.startSec)) }}
                        onPointerDown={down('move')}
                        onPointerMove={moveL}
                        onPointerUp={() => (layerDrag.current = null)}
                      >
                        <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/20" onPointerDown={down('start')} onPointerMove={moveL} onPointerUp={() => (layerDrag.current = null)} />
                        {l.text?.content ?? l.shape?.label ?? l.name ?? l.kind}
                        <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/20" onPointerDown={down('end')} onPointerMove={moveL} onPointerUp={() => (layerDrag.current = null)} />
                      </span>
                    );
                  })}
                </div>
              ))}
              {show('overlay') && (
                <div className={LANE}>
                  {timeline.overlays.map((o) => (
                    <span key={o.id} className="absolute inset-y-1 truncate rounded bg-signal-blue/25 px-1.5 text-[9px] leading-7 text-signal-blue" style={{ left: x(o.startSec), width: Math.max(3, x(o.endSec - o.startSec)) }}>
                      {assets.get(o.assetId)?.originalName ?? 'overlay'}
                    </span>
                  ))}
                </div>
              )}
              {/* Video */}
              <div className={LANE} data-testid="video-lane">
                {timeline.clips.map((c, i) => {
                  const a = assets.get(c.assetId);
                  const len = clipLen(c);
                  const sp = c.speed || 1;
                  const maxSrc = a?.durationMs ? a.durationMs / 1000 : Math.max(c.outSec, c.inSec + 0.2);
                  const edge = (side: 'start' | 'end') => (e: React.PointerEvent) => {
                    e.stopPropagation();
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    clipDrag.current = { id: c.id, side, x0: e.clientX, inSec: c.inSec, outSec: c.outSec, freeze: c.freezeSec };
                  };
                  const edgeMove = (e: React.PointerEvent) => {
                    const d = clipDrag.current;
                    if (!d || d.id !== c.id || !onTrimClip) return;
                    const dt = (e.clientX - d.x0) / scale;
                    const r2 = (v: number) => Math.round(v * 1000) / 1000;
                    if (d.freeze) return; // freeze frames: length in the inspector
                    // A head trim moves the source in-point (out-point when reversed); a tail trim the other one.
                    const head = d.side === 'start';
                    const rev = c.reverse;
                    let inSec = d.inSec;
                    let outSec = d.outSec;
                    if (head !== rev) inSec = Math.min(d.outSec - 0.2, Math.max(0, d.inSec + (head ? dt : -dt) * sp));
                    else outSec = Math.max(d.inSec + 0.2, Math.min(maxSrc, d.outSec + (head ? -dt : dt) * sp));
                    onTrimClip(c.id, r2(inSec), r2(outSec));
                  };
                  const lost = (c.objects ?? []).flatMap((o) => lostSpans(o.mask)).map((l) => ({ a: (c.reverse ? c.outSec - l.end : l.start - c.inSec) / sp, b: (c.reverse ? c.outSec - l.start : l.end - c.inSec) / sp })).filter((l) => l.b > 0 && l.a < len);
                  return (
                    <div
                      key={c.id}
                      role="button"
                      tabIndex={0}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', c.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        onMoveClip(e.dataTransfer.getData('text/plain'), i);
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        // Select the clip and put the playhead where it was clicked (so S splits there).
                        const r = e.currentTarget.getBoundingClientRect();
                        const within = Math.max(0, Math.min(len - 0.01, ((e.clientX - r.left) / Math.max(1, r.width)) * len));
                        onSelectClip(c.id, (starts[i] ?? 0) + Math.max(0.01, within), e.shiftKey || e.ctrlKey || e.metaKey);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onSelectClip(c.id, (starts[i] ?? 0) + 0.01);
                      }}
                      title={c.label ?? `Clip ${i + 1}`}
                      aria-label={`Clip ${i + 1}${c.label ? ` · ${c.label}` : ''}`}
                      aria-selected={selected === c.id || selectedExtra.includes(c.id)}
                      className={cn('group absolute inset-y-0 cursor-pointer overflow-hidden rounded-md border text-left', selected === c.id ? 'z-10 border-iris-400 ring-2 ring-iris-500/40' : selectedExtra.includes(c.id) ? 'z-10 border-iris-300 ring-2 ring-iris-300/50' : 'border-white/10 hover:border-white/30')}
                      style={{ left: x(starts[i] ?? 0), width: Math.max(6, x(len) - 2) }}
                    >
                      {a?.mediaType === 'video' ? <Strip assetId={c.assetId} filter={gradeCss(c.adjust as Record<string, unknown> | undefined)} /> : a?.thumbnailUrl && <img src={a.thumbnailUrl} alt="" className="absolute inset-0 size-full object-cover opacity-80" style={{ filter: gradeCss(c.adjust as Record<string, unknown> | undefined) }} />}
                      <span className="pointer-events-none absolute bottom-0.5 left-2 rounded bg-black/60 px-1 text-[9px] text-white">{i + 1}{c.freezeSec ? ' ❄' : c.speed !== 1 ? ` ${c.speed}×` : ''}{c.reverse ? ' ⟲' : ''}{c.camera ? ' 🎥' : ''}{c.adjust ? ' ◐' : ''}{c.objects?.length ? ` ◎${c.objects.length}` : ''}</span>
                      {lost.map((l, k) => <span key={k} title="Object tracking unsure here" className="pointer-events-none absolute top-0 h-1 rounded bg-signal-red" style={{ left: x(Math.max(0, l.a)), width: Math.max(2, x(Math.min(len, l.b) - Math.max(0, l.a))) }} />)}
                      {onTrimClip && !c.freezeSec && (
                        <>
                          <span role="slider" aria-label={`Trim the start of clip ${i + 1}`} aria-valuenow={c.inSec} tabIndex={-1} onPointerDown={edge('start')} onPointerMove={edgeMove} onPointerUp={() => (clipDrag.current = null)} onClick={(e) => e.stopPropagation()} className={cn('absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize bg-white/0 transition group-hover:bg-white/50', selected === c.id && 'bg-iris-300')} />
                          <span role="slider" aria-label={`Trim the end of clip ${i + 1}`} aria-valuenow={c.outSec} tabIndex={-1} onPointerDown={edge('end')} onPointerMove={edgeMove} onPointerUp={() => (clipDrag.current = null)} onClick={(e) => e.stopPropagation()} className={cn('absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-white/0 transition group-hover:bg-white/50', selected === c.id && 'bg-iris-300')} />
                        </>
                      )}
                    </div>
                  );
                })}
                {/* Transitions: a marker on each blend; clicking it opens that clip's transition setting. */}
                {timeline.clips.map((c, i) => {
                  const tr = c.transition;
                  const next = starts[i + 1];
                  if (!tr || next === undefined) return null;
                  const name = transitionLabel(tr.type);
                  return (
                    <button
                      key={`tr-${c.id}`}
                      type="button"
                      title={`${name} · ${tr.durationSec}s — click to change`}
                      aria-label={`Transition after clip ${i + 1}: ${name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectClip(c.id, next + tr.durationSec / 2, false);
                        // Bring the setting into view once the inspector shows this clip.
                        setTimeout(() => {
                          const field = document.querySelector<HTMLSelectElement>('select[aria-label="Transition"]');
                          field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                          field?.focus({ preventScroll: true });
                        }, 80);
                      }}
                      className="absolute top-1/2 z-20 grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-md border border-white/30 bg-ink-900/90 text-white shadow hover:border-iris-300 hover:text-iris-200"
                      style={{ left: x(next + tr.durationSec / 2) }}
                    >
                      <Blend className="size-3" />
                    </button>
                  );
                })}
              </div>
              {/* Voices */}
              {show('voice') && (
                <div className={LANE}>
                  {voices.map((a) => (
                    <AudioBar key={a.id} a={a} x={x} scale={scale} snap={snap} selected={selectedAudio === a.id} onSelect={onSelectAudio} onMove={onAudioTiming} drag={audioDrag} className="bg-iris-500/35">
                      <Wave assetId={a.assetId} className="absolute inset-0" style={{}} />
                    </AudioBar>
                  ))}
                </div>
              )}
              {/* Music & sound */}
              <div className={LANE}>
                {beds.map((a) => (
                  <AudioBar key={a.id} a={a} x={x} scale={scale} snap={snap} selected={selectedAudio === a.id} onSelect={onSelectAudio} onMove={onAudioTiming} drag={audioDrag} className={a.kind === 'music' ? 'bg-signal-green/25 text-signal-green' : 'bg-signal-blue/25 text-signal-blue'}>
                    <Wave assetId={a.assetId} className="absolute inset-0 opacity-50" style={{}} />
                    <span className="relative px-1.5 text-[9px] leading-7">{a.kind === 'music' ? 'music' : 'sound'}</span>
                  </AudioBar>
                ))}
                {!beds.length && <span className="pointer-events-none absolute inset-0 flex items-center px-2 text-[10px] text-fog-500">Add music from Audio (left)</span>}
              </div>
              {show('text') && (
                <div className={LANE}>
                  {timeline.texts.map((t) => (
                    <span key={t.id} className="absolute inset-y-1 truncate rounded bg-signal-amber/25 px-1.5 text-[9px] leading-7 text-signal-amber" style={{ left: x(t.startSec), width: Math.max(3, x(t.endSec - t.startSec)) }}>{t.text}</span>
                  ))}
                </div>
              )}
              {show('subs') && (
                <div className={LANE}>
                  {timeline.subtitles.map((s) => (
                    <span key={s.id} title={s.text} className="absolute inset-y-1 truncate rounded bg-white/10 px-1 text-[9px] leading-7 text-fog-200" style={{ left: x(s.startSec), width: Math.max(3, x(s.endSec - s.startSec)) }}>{s.text}</span>
                  ))}
                </div>
              )}
            </div>
            {/* Marked range across all lanes */}
            {range && <div className="pointer-events-none absolute bottom-0 top-5 border-x border-iris-300/70 bg-iris-500/10" style={{ left: x(range.start), width: Math.max(2, x(range.end - range.start)) }} />}
            {/* Playhead */}
            <div className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_6px_rgba(255,255,255,0.7)]" style={{ left: x(Math.min(playhead, total)) }}>
              <span className="absolute -left-1 top-0 size-2 rotate-45 bg-white" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AudioBar({ a, x, scale, snap, selected, onSelect, onMove, drag, className, children }: { a: Timeline['audio'][number]; x: (t: number) => number; scale: number; snap: (t: number) => number; selected: boolean; onSelect?: (id: string) => void; onMove?: (id: string, startSec: number) => void; drag: React.MutableRefObject<{ id: string; x0: number; s: number; moved: boolean } | null>; className: string; children: React.ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`${a.kind} audio`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect?.(a.id);
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: a.id, x0: e.clientX, s: a.startSec, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== a.id || !onMove) return;
        if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
        if (d.moved) onMove(a.id, Math.round(snap(Math.max(0, d.s + (e.clientX - d.x0) / scale)) * 100) / 100);
      }}
      onPointerUp={() => (drag.current = null)}
      className={cn('absolute inset-y-1 cursor-grab overflow-hidden truncate rounded', className, a.muted && 'opacity-30', selected && 'ring-1 ring-white')}
      style={{ left: x(a.startSec), width: Math.max(4, x(a.outSec - a.inSec)) }}
    >
      {children}
    </span>
  );
}
