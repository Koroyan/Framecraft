'use client';

import { useMemo, useState } from 'react';
import { Clapperboard, Crosshair, Film, GripVertical, Loader2, Play, Plus, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { clipDuration, describeDirectorOp, moveNodeAfter, removeNode, type DirectorScope, type Timeline } from '@framecraft/shared';
import { gradeCss } from '@/lib/looks';
import { api, ApiError, type Asset } from '@/lib/api';
import { useAssistant } from '@/lib/assistant';
import { directorNames, scopeLabel, shotState, storyModel } from '@/lib/director';
import { activeVersion, type StudioData } from '@/lib/studio';
import { cn, seconds } from '@/lib/utils';
import { AskCard, type DirectorDeps } from './director-chat';

/*
 * Simple storyboard: the film as cards in the order it plays, grouped by scene, with the shots that
 * are written but not generated yet in their place. Same data as the graph and the timeline, so they
 * never disagree. Every card and scene has Ask AI; planned shots have Generate (price first).
 */

type Props = {
  projectId: string;
  timeline: Timeline;
  assets: Map<string, Asset>;
  studio?: StudioData;
  apply: (fn: (t: Timeline) => Timeline) => void;
  refetch: () => unknown;
  selectedClipId: string | null;
  playhead: number;
  onPlay: (clipId: string) => void;
  onOpenShot: (clipId: string) => void;
  onAdd: () => void;
};

export function Storyboard({ projectId, timeline, assets, studio, apply, refetch, selectedClipId, onPlay, onOpenShot, onAdd }: Props) {
  const model = useMemo(() => storyModel(studio, timeline), [studio, timeline]);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ key: string; scope: DirectorScope } | null>(null);
  const deps: DirectorDeps = { projectId, studio, timeline, apply, refetch };

  // Group consecutive cards by scene (your own clips form one group).
  const groups = useMemo(() => {
    const out: { sceneId: string | null; entries: typeof model.order }[] = [];
    for (const e of model.order) {
      const sceneId = (e.shotId && model.byId.get(e.shotId)?.sceneId) || null;
      const last = out.at(-1);
      if (last && last.sceneId === sceneId) last.entries.push(e);
      else out.push({ sceneId, entries: [e] });
    }
    return out;
  }, [model]);

  const generatePlan = (shotId: string) => {
    const op = { op: 'shot.generate' as const, shotIds: [shotId] };
    useAssistant.getState().pushDirectorPlan(projectId, 'Generate this shot', 'Here is the price. Nothing runs until you approve it.', { scope: { kind: 'shot', shotId }, items: [{ op, paid: true, summary: describeDirectorOp(op, directorNames(studio, timeline)) }] }, scopeLabel(studio, { kind: 'shot', shotId }));
    setAsk({ key: shotId, scope: { kind: 'shot', shotId } });
  };
  const askClip = async (clipId: string) => {
    const clip = timeline.clips.find((c) => c.id === clipId);
    if (!clip) return;
    try {
      const r = await api<{ shotId: string; versionId: string }>(`/api/projects/${projectId}/shots/from-clip`, { body: { assetId: clip.assetId, label: clip.label } });
      apply((t) => ({ ...t, clips: t.clips.map((c) => (c.assetId === clip.assetId && !c.shotId ? { ...c, shotId: r.shotId, versionId: r.versionId } : c)) }));
      await refetch();
      setAsk({ key: r.shotId, scope: { kind: 'shot', shotId: r.shotId } });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not prepare this clip');
    }
  };

  let movieIndex = 0;
  return (
    <div className="relative h-full overflow-y-auto p-3" data-testid="storyboard">
      <div className="space-y-4">
        {groups.map((g, gi) => {
          const scene = g.sceneId ? studio?.scenes.find((s) => s.id === g.sceneId) : null;
          const sceneNo = scene ? (studio?.scenes.findIndex((s) => s.id === scene.id) ?? 0) + 1 : 0;
          return (
            <section key={`${g.sceneId ?? 'clips'}-${gi}`} aria-label={scene ? `Scene ${sceneNo}` : 'Clips'}>
              {scene && (
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-md bg-iris-500/20 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-iris-100">SCENE {sceneNo}</span>
                  <span className="truncate text-sm font-medium text-white">{scene.title}</span>
                  {scene.synopsis && <span className="hidden truncate text-xs text-fog-500 md:inline">{scene.synopsis}</span>}
                  <button type="button" onClick={() => setAsk({ key: `scene:${scene.id}`, scope: { kind: 'scene', sceneId: scene.id } })} className="ml-auto flex shrink-0 items-center gap-1 rounded-lg bg-iris-500/15 px-2 py-1 text-[11px] text-iris-100 hover:bg-iris-500/30"><Sparkles className="size-3" /> Ask AI</button>
                </div>
              )}
              {ask?.key === `scene:${scene?.id}` && (
                <div className="mb-2">
                  <AskCard deps={deps} scope={ask.scope} onClose={() => setAsk(null)} />
                </div>
              )}
              <ol className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                {g.entries.map((e) => {
                  const shot = e.shotId ? model.byId.get(e.shotId) : undefined;
                  const node = model.seq.find((n) => n.key === e.key);
                  const clips = node ? timeline.clips.filter((c) => node.clipIds.includes(c.id)) : [];
                  const first = clips[0];
                  const i = e.planned ? -1 : movieIndex++;
                  const state = shotState(shot);
                  const asset = first ? assets.get(first.assetId) : undefined;
                  const av = shot ? activeVersion(shot) : null;
                  const media = asset?.url ?? av?.media?.url;
                  const thumb = (asset?.thumbnailUrl ?? av?.media?.thumbnailUrl ?? shot?.storyboardUrl) || undefined;
                  const isVideo = first && (asset ? asset.mediaType === 'video' : Boolean(media));
                  const len = clips.length ? clips.reduce((s, c) => s + clipDuration(c), 0) : (shot?.durationSec ?? 0);
                  const running = ['queued', 'generating', 'editing'].includes(state.key);
                  const selected = Boolean(first && node?.clipIds.includes(selectedClipId ?? ''));
                  return (
                    <li
                      key={e.key}
                      draggable={!e.planned}
                      onDragStart={(ev) => {
                        if (e.planned) return;
                        setDrag(e.key);
                        ev.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragOver={(ev) => {
                        if (!drag || drag === e.key || e.planned) return;
                        ev.preventDefault();
                        setOver(e.key);
                      }}
                      onDragLeave={() => setOver((o) => (o === e.key ? null : o))}
                      onDrop={(ev) => {
                        ev.preventDefault();
                        if (drag && drag !== e.key && !e.planned) {
                          const from = model.seq.findIndex((x) => x.key === drag);
                          const to = model.seq.findIndex((x) => x.key === e.key);
                          const after = from < to ? e.key : (model.seq[to - 1]?.key ?? null);
                          apply((t) => moveNodeAfter(t, drag, after));
                        }
                        setDrag(null);
                        setOver(null);
                      }}
                      onDragEnd={() => {
                        setDrag(null);
                        setOver(null);
                      }}
                      className={cn('group relative overflow-hidden rounded-xl border bg-ink-900/70 transition', selected ? 'border-iris-400' : e.planned ? 'border-dashed border-white/20' : 'hairline hover:border-white/25', over === e.key && 'ring-2 ring-iris-400', drag === e.key && 'opacity-40')}
                      data-testid="story-card"
                    >
                      <button type="button" onClick={() => (first ? onPlay(first.id) : setAsk({ key: e.key, scope: { kind: 'shot', shotId: e.shotId! } }))} className="block w-full text-left" title={first ? 'Play from this shot' : 'Ask the AI Director about this shot'}>
                        <div className="relative aspect-video bg-black">
                          {isVideo && media ? (
                            <video src={`${media}#t=${(first.reverse ? first.outSec - 0.05 : first.inSec + 0.05).toFixed(2)}`} preload="metadata" muted playsInline poster={first.inSec < 0.2 ? thumb : undefined} className="pointer-events-none size-full object-cover" style={{ filter: gradeCss(first.adjust as Record<string, unknown> | undefined) }} />
                          ) : thumb ? (
                            <img src={thumb} alt="" loading="lazy" className="size-full object-cover" />
                          ) : (
                            <div className="grid size-full place-items-center bg-[radial-gradient(circle_at_30%_20%,rgba(139,124,246,0.22),transparent_60%)] text-[10px] text-fog-500"><span className="flex flex-col items-center gap-1"><Clapperboard className="size-5" /> Not generated yet</span></div>
                          )}
                          <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">{e.planned ? 'PLANNED' : String(i + 1).padStart(2, '0')}</span>
                          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">{seconds(len)}</span>
                          <span className={cn('absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium', state.tone)}>{running && <Loader2 className="size-3 animate-spin" />}{state.label}</span>
                          {first && <span className="absolute inset-0 grid place-items-center opacity-0 transition group-hover:opacity-100"><Play className="size-7 rounded-full bg-black/60 p-1.5 text-white" /></span>}
                        </div>
                        <div className="px-2.5 pb-1 pt-2">
                          <div className="line-clamp-2 text-xs text-fog-100">{shot?.description || first?.label || (first && assets.get(first.assetId)?.originalName) || `Shot ${i + 1}`}</div>
                          {shot && shot.versions.length > 1 && <div className="mt-0.5 text-[10px] text-fog-500">{shot.versions.length} versions</div>}
                        </div>
                      </button>
                      <div className="flex items-center justify-between px-1.5 pb-1.5">
                        {e.planned ? <span className="p-1" /> : <span className="cursor-grab p-1 text-fog-500" title="Drag to reorder" aria-hidden><GripVertical className="size-3.5" /></span>}
                        <span className="flex items-center gap-0.5">
                          <button type="button" onClick={() => (e.shotId ? setAsk({ key: e.key, scope: { kind: 'shot', shotId: e.shotId } }) : first && void askClip(first.id))} className="flex items-center gap-1 rounded-md bg-iris-500/15 px-1.5 py-1 text-[11px] text-iris-100 hover:bg-iris-500/30"><Sparkles className="size-3" /> Ask AI</button>
                          {e.planned && e.shotId ? (
                            <button type="button" onClick={() => generatePlan(e.shotId!)} title="Generate this shot (price first)" className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fog-300 hover:bg-white/[0.06] hover:text-white"><Film className="size-3" /> Generate</button>
                          ) : first ? (
                            <button type="button" onClick={() => onOpenShot(first.id)} title="Open this shot (versions, AI fixes, camera, colour)" className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fog-300 hover:bg-white/[0.06] hover:text-white"><Crosshair className="size-3" /> Open</button>
                          ) : null}
                          {!e.planned && (
                            <button type="button" disabled={model.seq.length < 2} onClick={() => apply((t) => removeNode(t, e.key))} title="Take out of the video (media and versions are kept)" aria-label="Remove shot from video" className="grid size-6 place-items-center rounded-md text-fog-400 hover:bg-white/[0.06] hover:text-signal-red disabled:opacity-30"><Trash2 className="size-3" /></button>
                          )}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
              {ask && g.entries.some((e) => e.key === ask.key || e.shotId === ask.key) && (
                <div className="mt-2">
                  <AskCard deps={deps} scope={ask.scope} onClose={() => setAsk(null)} />
                </div>
              )}
            </section>
          );
        })}
        <button type="button" onClick={onAdd} className="grid aspect-[5/1] w-full max-w-xs place-items-center rounded-xl border border-dashed hairline text-xs text-fog-400 hover:border-white/30 hover:text-white">
          <span className="flex items-center gap-1.5"><Plus className="size-4" /> Add a clip</span>
        </button>
      </div>
    </div>
  );
}
