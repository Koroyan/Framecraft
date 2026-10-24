'use client';

import { useEffect, useRef, useState } from 'react';
import { Captions, Film, Layers, Mic, Minus, Music2, Plus, Type } from 'lucide-react';
import { timelineDuration, type Timeline } from '@framecraft/shared';
import type { Asset } from '@/lib/api';
import { clipLen, clipStarts } from '@/lib/editor-store';
import { cn, seconds } from '@/lib/utils';

const LANE = 'relative h-9 rounded-md bg-white/[0.025]';

/**
 * Multi-track timeline: ruler, playhead, and one lane each for video, voices, music/sound, text and
 * subtitles — every item at its real time. Click anywhere to seek; drag video clips to reorder.
 */
export function MultiTrack({
  timeline,
  assets,
  playhead,
  selected,
  onSeek,
  onSelectClip,
  onMoveClip,
}: {
  timeline: Timeline;
  assets: Map<string, Asset>;
  playhead: number;
  selected: string | null;
  onSeek: (t: number) => void;
  onSelectClip: (id: string, start: number) => void;
  onMoveClip: (fromId: string, toIndex: number) => void;
}) {
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

  const seekFrom = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(Math.min(total, Math.max(0, (e.clientX - r.left) / scale)));
  };
  const step = total > 120 ? 10 : total > 40 ? 5 : total > 15 ? 2 : 1;
  const voices = timeline.audio.filter((a) => a.kind === 'voice');
  const beds = timeline.audio.filter((a) => a.kind !== 'voice');

  const lanes: { key: string; icon: React.ReactNode; label: string }[] = [
    { key: 'overlay', icon: <Layers className="size-3.5" />, label: 'Overlay V2' },
    { key: 'video', icon: <Film className="size-3.5" />, label: 'Video V1' },
    { key: 'voice', icon: <Mic className="size-3.5" />, label: 'Voices' },
    { key: 'music', icon: <Music2 className="size-3.5" />, label: 'Music & sound' },
    { key: 'text', icon: <Type className="size-3.5" />, label: 'Text' },
    { key: 'subs', icon: <Captions className="size-3.5" />, label: 'Subtitles' },
  ];

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-1 text-xs text-fog-400">
        <button type="button" aria-label="Zoom out" onClick={() => setPps(Math.max(4, scale / 1.6))} className="grid size-7 place-items-center rounded-md hover:bg-white/[0.06] hover:text-white">
          <Minus className="size-3.5" />
        </button>
        <button type="button" onClick={() => setPps(null)} className={cn('rounded-md px-2 py-1 hover:bg-white/[0.06] hover:text-white', pps === null && 'text-white')}>
          Fit
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => setPps(Math.min(400, scale * 1.6))} className="grid size-7 place-items-center rounded-md hover:bg-white/[0.06] hover:text-white">
          <Plus className="size-3.5" />
        </button>
      </div>
      <div className="flex gap-2">
        <div className="w-24 shrink-0 space-y-1.5 pt-6 max-sm:hidden">
          {lanes.map((l) => (
            <div key={l.key} className="flex h-9 items-center gap-1.5 text-[11px] text-fog-400">
              {l.icon} {l.label}
            </div>
          ))}
        </div>
        <div ref={box} className="min-w-0 flex-1 overflow-x-auto pb-2">
          <div className="relative" style={{ width }}>
            {/* Ruler */}
            <div className="relative h-5 cursor-pointer select-none border-b hairline text-[10px] text-fog-400" onClick={seekFrom}>
              {Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step).map((t) => (
                <span key={t} className="absolute top-0 border-l border-white/10 pl-1" style={{ left: x(t) }}>
                  {seconds(t)}
                </span>
              ))}
            </div>
            <div className="mt-1 space-y-1.5" onClick={seekFrom}>
              {/* Overlay track (V2) */}
              <div className={LANE}>
                {timeline.overlays.map((o) => (
                  <span key={o.id} className="absolute inset-y-1 truncate rounded bg-signal-blue/25 px-1.5 text-[9px] leading-7 text-signal-blue" style={{ left: x(o.startSec), width: Math.max(3, x(o.endSec - o.startSec)) }}>
                    {assets.get(o.assetId)?.originalName ?? 'overlay'}
                  </span>
                ))}
              </div>
              {/* Video */}
              <div className={LANE}>
                {timeline.clips.map((c, i) => {
                  const a = assets.get(c.assetId);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', c.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        onMoveClip(e.dataTransfer.getData('text/plain'), i);
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectClip(c.id, (starts[i] ?? 0) + 0.01);
                      }}
                      title={c.label ?? `Clip ${i + 1}`}
                      aria-label={`Clip ${i + 1}${c.label ? ` · ${c.label}` : ''}`}
                      className={cn('absolute inset-y-0 overflow-hidden rounded-md border text-left', selected === c.id ? 'z-10 border-iris-400 ring-2 ring-iris-500/40' : 'border-white/10 hover:border-white/30')}
                      style={{ left: x(starts[i] ?? 0), width: Math.max(6, x(clipLen(c)) - 2) }}
                    >
                      {a?.thumbnailUrl && <img src={a.thumbnailUrl} alt="" className="absolute inset-0 size-full object-cover opacity-80" />}
                      <span className="absolute bottom-0.5 left-1 rounded bg-black/60 px-1 text-[9px] text-white">{i + 1}{c.freezeSec ? ' ❄' : c.speed !== 1 ? ` ${c.speed}×` : ''}{c.reverse ? ' ⟲' : ''}{c.camera ? ' 🎥' : ''}{c.adjust ? ' ◐' : ''}</span>
                    </button>
                  );
                })}
              </div>
              {/* Voices */}
              <div className={LANE}>
                {voices.map((a) => (
                  <span key={a.id} className={cn('absolute inset-y-1 rounded bg-iris-500/35 px-1 text-[9px] leading-7 text-iris-100', a.muted && 'opacity-30')} style={{ left: x(a.startSec), width: Math.max(3, x(a.outSec - a.inSec)) }} />
                ))}
              </div>
              {/* Music & sound */}
              <div className={LANE}>
                {beds.map((a) => (
                  <span key={a.id} className={cn('absolute inset-y-1 truncate rounded px-1.5 text-[9px] leading-7', a.kind === 'music' ? 'bg-signal-green/25 text-signal-green' : 'bg-signal-blue/25 text-signal-blue', a.muted && 'opacity-30 line-through')} style={{ left: x(a.startSec), width: Math.max(3, x(a.outSec - a.inSec)) }}>
                    {a.kind === 'music' ? 'music' : 'sound'}
                  </span>
                ))}
              </div>
              {/* Text */}
              <div className={LANE}>
                {timeline.texts.map((t) => (
                  <span key={t.id} className="absolute inset-y-1 truncate rounded bg-signal-amber/25 px-1.5 text-[9px] leading-7 text-signal-amber" style={{ left: x(t.startSec), width: Math.max(3, x(t.endSec - t.startSec)) }}>
                    {t.text}
                  </span>
                ))}
              </div>
              {/* Subtitles */}
              <div className={LANE}>
                {timeline.subtitles.map((s) => (
                  <span key={s.id} title={s.text} className="absolute inset-y-1 truncate rounded bg-white/10 px-1 text-[9px] leading-7 text-fog-200" style={{ left: x(s.startSec), width: Math.max(3, x(s.endSec - s.startSec)) }}>
                    {s.text}
                  </span>
                ))}
              </div>
            </div>
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
