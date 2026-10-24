'use client';

import Link from 'next/link';
import { use, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, Check, Clapperboard, Coins, Film, ImageIcon, Loader2, MessageSquare, Mic, Music2, Plus, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { CAMERA_PRESETS, SHOT_TYPES, type PublicJob } from '@framecraft/shared';
import { api, ApiError, type Project } from '@/lib/api';
import { useModels } from '@/lib/hooks';
import { Badge, Button, Card, Dialog, Field, Input, NativeSelect, PageHeader, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, buttonVariants } from '@/components/ui';
import { StatusBadge } from '@/components/studio/job-view';
import { VideoPlayer } from '@/components/studio/video-player';
import { ProgressBar } from '@/components/studio/progress';
import { cn, formatCredits, formatUsd, newKey, seconds } from '@/lib/utils';

/** Re-record a finished film's dialogue with native-language voices (no video is regenerated). */
function ReVoice({ projectId, onStarted }: { projectId: string; onStarted: () => void }) {
  const [est, setEst] = useState<DialogueEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  const lang = est ? (LANGUAGE_NAMES[est.language] ?? est.language) : '';
  return (
    <Card className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 p-4 text-sm">
      <div className="min-w-0">
        <div className="font-medium text-white">
          <Mic className="mr-1.5 inline size-4 text-iris-300" />
          Re-voice the dialogue
        </div>
        <p className="mt-0.5 text-fog-300">
          {est
            ? `${est.lines} lines with native ${lang} voices (ElevenLabs), one voice per character. The video is kept; its original speech is muted.`
            : 'Record every line again with natural native-language voices and re-render the film. No video is regenerated.'}
        </p>
      </div>
      {!est ? (
        <Button variant="secondary" loading={busy} onClick={() => run(async () => setEst((await api<{ estimate: DialogueEstimate }>(`/api/movies/${projectId}/dub/estimate`, { body: {} })).estimate))}>
          Check cost
        </Button>
      ) : (
        <Button
          loading={busy}
          disabled={!est.available}
          onClick={() =>
            run(async () => {
              await api(`/api/movies/${projectId}/dub`, { body: { approvedCredits: est.credits, idempotencyKey: newKey() } });
              toast.success('Recording the dialogue — the film re-renders automatically');
              setEst(null);
              onStarted();
            })
          }
        >
          <Mic /> Re-voice for {formatCredits(est.credits)} credits
        </Button>
      )}
    </Card>
  );
}

/** A new take of one shot's lines; the film re-renders with it (other shots keep their voices). */
function ShotReVoice({ projectId, shotId, disabled, onStarted }: { projectId: string; shotId: string; disabled: boolean; onStarted: () => void }) {
  const [credits, setCredits] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      if (credits === null) {
        const { estimate } = await api<{ estimate: DialogueEstimate }>(`/api/movies/${projectId}/dub/estimate`, { body: { shotIds: [shotId] } });
        if (!estimate.available) throw new Error('Dialogue voices are not configured');
        setCredits(estimate.credits);
        return;
      }
      await api(`/api/movies/${projectId}/dub`, { body: { approvedCredits: credits, idempotencyKey: newKey(), shotIds: [shotId] } });
      toast.success('Recording a new take — the film re-renders with it automatically');
      setCredits(null);
      onStarted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not re-voice');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant={credits === null ? 'ghost' : 'primary'} onClick={run} loading={busy} disabled={disabled} title="Record this shot's lines again with the character's voice">
      <Mic /> {credits === null ? 'Re-voice' : `Confirm · ${formatCredits(credits)} ${credits === 1 ? 'credit' : 'credits'}`}
    </Button>
  );
}

type Shot = {
  id: string;
  sceneId: string;
  index: number;
  description: string;
  prompt: string;
  durationSec: number;
  shotType: string | null;
  camera: string | null;
  characterIds: string[];
  dialogue: { characterId?: string; speaker: string; line: string }[];
  modelOverride: string | null;
  status: string;
  currentAssetId: string | null;
  storyboardAssetId: string | null;
  lastJobId: string | null;
  referenceAssetIds: string[];
};
type Scene = { id: string; index: number; title: string; synopsis: string; shots: Shot[] };
type MovieData = {
  project: Project & { approvedBudgetCredits: number | null };
  scenes: Scene[];
  characters: { id: string; name: string; description: string; appearance: Record<string, string>; clothing: string; referenceAssetIds: string[] }[];
  locations: { id: string; name: string; description: string; referenceAssetIds: string[] }[];
  planJob: PublicJob | null;
  movieJob: PublicJob | null;
  renderJob: PublicJob | null;
  shotJobs: PublicJob[];
  assetUrls: Record<string, { url: string; isFixture: boolean }>;
  /** Per shot: its current dialogue takes (timed within the shot) and the clip's own audio level. */
  dub?: Record<string, ShotDub>;
};
type VoiceTake = { assetId: string; url: string; createdAt: string; current: boolean };
type ShotDub = { clipVolume: number; voices: { url: string; startSec: number; durationSec: number }[]; lines?: { index: number; takes: VoiceTake[] }[] };

/** Every recorded take of a line: listen to any, and choose which one the film uses. */
function TakePicker({ projectId, shotId, index, takes, onChanged }: { projectId: string; shotId: string; index: number; takes: VoiceTake[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => player.current?.pause(), []);
  const listen = (t: VoiceTake) => {
    player.current?.pause();
    player.current = new Audio(t.url);
    void player.current.play().catch(() => undefined);
  };
  const choose = async (t: VoiceTake, i: number) => {
    if (t.current) return listen(t);
    setBusy(t.assetId);
    try {
      // The newest take is the default; choosing it clears the override.
      await api(`/api/movies/${projectId}/voice-take`, { body: { shotId, index, assetId: i === takes.length - 1 ? null : t.assetId } });
      toast.success(`Take ${i + 1} is now used — export the film from the editor to update the final video`);
      listen(t);
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not switch take');
    } finally {
      setBusy(null);
    }
  };
  if (takes.length < 2) return null;
  return (
    <span className="ml-5 mt-1 flex flex-wrap items-center gap-1 text-[11px] text-fog-400">
      Takes:
      {takes.map((t, i) => (
        <button
          key={t.assetId}
          type="button"
          onClick={() => choose(t, i)}
          disabled={busy !== null}
          title={t.current ? 'In the film — click to listen' : 'Use this take (and listen)'}
          className={cn('rounded-md border px-1.5 py-0.5 tabular-nums transition', t.current ? 'border-iris-400 bg-iris-500/20 text-white' : 'border-white/10 hover:border-white/30 hover:text-fog-100', busy === t.assetId && 'opacity-50')}
        >
          {i + 1}
          {t.current && ' ✓'}
        </button>
      ))}
    </span>
  );
}

/** A shot clip played with its dubbed voices on top (as in the film), original speech muted. */
function DubbedClip({ src: liveSrc, dub: liveDub, aspect }: { src: string; dub: ShotDub; aspect: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const voices = useRef<HTMLAudioElement[]>([]);
  // The page refetches every few seconds and signed URLs change each time; only a different
  // file (path) or timing should reload anything, never playback in progress.
  const path = (u: string) => u.split('?')[0];
  const [src, setSrc] = useState(liveSrc);
  if (path(src) !== path(liveSrc)) setSrc(liveSrc);
  const dubKey = `${liveDub.clipVolume}|${liveDub.voices.map((v) => `${path(v.url)}@${v.startSec}`).join(',')}`;
  const [dub, setDub] = useState({ key: dubKey, value: liveDub });
  if (dub.key !== dubKey) setDub({ key: dubKey, value: liveDub });
  useEffect(() => {
    voices.current = dub.value.voices.map((v) => {
      const el = new Audio(v.url);
      el.preload = 'auto';
      return el;
    });
    return () => voices.current.forEach((el) => el.pause());
  }, [dub]);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const { clipVolume, voices: lines } = dub.value;
    v.volume = Math.min(1, clipVolume);
    v.muted = clipVolume === 0;
    let raf = 0;
    // Follow the video frame by frame so each line starts on time (not on the coarse timeupdate tick).
    const tick = () => {
      const t = v.currentTime;
      lines.forEach((d, i) => {
        const el = voices.current[i];
        if (!el) return;
        const local = t - d.startSec;
        if (!v.paused && local >= 0 && local < d.durationSec) {
          if (el.paused) {
            el.currentTime = local < 0.5 ? 0 : local;
            void el.play().catch(() => undefined);
          } else if (Math.abs(el.currentTime - local) > 0.35) el.currentTime = local;
        } else if (!el.paused) el.pause();
      });
      if (!v.paused) raf = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      voices.current.forEach((el) => el.pause());
    };
    const resume = () => {
      if (!v.paused) start();
    };
    v.addEventListener('play', start);
    v.addEventListener('seeking', stop);
    v.addEventListener('seeked', resume);
    v.addEventListener('pause', stop);
    return () => {
      stop();
      v.removeEventListener('play', start);
      v.removeEventListener('pause', stop);
      v.removeEventListener('seeking', stop);
      v.removeEventListener('seeked', resume);
    };
  }, [dub]);
  const [w, h] = aspect.split(':').map(Number);
  return (
    <div className="relative overflow-hidden rounded-xl bg-black" style={{ aspectRatio: `${w}/${h}` }}>
      <video ref={video} src={src} controls playsInline loop className="size-full object-contain" preload="metadata" />
      <span className="pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-fog-100">
        <Mic className="size-3 text-iris-300" /> dubbed voice
      </span>
    </div>
  );
}
type Estimate = { shots: { shotId: string; sceneTitle: string; description: string; credits: number; providerCostUsd: number; modelName: string | null; ok: boolean; blockers: string[]; audioDropped?: boolean; keyframe?: 'ready' | 'drawn first' | null }[]; totalCredits: number; providerCostUsd: number; durationSec: number; modelMix: { model: string; shots: number }[]; ok: boolean; liveAvailable: boolean; dialogue?: DialogueEstimate | null; soundtrack?: { music: boolean; ambienceScenes: number; credits: number; available: boolean } | null };
type DialogueEstimate = { lines: number; credits: number; providerCostUsd: number; available: boolean; language: string };
const LANGUAGE_NAMES: Record<string, string> = { ka: 'Georgian', ru: 'Russian', en: 'English' };

function ShotCard({ shot, data, onEdit, onMove, refresh, isFirst, isLast }: { shot: Shot; data: MovieData; onEdit: () => void; onMove: (d: -1 | 1) => void; refresh: () => void; isFirst: boolean; isLast: boolean }) {
  const job = data.shotJobs.filter((j) => j.shotId === shot.id).at(-1);
  const clip = shot.currentAssetId ? data.assetUrls[shot.currentAssetId] : undefined;
  const frame = shot.storyboardAssetId ? data.assetUrls[shot.storyboardAssetId] : undefined;
  const [busy, setBusy] = useState(false);
  const regenerate = async () => {
    setBusy(true);
    try {
      await api(`/api/shots/${shot.id}/regenerate`, { body: { idempotencyKey: newKey() } });
      toast.success('Shot queued');
      refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not regenerate');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="surface grid gap-3 rounded-2xl p-3 md:grid-cols-[180px_1fr] md:p-4">
      <div className="relative overflow-hidden rounded-xl bg-ink-800" style={{ aspectRatio: data.project.aspectRatio.replace(':', '/') }}>
        {clip ? (
          data.dub?.[shot.id]?.voices.length ? (
            <DubbedClip src={clip.url} dub={data.dub[shot.id]!} aspect={data.project.aspectRatio} />
          ) : (
            <VideoPlayer src={clip.url} aspect={data.project.aspectRatio} isFixture={clip.isFixture} className="rounded-xl border-0" />
          )
        ) : frame ? (
          <>
            <img src={frame.url} alt="Storyboard frame" className="size-full object-cover" />
            {frame.isFixture && <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 text-[9px] text-signal-amber">placeholder</span>}
          </>
        ) : (
          <div className="grid size-full place-items-center text-fog-400">{job && ['queued', 'preparing', 'generating', 'processing'].includes(job.status) ? <Loader2 className="size-5 animate-spin" /> : <Film className="size-5" />}</div>
        )}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-white">Shot {shot.index + 1}</span>
          <Badge>{shot.durationSec}s</Badge>
          {shot.shotType && <Badge>{shot.shotType}</Badge>}
          {shot.camera && <Badge tone="blue">{CAMERA_PRESETS.find((c) => c.key === shot.camera)?.label ?? shot.camera}</Badge>}
          {shot.modelOverride && <Badge tone="iris">{shot.modelOverride.split(':')[1]}</Badge>}
          {shot.referenceAssetIds.length > 0 && <Badge tone="amber">{shot.referenceAssetIds.length} photo ref</Badge>}
          {job && <StatusBadge job={job} />}
        </div>
        <p className="mt-2 line-clamp-3 text-sm text-fog-200">{shot.prompt}</p>
        {shot.dialogue.map((d, i) => {
          // Takes are indexed over spoken lines (placeholders like "(…)" are never voiced).
          const spoken = shot.dialogue.slice(0, i + 1).filter((x) => x.line.trim() && !/^\(.*\)$/s.test(x.line.trim())).length - 1;
          const takes = data.dub?.[shot.id]?.lines?.find((l) => l.index === spoken)?.takes ?? [];
          return (
            <div key={i} className="mt-1.5 text-xs text-fog-300">
              <p className="flex gap-1.5">
                <MessageSquare className="mt-0.5 size-3 shrink-0 text-iris-300" />
                <span>
                  <span className="text-fog-100">{d.speaker}:</span> “{d.line}”
                </span>
              </p>
              <TakePicker projectId={data.project.id} shotId={shot.id} index={spoken} takes={takes} onChanged={refresh} />
            </div>
          );
        })}
        {job?.status === 'failed' && job.error && <p className="mt-2 text-xs text-signal-red">{job.error.message}</p>}
        {job && ['queued', 'preparing', 'generating', 'processing'].includes(job.status) && (
          <div className="mt-3 max-w-sm">
            <ProgressBar progress={job.progressSource === 'provider' ? job.progress : null} etaSec={job.etaSec} label={job.phase} />
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={onEdit}>Edit shot</Button>
          {shot.currentAssetId && shot.dialogue.some((d) => d.line.trim()) && (
            <ShotReVoice projectId={data.project.id} shotId={shot.id} disabled={Boolean(data.movieJob && ['queued', 'generating', 'rendering'].includes(data.movieJob.status))} onStarted={refresh} />
          )}
          {(shot.currentAssetId || job?.status === 'failed') && (
            <Button size="sm" variant="ghost" onClick={regenerate} loading={busy}>
              <RotateCcw /> Regenerate
            </Button>
          )}
          <Button size="icon" variant="ghost" aria-label="Move up" disabled={isFirst} onClick={() => onMove(-1)}>
            <ArrowUp />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Move down" disabled={isLast} onClick={() => onMove(1)}>
            <ArrowDown />
          </Button>
        </div>
      </div>
    </div>
  );
}

function RefThumbs({ ids, urls }: { ids: string[]; urls: Record<string, { url: string; isFixture: boolean }> }) {
  if (!ids.length) return null;
  return (
    <div className="mb-3 flex gap-1.5">
      {ids.map((id) =>
        urls[id] ? (
          <img key={id} src={urls[id].url} alt="Reference photo" className="size-14 rounded-lg border hairline object-cover" />
        ) : null,
      )}
    </div>
  );
}

export default function DirectorMode({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data: models } = useModels();
  const q = useQuery({
    queryKey: ['movie', id],
    queryFn: () => api<MovieData>(`/api/movies/${id}`),
    refetchInterval: (query) => {
      const d = query.state.data;
      const active = !d || d.planJob?.status === 'queued' || d.planJob?.status === 'preparing' || (d.movieJob && ['generating', 'rendering'].includes(d.movieJob.status)) || d.shotJobs.some((j) => !['completed', 'failed', 'cancelled'].includes(j.status));
      return active ? 3000 : false;
    },
  });
  const [tab, setTab] = useState('shots');
  const [editing, setEditing] = useState<Shot | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [approve, setApprove] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['movie', id] });
  const d = q.data;

  if (!d) return <Skeleton className="mx-auto h-96 max-w-5xl" />;
  const planning = d.planJob && ['queued', 'preparing'].includes(d.planJob.status);
  const allShots = d.scenes.flatMap((s) => s.shots);
  const totalSec = allShots.reduce((s, x) => s + x.durationSec, 0);
  const ready = allShots.filter((s) => s.currentAssetId).length;

  const loadEstimate = async () => {
    setBusy('estimate');
    try {
      const r = await api<{ estimate: Estimate }>(`/api/movies/${id}/estimate`, { body: { onlyMissing: true } });
      setEstimate(r.estimate);
      setApprove(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not estimate');
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    if (!estimate) return;
    setBusy('generate');
    try {
      await api(`/api/movies/${id}/generate`, { body: { approvedCredits: estimate.totalCredits, idempotencyKey: newKey() } });
      toast.success('Film generation started');
      setEstimate(null);
      setTab('shots');
      void qc.invalidateQueries({ queryKey: ['me'] });
      void refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start');
    } finally {
      setBusy(null);
    }
  };

  const storyboard = async () => {
    setBusy('storyboard');
    try {
      await api(`/api/movies/${id}/storyboard`, { body: { idempotencyKey: newKey() } });
      toast.success('Storyboard frames queued');
      void refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not create storyboard');
    } finally {
      setBusy(null);
    }
  };

  const move = async (scene: Scene, shot: Shot, dir: -1 | 1) => {
    const order = scene.shots.map((s) => s.id);
    const i = order.indexOf(shot.id);
    [order[i], order[i + dir]] = [order[i + dir]!, order[i]!];
    await api(`/api/scenes/${scene.id}/reorder`, { body: { order } });
    void refresh();
  };

  const saveShot = async () => {
    if (!editing) return;
    setBusy('shot');
    try {
      await api(`/api/shots/${editing.id}`, { method: 'PATCH', body: { description: editing.description, prompt: editing.prompt, durationSec: editing.durationSec, shotType: editing.shotType, camera: editing.camera, dialogue: editing.dialogue.filter((x) => x.line.trim()), modelOverride: editing.modelOverride || null } });
      setEditing(null);
      setEstimate(null);
      void refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-2">
            <Clapperboard className="size-3.5" /> {d.project.plan?.genre ?? 'Film'} · {d.project.aspectRatio} · {seconds(totalSec)}
          </span>
        }
        title={d.project.title}
        description={d.project.plan?.logline}
        actions={
          <>
            {ready > 0 && (
              <Link href={`/app/editor/${id}`} className={buttonVariants({ variant: 'secondary' })}>
                <Film /> Editor
              </Link>
            )}
            <Button onClick={() => { setTab('budget'); void loadEstimate(); }} disabled={Boolean(planning)}>
              <Coins /> Budget & generate
            </Button>
          </>
        }
      />

      {d.project.plan?.source === 'offline' && (
        <div className="mb-5 flex gap-2 rounded-2xl bg-signal-amber/10 p-3 text-sm text-signal-amber">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> This draft was made by the offline planner because the AI Director (LLM) isn’t configured. Edit the shots or connect an LLM key for a full screenplay.
        </div>
      )}

      {planning ? (
        <Card className="p-8 text-center">
          <Loader2 className="mx-auto size-6 animate-spin text-iris-300" />
          <div className="mt-3 font-medium text-white">{d.planJob?.phase ?? 'Writing the screenplay'}</div>
          <p className="mt-1 text-sm text-fog-400">Characters, locations, scenes and shots are being planned.</p>
        </Card>
      ) : d.planJob?.status === 'failed' ? (
        <Card className="p-6 text-signal-red">Planning failed: {d.planJob.error?.message}</Card>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="shots">Shots ({allShots.length})</TabsTrigger>
            <TabsTrigger value="cast">Cast & places</TabsTrigger>
            <TabsTrigger value="budget">Budget</TabsTrigger>
            <TabsTrigger value="film">Film</TabsTrigger>
          </TabsList>

          <TabsContent value="shots">
            {d.movieJob && ['generating', 'rendering'].includes(d.movieJob.status) && (
              <Card className="mb-4 p-4 text-sm">
                <ProgressBar progress={d.movieJob.progress} etaSec={d.movieJob.etaSec} label={d.movieJob.phase} />
                <p className="mt-2 text-xs text-fog-400">Shots are generated in parallel. You can leave this page — you’ll get a notification when the film is ready.</p>
              </Card>
            )}
            {d.movieJob?.status === 'failed' && <Card className="mb-4 p-4 text-sm text-signal-red">{d.movieJob.error?.message ?? d.movieJob.phase}</Card>}
            <div className="mb-4 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={storyboard} loading={busy === 'storyboard'}>
                <ImageIcon /> Storyboard frames
              </Button>
              <span className="self-center text-xs text-fog-400">{ready}/{allShots.length} shots generated</span>
            </div>
            <div className="space-y-8">
              {d.scenes.map((sc) => (
                <section key={sc.id}>
                  <div className="mb-3">
                    <h3 className="font-semibold text-white">{sc.title}</h3>
                    <p className="text-sm text-fog-400">{sc.synopsis}</p>
                  </div>
                  <div className="space-y-3">
                    {sc.shots.map((sh, i) => (
                      <ShotCard key={sh.id} shot={sh} data={d} onEdit={() => setEditing(structuredClone(sh))} onMove={(dir) => move(sc, sh, dir)} refresh={refresh} isFirst={i === 0} isLast={i === sc.shots.length - 1} />
                    ))}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        await api(`/api/scenes/${sc.id}/shots`, { body: { description: 'New shot', prompt: sc.synopsis || 'Describe this shot', durationSec: 5 } });
                        void refresh();
                      }}
                    >
                      <Plus /> Add shot
                    </Button>
                  </div>
                </section>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="cast">
            <div className="grid gap-3 md:grid-cols-2">
              {d.characters.map((c) => (
                <Card key={c.id} className="p-4">
                  <RefThumbs ids={c.referenceAssetIds} urls={d.assetUrls} />
                  <div className="font-medium text-white">{c.name}</div>
                  <p className="mt-1 text-sm text-fog-300">{c.appearance.distinguishing}</p>
                  <p className="mt-1 text-xs text-fog-400">Wears: {c.clothing}</p>
                </Card>
              ))}
              {d.locations.map((l) => (
                <Card key={l.id} className="p-4">
                  <RefThumbs ids={l.referenceAssetIds} urls={d.assetUrls} />
                  <Badge tone="blue">Location</Badge>
                  <div className="mt-2 font-medium text-white">{l.name}</div>
                  <p className="mt-1 text-sm text-fog-300">{l.description}</p>
                </Card>
              ))}
            </div>
            <Link href="/app/characters" className={cn(buttonVariants({ variant: 'secondary' }), 'mt-4')}>Edit looks & add reference images</Link>
          </TabsContent>

          <TabsContent value="budget">
            {!estimate ? (
              <Card className="p-6 text-center">
                <Button onClick={loadEstimate} loading={busy === 'estimate'}>
                  <Coins /> Calculate budget
                </Button>
              </Card>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <Card className="p-4">
                    <div className="text-xs text-fog-400">Total for remaining shots</div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{formatCredits(estimate.totalCredits)} credits</div>
                    <div className="text-xs text-fog-400">≈ {formatUsd(estimate.providerCostUsd)} provider cost</div>
                  </Card>
                  <Card className="p-4">
                    <div className="text-xs text-fog-400">Shots to generate</div>
                    <div className="mt-1 text-2xl font-semibold text-white">{estimate.shots.length}</div>
                    <div className="text-xs text-fog-400">Completed shots are never charged again</div>
                  </Card>
                  <Card className="p-4">
                    <div className="text-xs text-fog-400">Model mix</div>
                    {estimate.modelMix.map((m) => (
                      <div key={m.model} className="mt-1 flex justify-between text-sm text-fog-200">
                        <span className="truncate">{m.model.replace(/ \(via .*\)/, '')}</span>
                        <span>{m.shots}</span>
                      </div>
                    ))}
                  </Card>
                </div>
                <Card className="divide-y divide-white/5">
                  {estimate.shots.map((s, i) => (
                    <div key={s.shotId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <span className="min-w-0 truncate text-fog-200">
                        {i + 1}. {s.sceneTitle} — {s.description}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {s.keyframe && <Badge tone="blue" title="The shot's first frame is drawn with your characters' photos, then animated — consistent faces at lower cost.">{s.keyframe === 'ready' ? 'keyframe ✓' : '+ keyframe'}</Badge>}
                        {s.audioDropped && <Badge tone="amber" title="No model in your plan offers native audio together with these reference photos — add a voice-over in the editor.">voice-over needed</Badge>}
                        <span className={cn('tabular-nums', s.ok ? 'text-fog-100' : 'text-signal-red')}>{s.ok ? formatCredits(s.credits) : s.blockers[0]}</span>
                      </span>
                    </div>
                  ))}
                  {estimate.dialogue && (
                    <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <span className="min-w-0 text-fog-200">
                        <Mic className="mr-1.5 inline size-3.5 text-iris-300" />
                        Dialogue — {estimate.dialogue.lines} lines voiced by native {LANGUAGE_NAMES[estimate.dialogue.language] ?? estimate.dialogue.language} voices (ElevenLabs), one voice per character
                      </span>
                      <span className="shrink-0 tabular-nums text-fog-100">{estimate.dialogue.available ? formatCredits(estimate.dialogue.credits) : 'subtitles only'}</span>
                    </div>
                  )}
                  {estimate.soundtrack && (
                    <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <span className="min-w-0 text-fog-200">
                        <Music2 className="mr-1.5 inline size-3.5 text-iris-300" />
                        Sound — {[estimate.soundtrack.music && 'film score', estimate.soundtrack.ambienceScenes > 0 && `ambience for ${estimate.soundtrack.ambienceScenes} scene${estimate.soundtrack.ambienceScenes > 1 ? 's' : ''}`].filter(Boolean).join(' + ')} (ElevenLabs)
                      </span>
                      <span className="shrink-0 tabular-nums text-fog-100">{estimate.soundtrack.available ? formatCredits(estimate.soundtrack.credits) : 'not configured'}</span>
                    </div>
                  )}
                </Card>
                {!estimate.liveAvailable && <p className="text-sm text-signal-amber">Live generation isn’t configured, so shots will render as free, labelled test fixtures. The budget shows what a real render would cost.</p>}
                <label className="flex items-start gap-3 text-sm text-fog-200">
                  <input type="checkbox" className="mt-0.5 size-4 accent-iris-500" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
                  I approve spending up to {formatCredits(estimate.totalCredits)} credits to generate these shots.
                </label>
                <Button size="lg" onClick={generate} disabled={!approve || !estimate.ok} loading={busy === 'generate'}>
                  <Wand2 /> Generate film
                </Button>
              </div>
            )}
          </TabsContent>

          <TabsContent value="film">
            {d.movieJob?.status === 'completed' && d.movieJob.outputUrl ? (
              <div className="space-y-4">
                <VideoPlayer src={d.movieJob.outputUrl} aspect={d.project.aspectRatio} isFixture={d.movieJob.isFixture} className="mx-auto max-w-3xl" />
                <div className="flex justify-center gap-2">
                  <a href={d.movieJob.outputUrl} download className={buttonVariants({ variant: 'white' })}>Download MP4</a>
                  <Link href={`/app/editor/${id}`} className={buttonVariants({ variant: 'secondary' })}>Fine-tune in editor</Link>
                </div>
                {allShots.some((s) => s.dialogue.length) && <ReVoice projectId={id} onStarted={refresh} />}
              </div>
            ) : (
              <Card className="p-8 text-center text-sm text-fog-300">
                <Check className="mx-auto mb-2 size-5 text-fog-400" /> The finished film appears here once every shot is generated and the film is assembled.
              </Card>
            )}
          </TabsContent>
        </Tabs>
      )}

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(o) => !o && setEditing(null)}
        title={`Edit shot ${editing ? editing.index + 1 : ''}`}
        wide
        footer={
          <>
            <Button
              variant="danger"
              onClick={async () => {
                await api(`/api/shots/${editing!.id}`, { method: 'DELETE' });
                setEditing(null);
                void refresh();
              }}
            >
              <Trash2 /> Delete
            </Button>
            <Button onClick={saveShot} loading={busy === 'shot'}>Save</Button>
          </>
        }
      >
        {editing && (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <Field label="Prompt" hint="Self-contained description for the video model.">
                <Textarea value={editing.prompt} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} className="min-h-28" />
              </Field>
            </div>
            <Field label="Duration (s)">
              <Input type="number" min={2} max={30} value={editing.durationSec} onChange={(e) => setEditing({ ...editing, durationSec: Number(e.target.value) })} />
            </Field>
            <Field label="Shot type">
              <NativeSelect value={editing.shotType ?? ''} onChange={(e) => setEditing({ ...editing, shotType: e.target.value || null })}>
                <option value="">—</option>
                {SHOT_TYPES.map((s) => <option key={s}>{s}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Camera">
              <NativeSelect value={editing.camera ?? ''} onChange={(e) => setEditing({ ...editing, camera: e.target.value || null })}>
                <option value="">—</option>
                {CAMERA_PRESETS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Model">
              <NativeSelect value={editing.modelOverride ?? ''} onChange={(e) => setEditing({ ...editing, modelOverride: e.target.value || null })}>
                <option value="">Automatic</option>
                {models?.models.filter((m) => m.routable).map((m) => <option key={m.key} value={m.key}>{m.displayName}</option>)}
              </NativeSelect>
            </Field>
            <div className="space-y-2 md:col-span-2">
              <div className="text-[13px] font-medium text-fog-300">Dialogue</div>
              {editing.dialogue.map((line, i) => (
                <div key={i} className="grid grid-cols-[120px_1fr] gap-2">
                  <Input value={line.speaker} onChange={(e) => setEditing({ ...editing, dialogue: editing.dialogue.map((x, j) => (j === i ? { ...x, speaker: e.target.value } : x)) })} />
                  <Input value={line.line} onChange={(e) => setEditing({ ...editing, dialogue: editing.dialogue.map((x, j) => (j === i ? { ...x, line: e.target.value } : x)) })} />
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setEditing({ ...editing, dialogue: [...editing.dialogue, { speaker: d.characters[0]?.name ?? 'Narrator', line: '' }] })}>
                <Plus /> Add line
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
