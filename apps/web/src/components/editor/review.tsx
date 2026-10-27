'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Columns2, Pause, Play, SplitSquareHorizontal, X } from 'lucide-react';
import { toast } from 'sonner';
import { swapShotVersion, type Timeline } from '@framecraft/shared';
import { api, ApiError } from '@/lib/api';
import type { EditOperation, StudioShot } from '@/lib/studio';
import { Button, Dialog } from '@/components/ui';
import { cn, seconds } from '@/lib/utils';

type Item = { shot: StudioShot; op: EditOperation };

/**
 * AI results waiting for a decision, right above the editor — compare in place (wipe or side by
 * side, scrubbed together) and accept or reject without leaving the timeline.
 */
export function ReviewBar({ reviewOps, apply, onDone, onImprove }: { timeline: Timeline; reviewOps: Item[]; apply: (fn: (t: Timeline) => Timeline) => void; onDone: () => void; onImprove?: (shotId: string) => void }) {
  const [open, setOpen] = useState<Item | null>(null);
  if (!reviewOps.length) return null;
  const first = reviewOps[0]!;
  return (
    <>
      <div className="flex shrink-0 items-center gap-3 rounded-xl border border-signal-amber/40 bg-signal-amber/[0.07] px-3 py-1.5 text-xs" role="status">
        <span className="font-medium text-signal-amber">{reviewOps.length === 1 ? 'An AI result is ready' : `${reviewOps.length} AI results are ready`}</span>
        <span className="min-w-0 flex-1 truncate text-fog-300">Shot {first.shot.number} · {first.op.mode.replaceAll('_', ' ')} · {seconds(first.op.startSec)}–{seconds(first.op.endSec)} — nothing changes until you accept.</span>
        <Button size="sm" onClick={() => setOpen(first)}>Compare</Button>
      </div>
      {open && <CompareDialog item={open} apply={apply} onClose={() => setOpen(null)} onDone={() => { setOpen(null); onDone(); }} onImprove={onImprove ? () => { onImprove(open.shot.id); setOpen(null); } : undefined} />}
    </>
  );
}

export function CompareDialog({ item, apply, onClose, onDone, onImprove }: { item: Item; apply: (fn: (t: Timeline) => Timeline) => void; onClose: () => void; onDone: () => void; onImprove?: () => void }) {
  const { shot, op } = item;
  const va = shot.versions.find((v) => v.id === op.sourceVersionId);
  const vb = shot.versions.find((v) => v.id === op.resultVersionId);
  const [view, setView] = useState<'wipe' | 'side'>('wipe');
  const [wipe, setWipe] = useState(0.5);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(1);
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const A = useRef<HTMLVideoElement>(null);
  const B = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    for (const v of [A.current, B.current]) {
      if (!v) continue;
      if (playing) void v.play().catch(() => undefined);
      else v.pause();
    }
  }, [playing, view]);
  // Both players follow A (scrubbing moves both).
  const sync = () => {
    if (!A.current || !B.current) return;
    setT(A.current.currentTime);
    if (Math.abs(A.current.currentTime - B.current.currentTime) > 0.06) B.current.currentTime = A.current.currentTime;
  };
  const seek = (v: number) => {
    setPlaying(false);
    setT(v);
    if (A.current) A.current.currentTime = v;
    if (B.current) B.current.currentTime = v;
  };
  const decide = async (accept: boolean) => {
    setBusy(accept ? 'accept' : 'reject');
    try {
      if (accept) {
        const r = await api<{ shotId: string; versionId: string; assetId: string; durationSec: number; previousDurationSec?: number }>(`/api/edits/${op.id}/accept`, { body: {} });
        apply((tl) => swapShotVersion(tl, r.shotId, r));
        toast.success(`V${vb?.number} is now in the video — the original is kept in the shot’s versions`);
      } else {
        await api(`/api/edits/${op.id}/reject`, { body: {} });
        toast.success('Kept the original');
      }
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not update');
    } finally {
      setBusy(null);
    }
  };
  if (!va?.media || !vb?.media) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title={`Shot ${shot.number}: before and after`}
      description={`${op.mode.replaceAll('_', ' ')} · ${seconds(op.startSec)}–${seconds(op.endSec)} · “${op.instruction}”`}
      footer={
        <>
          <Button variant="ghost" loading={busy === 'reject'} onClick={() => decide(false)}><X /> Reject</Button>
          {onImprove && <Button variant="secondary" onClick={onImprove} title="Ask for a refinement — the assistant starts from this result">Improve…</Button>}
          <Button loading={busy === 'accept'} onClick={() => decide(true)}><Check /> Accept</Button>
        </>
      }
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-0.5 rounded-lg border hairline p-0.5 text-[11px]">
            <button type="button" onClick={() => setView('wipe')} className={cn('flex items-center gap-1 rounded-md px-2 py-1', view === 'wipe' ? 'bg-white/10 text-white' : 'text-fog-400')}><SplitSquareHorizontal className="size-3" /> Wipe</button>
            <button type="button" onClick={() => setView('side')} className={cn('flex items-center gap-1 rounded-md px-2 py-1', view === 'side' ? 'bg-white/10 text-white' : 'text-fog-400')}><Columns2 className="size-3" /> Side by side</button>
          </div>
          {vb.media.isFixture && <span className="rounded-full bg-signal-amber px-2 py-0.5 text-[10px] font-semibold text-black">TEST FIXTURE · NOT AI</span>}
        </div>
        {view === 'side' ? (
          <div className="grid grid-cols-2 gap-2">
            {([[A, va, 'Before'], [B, vb, 'After']] as const).map(([ref, v, label], i) => (
              <figure key={label} className="relative overflow-hidden rounded-xl bg-black">
                <video ref={ref} src={v.media!.url} className="w-full" muted={i === 1} playsInline onTimeUpdate={i === 0 ? sync : undefined} onLoadedMetadata={(e) => i === 0 && setDur(e.currentTarget.duration || 1)} />
                <figcaption className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">{label} · V{v.number}</figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <div className="relative overflow-hidden rounded-xl bg-black">
            <video ref={A} src={va.media.url} className="w-full" playsInline onTimeUpdate={sync} onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 1)} />
            <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 0 0 ${wipe * 100}%)` }}>
              <video ref={B} src={vb.media.url} className="w-full" muted playsInline />
            </div>
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white" style={{ left: `${wipe * 100}%` }} />
            <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">Before</span>
            <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">After</span>
            <input type="range" aria-label="Wipe position" min={0} max={1} step={0.005} value={wipe} onChange={(e) => setWipe(Number(e.target.value))} className="absolute inset-x-3 bottom-2" />
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button size="icon" variant="secondary" aria-label={playing ? 'Pause' : 'Play both'} onClick={() => setPlaying((x) => !x)}>{playing ? <Pause /> : <Play />}</Button>
          <input type="range" aria-label="Scrub both" min={0} max={dur} step={0.02} value={Math.min(t, dur)} onChange={(e) => seek(Number(e.target.value))} className="flex-1" />
          <span className="w-20 text-right text-xs tabular-nums text-fog-300">{seconds(t)}</span>
        </div>
        <p className="text-[11px] text-fog-500">The changed seconds are {seconds(op.startSec)}–{seconds(op.endSec)}; everything else should look identical. <b className="text-fog-300">Improve…</b> asks for a refinement that starts from this result (nothing is lost).</p>
      </div>
    </Dialog>
  );
}
