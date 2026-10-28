'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Film, ImageIcon, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { priceOf } from '@/lib/director';
import type { DirectorDeps } from '../director-chat';

type MovieEstimate = {
  shots: { shotId: string; credits: number; ok: boolean; blockers: string[]; modelName: string | null }[];
  totalCredits: number;
  ok: boolean;
  liveAvailable: boolean;
  modelMix: { model: string; shots: number }[];
  dialogue: { credits: number } | null;
  soundtrack: { credits: number } | null;
};

/** Planned shot prices for the graph cards (free to ask; nothing is generated). */
export function usePlannedCredits(deps: DirectorDeps, enabled: boolean) {
  return useQuery({
    queryKey: ['movie-estimate', deps.projectId, deps.studio?.shots.filter((s) => !s.versions.length).map((s) => `${s.id}:${s.durationSec}:${s.camera}`).join()],
    queryFn: () => api<{ estimate: MovieEstimate }>(`/api/movies/${deps.projectId}/estimate`, { body: { onlyMissing: true } }).then((r) => r.estimate),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Make the planned shots: a cheap draft first (storyboard stills — not video), or the final video.
 * Both show their price and start only when approved.
 */
export function GenerateCard({ deps, onClose }: { deps: DirectorDeps; onClose: () => void }) {
  const planned = (deps.studio?.shots ?? []).filter((s) => !s.versions.length && s.status !== 'queued' && s.status !== 'generating');
  const noFrame = planned.filter((s) => !s.storyboardUrl);
  const movie = usePlannedCredits(deps, planned.length > 0);
  const frameOp = { op: 'storyboard.generate' as const, shotIds: noFrame.map((s) => s.id) };
  const frames = useQuery({ queryKey: ['director-price', deps.projectId, JSON.stringify(frameOp)], queryFn: () => priceOf(deps.projectId, frameOp), enabled: noFrame.length > 0, staleTime: 60_000 });
  const [busy, setBusy] = useState<'draft' | 'final' | null>(null);
  const key = Math.random().toString(36).slice(2, 10);

  const draft = async () => {
    const credits = frames.data?.estimate?.credits;
    if (credits === undefined) return;
    setBusy('draft');
    try {
      await api(`/api/projects/${deps.projectId}/director/run`, { body: { op: frameOp, approvedCredits: credits, idempotencyKey: `frames-${key}` } });
      toast.success('Drawing the storyboard frames — the cards update as they arrive.');
      await deps.refetch();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start it');
    } finally {
      setBusy(null);
    }
  };
  const final = async () => {
    const credits = movie.data?.totalCredits;
    if (credits === undefined) return;
    setBusy('final');
    try {
      await api(`/api/movies/${deps.projectId}/generate`, { body: { approvedCredits: credits, idempotencyKey: `film-${key}` } });
      toast.success('Generating — each card shows its progress, and the movie assembles itself at the end.');
      await deps.refetch();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start it');
    } finally {
      setBusy(null);
    }
  };
  const blockers = movie.data?.shots.flatMap((s) => s.blockers) ?? [];
  return (
    <div className="nodrag nowheel w-[min(380px,92vw)] cursor-default rounded-2xl border border-white/15 bg-ink-900/98 p-3 shadow-2xl" role="dialog" aria-label="Make the planned shots" onPointerDown={(e) => e.stopPropagation()}>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-white">Make the {planned.length} planned shot{planned.length === 1 ? '' : 's'}</div>
        <button type="button" aria-label="Close" onClick={onClose} className="grid size-7 place-items-center rounded-lg text-fog-400 hover:bg-white/[0.06] hover:text-white"><X className="size-4" /></button>
      </div>
      <div className="space-y-2">
        {noFrame.length > 0 && (
          <div className="rounded-xl border hairline p-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-white"><ImageIcon className="size-3.5 text-iris-200" /> Draft preview — storyboard frames</div>
            <p className="mt-0.5 text-[11px] text-fog-400">One still image per shot ({noFrame.length}). Check the story and the look before paying for video. These are stills, not video.</p>
            <div className="mt-1.5 flex items-center gap-2 text-[11px]">
              {frames.isLoading ? <span className="flex items-center gap-1 text-fog-400"><Loader2 className="size-3 animate-spin" /> Pricing…</span> : frames.data?.blocked ? <span className="text-signal-amber">{frames.data.blocked}</span> : frames.data?.estimate ? (
                <>
                  <span className="text-fog-300">≈ <b className="text-white">{frames.data.estimate.credits}</b> credits</span>
                  <button type="button" disabled={busy !== null} onClick={draft} className="flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-white hover:bg-white/15 disabled:opacity-50">{busy === 'draft' ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Approve {frames.data.estimate.credits}</button>
                </>
              ) : null}
            </div>
          </div>
        )}
        <div className="rounded-xl border border-iris-400/30 bg-iris-500/[0.06] p-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-white"><Film className="size-3.5 text-iris-200" /> Final quality — video</div>
          <p className="mt-0.5 text-[11px] text-fog-400">Each shot is generated with the model that fits it (reference images keep the characters consistent where the model supports them), then voices, music and the edit.</p>
          {movie.isLoading ? (
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-fog-400"><Loader2 className="size-3 animate-spin" /> Pricing…</div>
          ) : movie.error ? (
            <div className="mt-1.5 text-[11px] text-signal-amber">{movie.error instanceof ApiError ? movie.error.message : 'Could not price it'}</div>
          ) : movie.data ? (
            <div className="mt-1.5 space-y-1 text-[11px]">
              <div className="text-fog-300">
                ≈ <b className="text-white">{movie.data.totalCredits}</b> credits{movie.data.modelMix.length ? ` · ${movie.data.modelMix.map((m) => `${m.model} ×${m.shots}`).join(', ')}` : ''}
              </div>
              {!movie.data.liveAvailable && <div className="text-signal-amber">Live generation is not switched on here — shots would be labelled test placeholders, not AI video.</div>}
              {blockers[0] && <div className="text-signal-amber">{blockers[0]}</div>}
              <button type="button" disabled={busy !== null || !movie.data.ok} onClick={final} className="flex items-center gap-1 rounded-lg bg-iris-500 px-2.5 py-1 font-medium text-white hover:bg-iris-400 disabled:opacity-50">{busy === 'final' ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Approve {movie.data.totalCredits} credits &amp; generate</button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
