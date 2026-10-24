'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Clapperboard, Coins, Film, Megaphone, MessageSquare, Mic, Music2, PenLine, Sparkles, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { PublicJob } from '@framecraft/shared';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Spinner, buttonVariants } from '@/components/ui';
import { ProgressBar } from '@/components/studio/progress';
import { VideoPlayer } from '@/components/studio/video-player';
import { cn, formatCredits, formatUsd, newKey } from '@/lib/utils';

// ------------------------------------------------------------------ live film data

type Shot = { id: string; index: number; description: string; durationSec: number; shotType: string | null; camera: string | null; dialogue: { speaker: string; line: string }[]; status: string; currentAssetId: string | null; storyboardAssetId: string | null };
export type MovieLive = {
  project: { id: string; title: string; aspectRatio: string; kind: string; plan: { title?: string; logline?: string; genre?: string } | null };
  scenes: { id: string; title: string; synopsis: string; shots: Shot[] }[];
  characters: { id: string; name: string; description: string; referenceAssetIds: string[]; voice?: { gender?: string } }[];
  planJob: PublicJob | null;
  movieJob: PublicJob | null;
  renderJob: PublicJob | null;
  shotJobs: PublicJob[];
  assetUrls: Record<string, { url: string; isFixture: boolean }>;
};

const ACTIVE = ['queued', 'preparing', 'generating', 'processing', 'rendering'];
const isActive = (j?: PublicJob | null) => Boolean(j && ACTIVE.includes(j.status));

/** One shared, self-refreshing view of a film (every card of the same project uses it). */
export function useMovieLive(projectId: string) {
  return useQuery({
    queryKey: ['movie', projectId],
    queryFn: () => api<MovieLive>(`/api/movies/${projectId}`),
    refetchInterval: (q) => {
      const d = q.state.data;
      return !d || isActive(d.planJob) || isActive(d.movieJob) || d.shotJobs.some(isActive) ? 3000 : false;
    },
  });
}

function CardShell({ icon, title, children, tone = 'default', right }: { icon: React.ReactNode; title: React.ReactNode; children: React.ReactNode; tone?: 'default' | 'muted'; right?: React.ReactNode }) {
  return (
    <div className={cn('mt-3 overflow-hidden rounded-2xl border hairline bg-ink-900/70', tone === 'muted' && 'opacity-70')}>
      <div className="flex items-center justify-between gap-2 border-b hairline px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-fog-100">
          <span className="text-iris-300">{icon}</span>
          <span className="truncate">{title}</span>
        </div>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------ screenplay

export function ScreenplayCard({ projectId, planJobId, onApprove, busy }: { projectId: string; planJobId: string; onApprove: () => void; busy: boolean }) {
  const { data: d } = useMovieLive(projectId);
  const [open, setOpen] = useState<string | null>(null);
  if (!d) return <CardShell icon={<PenLine className="size-4" />} title="Screenplay"><Spinner /></CardShell>;
  const latest = d.planJob?.id === planJobId;
  const job = latest ? d.planJob : null;
  if (!latest) return <CardShell tone="muted" icon={<PenLine className="size-4" />} title="Earlier version of the screenplay"><p className="text-xs text-fog-400">Replaced by a newer version below.</p></CardShell>;
  if (job && isActive(job))
    return (
      <CardShell icon={<PenLine className="size-4" />} title="Writing the screenplay">
        <ProgressBar progress={null} etaSec={job.etaSec} label={job.phase ?? 'AI Director is writing'} />
        <p className="mt-2 text-xs text-fog-400">Characters, locations, scenes, shots and dialogue — usually under a minute.</p>
      </CardShell>
    );
  if (job?.status === 'failed') return <CardShell icon={<X className="size-4" />} title="The screenplay could not be written"><p className="text-sm text-signal-red">{job.error?.message ?? 'Please try again or rephrase the idea.'}</p></CardShell>;

  const shots = d.scenes.flatMap((s) => s.shots);
  const total = shots.reduce((s, x) => s + x.durationSec, 0);
  const generated = shots.some((s) => s.currentAssetId);
  const meta = d.project.plan ?? {};
  return (
    <CardShell
      icon={<PenLine className="size-4" />}
      title={meta.title ?? d.project.title}
      right={<span className="shrink-0 text-xs tabular-nums text-fog-400">{shots.length} shots · {total}s · {d.project.aspectRatio}</span>}
    >
      {meta.logline && <p className="text-sm text-fog-200">{meta.logline}</p>}
      {d.characters.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-fog-400">Characters</div>
          <div className="flex flex-wrap gap-2">
            {d.characters.map((c) => {
              const ref = c.referenceAssetIds[0] ? d.assetUrls[c.referenceAssetIds[0]]?.url : undefined;
              return (
                <div key={c.id} className="flex max-w-full items-center gap-2 rounded-xl border hairline bg-white/[0.03] py-1 pl-1 pr-3" title={c.description}>
                  {ref ? <img src={ref} alt="" className="size-7 rounded-lg object-cover" /> : <span className="grid size-7 place-items-center rounded-lg bg-iris-500/20 text-xs text-iris-200">{c.name.slice(0, 1)}</span>}
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-fog-100">{c.name}</span>
                    <span className="block max-w-56 truncate text-[11px] text-fog-400">{c.description}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="mt-3 space-y-1.5">
        <div className="text-[11px] font-medium uppercase tracking-wider text-fog-400">Scenes</div>
        {d.scenes.map((sc, i) => (
          <div key={sc.id} className="rounded-xl border hairline bg-white/[0.02]">
            <button type="button" onClick={() => setOpen(open === sc.id ? null : sc.id)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
              <span className="min-w-0">
                <span className="text-xs font-medium text-fog-100">
                  {i + 1}. {sc.title}
                </span>
                <span className="block truncate text-[11px] text-fog-400">{sc.synopsis}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 text-[11px] text-fog-400">
                {sc.shots.length} shots
                <ChevronDown className={cn('size-3.5 transition', open === sc.id && 'rotate-180')} />
              </span>
            </button>
            {open === sc.id && (
              <ol className="space-y-2 border-t hairline px-3 py-2">
                {sc.shots.map((sh, j) => (
                  <li key={sh.id} className="text-xs text-fog-300">
                    <span className="text-fog-400 tabular-nums">
                      #{j + 1} · {sh.durationSec}s{sh.shotType ? ` · ${sh.shotType}` : ''}
                    </span>{' '}
                    {sh.description}
                    {sh.dialogue.map((dl, k) => (
                      <span key={k} className="mt-0.5 flex gap-1.5 pl-3 text-fog-200">
                        <MessageSquare className="mt-0.5 size-3 shrink-0 text-iris-300" />
                        <span>
                          <span className="text-fog-100">{dl.speaker}:</span> “{dl.line}”
                        </span>
                      </span>
                    ))}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </div>
      {!generated && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={onApprove} loading={busy}>
            <Check /> Approve screenplay
          </Button>
          <Link href={`/app/movie/${projectId}`} className={buttonVariants({ variant: 'secondary' })}>
            <PenLine /> Edit shots in Director view
          </Link>
          <span className="text-xs text-fog-400">…or just type what to change.</span>
        </div>
      )}
    </CardShell>
  );
}

// ------------------------------------------------------------------ budget

type Estimate = {
  shots: { credits: number; ok: boolean; blockers: string[]; keyframe?: 'ready' | 'drawn first' | null }[];
  totalCredits: number;
  providerCostUsd: number;
  durationSec: number;
  modelMix: { model: string; shots: number }[];
  ok: boolean;
  liveAvailable: boolean;
  dialogue?: { lines: number; credits: number; available: boolean; language: string } | null;
  soundtrack?: { music: boolean; ambienceScenes: number; credits: number; available: boolean } | null;
};

export function BudgetCard({ projectId, onStarted }: { projectId: string; onStarted: () => void }) {
  const qc = useQueryClient();
  const { data: d } = useMovieLive(projectId);
  const est = useQuery({ queryKey: ['movie-estimate', projectId], queryFn: () => api<{ estimate: Estimate }>(`/api/movies/${projectId}/estimate`, { body: { onlyMissing: true } }), staleTime: 30_000 });
  const [approve, setApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = isActive(d?.movieJob);
  const e = est.data?.estimate;

  const generate = async () => {
    if (!e) return;
    setBusy(true);
    try {
      await api(`/api/movies/${projectId}/generate`, { body: { approvedCredits: e.totalCredits, idempotencyKey: newKey() } });
      void qc.invalidateQueries({ queryKey: ['movie', projectId] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      onStarted();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start the film');
    } finally {
      setBusy(false);
    }
  };

  if (running || d?.movieJob?.status === 'completed') return <CardShell icon={<Coins className="size-4" />} title="Budget" tone="muted"><p className="text-xs text-fog-400">{running ? 'Production is running — progress is shown below.' : 'This film has been produced.'}</p></CardShell>;
  if (est.isError) return <CardShell icon={<Coins className="size-4" />} title="Budget"><p className="text-sm text-signal-red">{(est.error as Error).message}</p></CardShell>;
  if (!e) return <CardShell icon={<Coins className="size-4" />} title="Calculating the budget…"><Spinner /></CardShell>;
  if (!e.shots.length) return <CardShell icon={<Coins className="size-4" />} title="Budget"><p className="text-sm text-fog-300">Every shot is already generated.</p></CardShell>;
  const shotCredits = e.shots.reduce((s, x) => s + x.credits, 0);
  const rows: [React.ReactNode, string, number | null][] = [
    [<><Film className="size-3.5" /> {e.shots.length} shots · {e.modelMix.map((m) => m.model.replace(/ \(via .*\)/, '')).join(', ')}</>, 'video', shotCredits],
    ...(e.dialogue ? [[<><Mic className="size-3.5" /> {e.dialogue.lines} lines voiced by native voices</>, 'voices', e.dialogue.available ? e.dialogue.credits : null] as [React.ReactNode, string, number | null]] : []),
    ...(e.soundtrack ? [[<><Music2 className="size-3.5" /> {[e.soundtrack.music && 'film score', e.soundtrack.ambienceScenes && `ambience for ${e.soundtrack.ambienceScenes} scene${e.soundtrack.ambienceScenes > 1 ? 's' : ''}`].filter(Boolean).join(' + ')}</>, 'sound', e.soundtrack.available ? e.soundtrack.credits : null] as [React.ReactNode, string, number | null]] : []),
  ];
  return (
    <CardShell icon={<Coins className="size-4" />} title="Budget" right={<span className="text-xs text-fog-400">≈ {formatUsd(e.providerCostUsd)} provider cost</span>}>
      <div className="divide-y divide-white/5 text-sm">
        {rows.map(([label, key, credits]) => (
          <div key={key} className="flex items-center justify-between gap-3 py-1.5">
            <span className="flex min-w-0 items-center gap-1.5 text-fog-200">{label}</span>
            <span className="shrink-0 tabular-nums text-fog-100">{credits === null ? 'not configured' : formatCredits(credits)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between pt-2 font-medium text-white">
          <span>Total</span>
          <span className="tabular-nums">{formatCredits(e.totalCredits)} credits</span>
        </div>
      </div>
      {e.shots.some((s) => s.keyframe) && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-fog-300">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-iris-300" />
          Each shot's first frame is drawn with your characters' photos, then animated — faces stay consistent and cheaper models can be used ({e.shots.filter((s) => s.keyframe === 'drawn first').length} keyframes included).
        </p>
      )}
      {!e.ok && <p className="mt-2 text-xs text-signal-red">{e.shots.find((s) => !s.ok)?.blockers[0]}</p>}
      {!e.liveAvailable && <p className="mt-2 text-xs text-signal-amber">Live generation is not configured — shots render as free, labelled test clips.</p>}
      <label className="mt-3 flex items-start gap-2.5 text-sm text-fog-200">
        <input type="checkbox" className="mt-0.5 size-4 accent-iris-500" checked={approve} onChange={(ev) => setApprove(ev.target.checked)} />I approve spending up to {formatCredits(e.totalCredits)} credits.
      </label>
      <Button className="mt-3" size="lg" onClick={generate} disabled={!approve || !e.ok} loading={busy}>
        <Wand2 /> Generate {d?.project.kind === 'ad' ? 'ad' : 'film'}
      </Button>
    </CardShell>
  );
}

// ------------------------------------------------------------------ production progress & result

function Step({ state, label, children }: { state: 'done' | 'active' | 'todo' | 'failed'; label: string; children?: React.ReactNode }) {
  return (
    <li className="relative pl-7">
      <span
        className={cn(
          'absolute left-0 top-0.5 grid size-5 place-items-center rounded-full border text-[10px]',
          state === 'done' && 'border-signal-green/50 bg-signal-green/15 text-signal-green',
          state === 'active' && 'border-iris-400 bg-iris-500/20 text-iris-200',
          state === 'todo' && 'border-white/15 text-fog-400/70',
          state === 'failed' && 'border-signal-red/50 bg-signal-red/15 text-signal-red',
        )}
      >
        {state === 'done' ? <Check className="size-3" /> : state === 'active' ? <Spinner className="size-3" /> : state === 'failed' ? <X className="size-3" /> : null}
      </span>
      <div className={cn('text-sm', state === 'todo' ? 'text-fog-400/70' : 'text-fog-100')}>{label}</div>
      {children && <div className="mt-1.5">{children}</div>}
    </li>
  );
}

export function FilmCard({ projectId }: { projectId: string }) {
  const { data: d } = useMovieLive(projectId);
  if (!d) return <CardShell icon={<Clapperboard className="size-4" />} title="Production"><Spinner /></CardShell>;
  const mj = d.movieJob;
  const shots = d.scenes.flatMap((s) => s.shots);
  const ready = shots.filter((s) => s.currentAssetId).length;
  const jobs = d.shotJobs;
  const failedShots = jobs.filter((j) => j.status === 'failed' && !shots.find((s) => s.id === j.shotId)?.currentAssetId).length;
  const phase = mj?.phase ?? '';
  const inAudio = /voices|music|sound/i.test(phase);
  const rendering = mj?.status === 'rendering' || isActive(d.renderJob);
  const done = mj?.status === 'completed' && mj.outputUrl;
  const shotsState = ready === shots.length ? 'done' : failedShots && !isActive(mj) ? 'failed' : 'active';
  const audioState = done || rendering ? 'done' : inAudio ? 'active' : 'todo';
  const kind = d.project.kind === 'ad' ? 'ad' : 'film';

  return (
    <CardShell icon={<Clapperboard className="size-4" />} title={done ? `Your ${kind} is ready` : `Producing your ${kind}`} right={mj && !done && <span className="text-xs tabular-nums text-fog-400">{Math.round((mj.progress ?? 0) * 100)}%</span>}>
      {done ? (
        <div className="space-y-3">
          <VideoPlayer src={mj.outputUrl!} aspect={d.project.aspectRatio} isFixture={mj.isFixture} className="mx-auto max-w-xl" />
          <div className="flex flex-wrap gap-2">
            <Link href={`/app/editor/${projectId}`} className={buttonVariants({})}>
              <Sparkles /> Open in editor
            </Link>
            <a href={mj.outputUrl!} download className={buttonVariants({ variant: 'secondary' })}>
              Download MP4
            </a>
            <Link href={`/app/movie/${projectId}`} className={buttonVariants({ variant: 'ghost' })}>
              All shots
            </Link>
          </div>
          <p className="text-xs text-fog-400">Tell me what to improve — for example a different take of a line, or regenerate a shot.</p>
        </div>
      ) : (
        <>
          {mj && <ProgressBar progress={mj.progress} etaSec={mj.etaSec} label={mj.phase} />}
          <ol className="mt-4 space-y-3">
            <Step state="done" label="Screenplay approved" />
            <Step state={shotsState} label={`Shots — ${ready} of ${shots.length} ready${failedShots ? ` · ${failedShots} failed` : ''}`}>
              <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
                {shots.map((s) => {
                  const j = jobs.filter((x) => x.shotId === s.id).at(-1);
                  const thumb = s.currentAssetId ? d.assetUrls[s.currentAssetId] : s.storyboardAssetId ? d.assetUrls[s.storyboardAssetId] : undefined;
                  const failed = j?.status === 'failed' && !s.currentAssetId;
                  return (
                    <div key={s.id} title={`${s.description}${j?.phase ? ` — ${j.phase}` : ''}`} className={cn('relative aspect-video overflow-hidden rounded-md border bg-ink-800', failed ? 'border-signal-red/50' : s.currentAssetId ? 'border-signal-green/40' : 'hairline')}>
                      {thumb && (s.currentAssetId ? <video src={thumb.url} muted preload="metadata" className="size-full object-cover" /> : <img src={thumb.url} alt="" className="size-full object-cover opacity-60" />)}
                      {!s.currentAssetId && !failed && j && isActive(j) && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-iris-400" style={{ width: `${Math.max(8, (j.progress ?? 0) * 100)}%` }} />}
                      {failed && <X className="absolute inset-0 m-auto size-4 text-signal-red" />}
                    </div>
                  );
                })}
              </div>
              {failedShots > 0 && !isActive(mj) && (
                <p className="mt-2 text-xs text-fog-300">
                  Some shots failed and were not charged. <Link className="text-iris-300 underline" href={`/app/movie/${projectId}`}>Open the shots</Link> to regenerate them, or ask me to retry.
                </p>
              )}
            </Step>
            <Step state={audioState} label="Voices, music and sound" />
            <Step state={done ? 'done' : rendering ? 'active' : 'todo'} label="Editing and final render" />
          </ol>
        </>
      )}
    </CardShell>
  );
}

// ------------------------------------------------------------------ ad concepts

export type AdConcept = { title: string; angle: string; hook: string; story: string; voiceover: string[]; cta: string; musicMood: string; lengthSec: number };

export function ConceptsCard({ concepts, onChoose, onMore, busy }: { concepts: AdConcept[]; onChoose: (i: number) => void; onMore: () => void; busy: number | 'more' | null }) {
  return (
    <CardShell icon={<Megaphone className="size-4" />} title="Ad ideas" right={<Button size="sm" variant="ghost" onClick={onMore} loading={busy === 'more'}>New ideas</Button>}>
      <div className="grid gap-3 md:grid-cols-3">
        {concepts.map((c, i) => (
          <div key={i} className="flex flex-col rounded-xl border hairline bg-white/[0.03] p-3">
            <div className="flex items-center justify-between gap-2">
              <Badge tone="iris">Idea {i + 1}</Badge>
              <span className="text-[11px] tabular-nums text-fog-400">{c.lengthSec}s</span>
            </div>
            <div className="mt-2 text-sm font-medium text-white">{c.title}</div>
            <p className="mt-1 text-xs text-fog-300">{c.angle}</p>
            <p className="mt-2 text-xs text-fog-200">
              <span className="text-fog-400">Hook: </span>
              {c.hook}
            </p>
            <p className="mt-1 text-xs text-fog-300">{c.story}</p>
            {c.voiceover.length > 0 && (
              <div className="mt-2 space-y-0.5 rounded-lg bg-black/20 p-2 text-xs text-fog-200">
                {c.voiceover.map((l, k) => (
                  <div key={k} className="flex gap-1.5">
                    <Mic className="mt-0.5 size-3 shrink-0 text-iris-300" />“{l}”
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2 text-xs text-fog-200">
              <span className="text-fog-400">CTA: </span>
              {c.cta}
            </div>
            <div className="mt-auto pt-3">
              <Button size="sm" className="w-full" onClick={() => onChoose(i)} loading={busy === i} disabled={busy !== null}>
                <Wand2 /> Make this ad
              </Button>
            </div>
          </div>
        ))}
      </div>
    </CardShell>
  );
}
