'use client';

import { useState } from 'react';
import { Crosshair, GripVertical, Loader2, Play, Plus, Sparkles, Trash2 } from 'lucide-react';
import { clipDuration, moveNodeAfter, removeNode, sequenceOf, type Timeline } from '@framecraft/shared';
import type { Asset } from '@/lib/api';
import type { StudioData } from '@/lib/studio';
import { cn, seconds } from '@/lib/utils';

/*
 * Simple storyboard: the video as a row of shot cards in playback order — the same timeline the
 * editor plays, so it can never disagree with it. Drag to reorder; remove takes a shot out of the
 * video without deleting its media or versions.
 */

export function Storyboard({ timeline, assets, studio, apply, selectedClipId, onPlay, onOpenShot, onAdd }: { timeline: Timeline; assets: Map<string, Asset>; studio?: StudioData; apply: (fn: (t: Timeline) => Timeline) => void; selectedClipId: string | null; playhead: number; onPlay: (clipId: string) => void; onOpenShot: (clipId: string) => void; onAdd: () => void }) {
  const seq = sequenceOf(timeline);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  return (
    <div className="h-full overflow-y-auto p-3">
      <ol className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3" aria-label="Shots in playback order">
        {seq.map((n, i) => {
          const clips = timeline.clips.filter((c) => n.clipIds.includes(c.id));
          const first = clips[0]!;
          const shot = studio?.shots.find((s) => s.id === n.shotId);
          const thumb = (shot?.versions.find((v) => v.id === shot.activeVersionId)?.media?.thumbnailUrl ?? assets.get(first.assetId)?.thumbnailUrl) || undefined;
          const len = clips.reduce((s, c) => s + clipDuration(c), 0);
          const pending = shot?.operations.filter((o) => o.status === 'ready').length ?? 0;
          const running = shot?.operations.some((o) => o.status === 'processing' || o.status === 'queued') || shot?.status === 'generating' || shot?.status === 'queued';
          const selected = n.clipIds.includes(selectedClipId ?? '');
          return (
            <li
              key={n.key}
              draggable
              onDragStart={(e) => {
                setDrag(n.key);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!drag || drag === n.key) return;
                e.preventDefault();
                setOver(n.key);
              }}
              onDragLeave={() => setOver((o) => (o === n.key ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (drag && drag !== n.key) {
                  const from = seq.findIndex((x) => x.key === drag);
                  // Dropping on a later card puts the shot after it; on an earlier card, before it.
                  const after = from < i ? n.key : (seq[i - 1]?.key ?? null);
                  apply((t) => moveNodeAfter(t, drag, after));
                }
                setDrag(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDrag(null);
                setOver(null);
              }}
              className={cn('group relative overflow-hidden rounded-xl border bg-ink-900/70 transition', selected ? 'border-iris-400' : 'hairline hover:border-white/25', over === n.key && 'ring-2 ring-iris-400', drag === n.key && 'opacity-40')}
            >
              <button type="button" onClick={() => onPlay(first.id)} className="block w-full text-left" title="Play from this shot">
                <div className="relative aspect-video bg-black">
                  {thumb ? <img src={thumb} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-xs text-fog-500">No preview</div>}
                  <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">{String(i + 1).padStart(2, '0')}</span>
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">{seconds(len)}</span>
                  <span className="absolute inset-0 grid place-items-center opacity-0 transition group-hover:opacity-100"><Play className="size-7 rounded-full bg-black/60 p-1.5 text-white" /></span>
                  {running && <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-iris-500/90 px-1.5 py-0.5 text-[10px] text-white"><Loader2 className="size-3 animate-spin" /> working</span>}
                  {pending > 0 && <span className="absolute right-1.5 top-1.5 rounded bg-signal-amber px-1.5 py-0.5 text-[10px] font-semibold text-black">review {pending}</span>}
                </div>
                <div className="px-2.5 pb-1 pt-2">
                  <div className="line-clamp-2 text-xs text-fog-100">{shot?.description || first.label || assets.get(first.assetId)?.originalName || `Shot ${i + 1}`}</div>
                  {shot && shot.versions.length > 1 && <div className="mt-0.5 text-[10px] text-fog-500">{shot.versions.length} versions</div>}
                </div>
              </button>
              <div className="flex items-center justify-between px-1.5 pb-1.5">
                <span className="cursor-grab p-1 text-fog-500" title="Drag to reorder" aria-hidden><GripVertical className="size-3.5" /></span>
                <span className="flex items-center gap-0.5">
                  <button type="button" onClick={() => onOpenShot(first.id)} title="Open this shot (versions, AI fixes, camera, colour)" className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fog-300 hover:bg-white/[0.06] hover:text-white"><Crosshair className="size-3" /> Open</button>
                  {shot && <button type="button" onClick={() => onOpenShot(first.id)} title="Edit part of this shot with AI" className="grid size-6 place-items-center rounded-md text-fog-400 hover:bg-white/[0.06] hover:text-white"><Sparkles className="size-3" /></button>}
                  <button type="button" disabled={seq.length < 2} onClick={() => apply((t) => removeNode(t, n.key))} title="Take out of the video (media and versions are kept)" aria-label="Remove shot from video" className="grid size-6 place-items-center rounded-md text-fog-400 hover:bg-white/[0.06] hover:text-signal-red disabled:opacity-30"><Trash2 className="size-3" /></button>
                </span>
              </div>
            </li>
          );
        })}
        <li>
          <button type="button" onClick={onAdd} className="grid aspect-video w-full place-items-center rounded-xl border border-dashed hairline text-xs text-fog-400 hover:border-white/30 hover:text-white">
            <span className="flex flex-col items-center gap-1"><Plus className="size-5" /> Add a shot</span>
          </button>
        </li>
      </ol>
    </div>
  );
}
