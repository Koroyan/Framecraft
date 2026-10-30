'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Clapperboard, Copy, Crosshair, Film, GripVertical, Loader2, Network, Play, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { clipDuration, describeDirectorOp, moveNodeAfter, removeNode, type DirectorScope, type Timeline } from '@framecraft/shared';
import { gradeCss } from '@/lib/looks';
import { api, ApiError, type Asset } from '@/lib/api';
import { directorKey, useAssistant } from '@/lib/assistant';
import { directorNames, scopeLabel, shotState, storyModel } from '@/lib/director';
import { activeVersion, type StudioData } from '@/lib/studio';
import { cn, seconds } from '@/lib/utils';
import { AskCard, type DirectorDeps } from './director-chat';
import { PlacePicker } from './graph/details';

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
  /** Project title for the header. */
  title?: string;
  onOpenGraph?: () => void;
};

const clock = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

export function Storyboard({ projectId, timeline, assets, studio, apply, refetch, selectedClipId, onPlay, onOpenShot, onAdd, title, onOpenGraph }: Props) {
  const model = useMemo(() => storyModel(studio, timeline), [studio, timeline]);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ key: string; scope: DirectorScope } | null>(null);
  // The card whose details show in the side panel.
  const [picked, setPicked] = useState<string | null>(null);
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

  // Length of each card (as it plays, or as planned) and where each scene starts.
  const lenOf = (key: string) => {
    const node = model.seq.find((n) => n.key === key);
    if (node) return timeline.clips.filter((c) => node.clipIds.includes(c.id)).reduce((s, c) => s + clipDuration(c), 0);
    const sid = model.order.find((e) => e.key === key)?.shotId;
    return sid ? (model.byId.get(sid)?.durationSec ?? 0) : 0;
  };
  const total = model.order.reduce((s, e) => s + (e.planned ? 0 : lenOf(e.key)), 0);
  const planned = model.order.filter((e) => e.planned).length;
  const sceneCount = groups.filter((g) => g.sceneId).length;

  const pick = model.order.find((e) => e.key === picked) ?? null;
  const pickShot = pick?.shotId ? model.byId.get(pick.shotId) : undefined;
  const pickNode = pick ? model.seq.find((n) => n.key === pick.key) : undefined;
  const pickFirst = pickNode ? timeline.clips.find((c) => c.id === pickNode.clipIds[0]) : undefined;
  const pickAsset = pickFirst ? assets.get(pickFirst.assetId) : undefined;
  const pickAv = pickShot ? activeVersion(pickShot) : null;
  const pickThumb = (pickAsset?.thumbnailUrl ?? pickAv?.media?.thumbnailUrl ?? pickShot?.storyboardUrl) || undefined;
  const at = pickNode ? model.seq.findIndex((n) => n.key === pickNode.key) : -1;
  const storyOps = async (ops: unknown[], ok: string) => {
    try {
      await api(`/api/projects/${projectId}/director/apply`, { body: { ops, scope: { kind: 'project' } } });
      await refetch();
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not do that');
    }
  };
  const move = (dir: -1 | 1) => {
    if (!pickNode || at < 0) return;
    const after = dir < 0 ? (model.seq[at - 2]?.key ?? null) : (model.seq[at + 1]?.key ?? null);
    if (dir > 0 && !model.seq[at + 1]) return;
    apply((t) => moveNodeAfter(t, pickNode.key, after));
  };
  const duplicate = () => {
    if (pickShot) {
      void storyOps([{ op: 'shot.insert', ref: 'new1', sceneId: pickShot.sceneId, afterShotId: pickShot.id, shot: { description: pickShot.description, prompt: pickShot.prompt, durationSec: Math.min(30, Math.max(2, pickShot.durationSec)), characterIds: pickShot.characterIds, dialogue: pickShot.dialogue } }], 'Copied as a new planned shot');
    } else if (pickNode) {
      apply((t) => {
        const own = t.clips.filter((c) => pickNode.clipIds.includes(c.id));
        const last = t.clips.findIndex((c) => c.id === pickNode.clipIds.at(-1));
        const clips = [...t.clips];
        clips.splice(last + 1, 0, ...own.map((c) => ({ ...c, id: `${c.id}-copy-${Math.random().toString(36).slice(2, 6)}`, transition: undefined })));
        return { ...t, clips };
      });
    }
  };
  const remove = () => {
    if (!pick) return;
    if (pick.planned && pick.shotId) void storyOps([{ op: 'shot.remove', shotId: pick.shotId }], 'Planned shot deleted');
    else apply((t) => removeNode(t, pick.key));
    setPicked(null);
  };
  const improve = () => {
    if (!pick?.shotId) return;
    const scope: DirectorScope = { kind: 'shot', shotId: pick.shotId };
    useAssistant.getState().setDirectorDraft(projectId, directorKey(scope), 'Improve this shot\'s prompt: clearer action, framing and light — keep the story the same');
    setAsk({ key: pick.key, scope });
  };

  let movieIndex = 0;
  let clockAt = 0;
  return (
    <div className="flex h-full min-h-0" data-testid="storyboard">
    <div className="relative min-h-0 flex-1 overflow-y-auto p-4">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-iris-400">Storyboard · {sceneCount ? `${sceneCount} scene${sceneCount === 1 ? '' : 's'} · ` : ''}{model.order.length} shot{model.order.length === 1 ? '' : 's'}</div>
          {title && <h2 className="mt-1 truncate text-2xl font-semibold text-white md:text-3xl">{title}</h2>}
          <p className="mt-1 text-xs text-fog-400">
            <span className="rounded-md bg-signal-green/10 px-1.5 py-0.5 text-signal-green">{seconds(total)} total</span> · order and length are shared with the graph and the timeline{planned ? ` · ${planned} planned` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          {timeline.clips[0] && (
            <button type="button" onClick={() => onPlay(timeline.clips[0]!.id)} className="flex items-center gap-1.5 rounded-xl border hairline bg-ink-850 px-3 py-2 text-xs font-medium text-white hover:bg-ink-700"><Play className="size-3.5" /> Play all · {seconds(total)}</button>
          )}
          {onOpenGraph && (
            <button type="button" onClick={onOpenGraph} className="flex items-center gap-1.5 rounded-xl bg-iris-500 px-3 py-2 text-xs font-medium text-white shadow-glow hover:bg-iris-400"><Network className="size-3.5" /> Open Story Graph</button>
          )}
        </div>
      </header>
      <div className="space-y-6">
        {groups.map((g, gi) => {
          const scene = g.sceneId ? studio?.scenes.find((s) => s.id === g.sceneId) : null;
          const sceneNo = scene ? (studio?.scenes.findIndex((s) => s.id === scene.id) ?? 0) + 1 : 0;
          const from = clockAt;
          const len = g.entries.reduce((s, e) => s + (e.planned ? 0 : lenOf(e.key)), 0);
          clockAt += len;
          return (
            <section key={`${g.sceneId ?? 'clips'}-${gi}`} aria-label={scene ? `Scene ${sceneNo}` : 'Clips'}>
              {scene && (
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="rounded-lg border border-iris-400/40 px-2 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-iris-300">SCENE {sceneNo}</span>
                  <span className="truncate text-base font-semibold text-white">{scene.title}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-fog-400">{clock(from)}–{clock(from + len)} · {seconds(len)}</span>
                  {scene.synopsis && <span className="hidden truncate text-xs text-fog-500 md:inline">{scene.synopsis}</span>}
                  <button type="button" onClick={() => setAsk({ key: `scene:${scene.id}`, scope: { kind: 'scene', sceneId: scene.id } })} className="ml-auto flex shrink-0 items-center gap-1 rounded-lg bg-iris-500/15 px-2 py-1 text-[11px] text-iris-100 hover:bg-iris-500/30"><Sparkles className="size-3" /> Ask AI</button>
                </div>
              )}
              {ask?.key === `scene:${scene?.id}` && (
                <div className="mb-2">
                  <AskCard deps={deps} scope={ask.scope} onClose={() => setAsk(null)} />
                </div>
              )}
              <ol className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
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
                  const selected = picked ? picked === e.key : Boolean(first && node?.clipIds.includes(selectedClipId ?? ''));
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
                      className={cn('group relative overflow-hidden rounded-2xl border bg-ink-900 transition', selected ? 'border-iris-400 ring-2 ring-iris-500/30' : e.planned ? 'border-dashed border-white/20' : 'hairline hover:border-white/25', over === e.key && 'ring-2 ring-iris-400', drag === e.key && 'opacity-40')}
                      data-testid="story-card"
                    >
                      <button type="button" onClick={() => { setPicked(e.key); if (first) onPlay(first.id); }} className="block w-full text-left" title="Show this shot's details">
                        <div className="relative aspect-video bg-black">
                          {isVideo && media ? (
                            <video src={`${media}#t=${(first.reverse ? first.outSec - 0.05 : first.inSec + 0.05).toFixed(2)}`} preload="metadata" muted playsInline poster={first.inSec < 0.2 ? thumb : undefined} className="pointer-events-none size-full object-cover" style={{ filter: gradeCss(first.adjust as Record<string, unknown> | undefined) }} />
                          ) : thumb ? (
                            <img src={thumb} alt="" loading="lazy" className="size-full object-cover" />
                          ) : (
                            <div className="grid size-full place-items-center bg-[radial-gradient(circle_at_30%_20%,rgba(139,124,246,0.22),transparent_60%)] text-[10px] text-fog-500"><span className="flex flex-col items-center gap-1"><Clapperboard className="size-5" /> Not generated yet</span></div>
                          )}
                          <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">{e.planned ? 'PLANNED' : `SHOT ${i + 1}`}</span>
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
    {pick && (
      <aside className="hidden w-[300px] shrink-0 flex-col overflow-y-auto border-l hairline bg-ink-900/80 p-4 lg:flex" aria-label="Shot details" data-testid="shot-panel">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fog-400">{pick.planned ? 'Planned shot' : `Shot ${at + 1}`} · {seconds(lenOf(pick.key))}</div>
            <div className="mt-0.5 line-clamp-2 text-base font-semibold text-white">{pickShot?.description || pickFirst?.label || pickAsset?.originalName || 'Clip'}</div>
          </div>
          <button type="button" aria-label="Close details" onClick={() => setPicked(null)} className="text-fog-400 hover:text-white">×</button>
        </div>
        <div className="mt-3 aspect-video overflow-hidden rounded-xl bg-ink-800">
          {pickThumb ? <img src={pickThumb} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-fog-500"><Clapperboard className="size-6" /></div>}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1.5 text-[11px]">
          <button type="button" disabled={pick.planned || at <= 0} onClick={() => move(-1)} className="flex items-center justify-center gap-1 rounded-lg border hairline py-1.5 text-fog-200 hover:bg-white/[0.05] disabled:opacity-35"><ArrowLeft className="size-3" /> Earlier</button>
          <button type="button" disabled={pick.planned || at < 0 || at >= model.seq.length - 1} onClick={() => move(1)} className="flex items-center justify-center gap-1 rounded-lg border hairline py-1.5 text-fog-200 hover:bg-white/[0.05] disabled:opacity-35">Later <ArrowRight className="size-3" /></button>
          <button type="button" onClick={duplicate} className="flex items-center justify-center gap-1 rounded-lg border hairline py-1.5 text-fog-200 hover:bg-white/[0.05]"><Copy className="size-3" /> Duplicate</button>
          {pickFirst && <button type="button" onClick={() => onOpenShot(pickFirst.id)} className="col-span-2 flex items-center justify-center gap-1 rounded-lg border hairline py-1.5 text-fog-200 hover:bg-white/[0.05]"><Crosshair className="size-3" /> Open in shot editor</button>}
          <button type="button" onClick={remove} disabled={!pick.planned && model.seq.length < 2} className={cn('flex items-center justify-center gap-1 rounded-lg border hairline py-1.5 text-signal-red hover:bg-signal-red/10 disabled:opacity-35', !pickFirst && 'col-span-3')}><Trash2 className="size-3" /> Remove</button>
        </div>
        {pickShot && (
          <div className="mt-3 rounded-xl border hairline bg-ink-850 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fog-400">Shot prompt</div>
            <p className="mt-1.5 line-clamp-6 text-xs leading-relaxed text-fog-200">{pickShot.prompt || pickShot.description}</p>
            <button type="button" onClick={improve} className="mt-2 flex items-center gap-1 text-[11px] text-iris-300 hover:text-white"><Wand2 className="size-3" /> Improve prompt</button>
          </div>
        )}
        {pickShot && studio?.scenes.some((x) => x.id === pickShot.sceneId) && (
          <div className="mt-3">
            <PlacePicker deps={deps} sceneId={pickShot.sceneId} />
          </div>
        )}
        {pickShot && (pickShot.characterIds.length > 0 || pickShot.camera) && (
          <div className="mt-3 flex flex-wrap gap-1 text-[10px] text-fog-300">
            {pickShot.camera && <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5">Camera: {pickShot.camera.replaceAll('_', ' ')}</span>}
            {pickShot.characterIds.map((cid) => <span key={cid} className="rounded-md bg-iris-500/15 px-1.5 py-0.5 text-iris-200">{studio?.characters.find((c) => c.id === cid)?.name ?? 'Character'}</span>)}
          </div>
        )}
        <div className="mt-auto flex gap-1.5 pt-4">
          <button type="button" onClick={() => (pick.shotId ? setAsk({ key: pick.key, scope: { kind: 'shot', shotId: pick.shotId } }) : pickFirst && void askClip(pickFirst.id))} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-iris-500 py-2 text-xs font-medium text-white hover:bg-iris-400"><Sparkles className="size-3.5" /> Ask AI</button>
          {pick.planned && pick.shotId && <button type="button" onClick={() => generatePlan(pick.shotId!)} className="flex items-center justify-center gap-1 rounded-lg border hairline px-3 py-2 text-xs text-fog-100 hover:bg-white/[0.05]"><Film className="size-3.5" /> Generate</button>}
        </div>
      </aside>
    )}
    </div>
  );
}
