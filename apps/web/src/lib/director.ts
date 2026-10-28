'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { anchorKeyFor, applyPlanOp, insertShot, isStoryOp, removeNode, sequenceOf, storyOrder, type DirectorEstimate, type DirectorOp, type DirectorQuickContext, type DirectorScope, type QuickShot, type SequenceNode, type StoryEntry, type Timeline } from '@framecraft/shared';
import { api } from '@/lib/api';
import { newId } from '@/lib/editor-store';
import { useAssistant, type ChatMessage } from '@/lib/assistant';
import { activeVersion, type StudioData, type StudioShot } from '@/lib/studio';

/*
 * The AI Director on the client: names and labels for plans, the context for instant answers, and
 * the steps that apply a plan (free story steps on the server, timeline steps in the editor, paid
 * steps only after the user approves their price).
 */

type Apply = (fn: (t: Timeline) => Timeline) => void;

/** Script position of every shot, plus where it is in the movie (1-based, 0 = not in the movie). */
export function storyModel(studio: StudioData | undefined, timeline: Pick<Timeline, 'clips'>) {
  const seq: SequenceNode[] = sequenceOf(timeline);
  const shots = studio?.shots ?? [];
  const sceneIndex = new Map((studio?.scenes ?? []).map((s, i) => [s.id, i]));
  const generated = (s: StudioShot) => s.versions.length > 0;
  const lite = shots.map((s) => ({ id: s.id, sceneIndex: sceneIndex.get(s.sceneId) ?? 0, index: s.index, generated: generated(s) || seq.some((n) => n.shotId === s.id) }));
  const order: StoryEntry[] = storyOrder(seq, lite);
  const movieNo = new Map(seq.flatMap((n, i) => (n.shotId ? [[n.shotId, i + 1] as const] : [])));
  const byId = new Map(shots.map((s) => [s.id, s]));
  return { seq, order, movieNo, byId, sceneIndex };
}

export function shotName(studio: StudioData | undefined, shotId: string): string {
  const s = studio?.shots.find((x) => x.id === shotId);
  if (!s) return shotId.startsWith('new') ? 'the new shot' : 'a shot';
  const scene = (studio?.scenes.findIndex((x) => x.id === s.sceneId) ?? -1) + 1;
  return scene > 0 ? `Scene ${scene} · shot ${s.index + 1}` : `Shot ${s.number}`;
}

export function directorNames(studio: StudioData | undefined, timeline?: Pick<Timeline, 'clips'>) {
  const seq = timeline ? sequenceOf(timeline) : [];
  return {
    movieShot: (n: number) => {
      const node = seq[n - 1];
      return node?.shotId ? shotName(studio, node.shotId) : `clip ${n}`;
    },
    shot: (id: string) => shotName(studio, id),
    scene: (id: string) => {
      const i = studio?.scenes.findIndex((x) => x.id === id) ?? -1;
      return i < 0 ? 'a new scene' : `Scene ${i + 1} (${studio!.scenes[i]!.title})`;
    },
    character: (id: string) => studio?.characters.find((c) => c.id === id)?.name ?? 'someone',
  };
}

export function scopeLabel(studio: StudioData | undefined, scope: DirectorScope): string {
  if (scope.kind === 'project') return 'Whole project';
  if (scope.kind === 'scene') {
    const i = studio?.scenes.findIndex((x) => x.id === scope.sceneId) ?? -1;
    return i < 0 ? 'Scene' : `Scene ${i + 1} — ${studio!.scenes[i]!.title}`;
  }
  if (scope.kind === 'shot') return shotName(studio, scope.shotId);
  const a = scope.fromShotId ? shotName(studio, scope.fromShotId) : 'the start';
  const b = scope.toShotId ? shotName(studio, scope.toShotId) : 'the end';
  return `Between ${a} and ${b}`;
}

/** What the on-device Director needs to understand "this shot", "after this", "between these". */
export function quickContextFor(studio: StudioData | undefined, timeline: Pick<Timeline, 'clips'>, scope: DirectorScope): DirectorQuickContext {
  const m = storyModel(studio, timeline);
  const q = (id: string | null | undefined): QuickShot | undefined => {
    const s = id ? m.byId.get(id) : undefined;
    if (!s) return undefined;
    return { id: s.id, sceneId: s.sceneId, number: m.movieNo.get(s.id) ?? 0, generated: s.versions.length > 0, durationSec: s.durationSec, characterIds: s.characterIds, description: s.description };
  };
  const characters = (studio?.characters ?? []).map((c) => ({ id: c.id, name: c.name, description: c.description }));
  if (scope.kind === 'shot') {
    const at = m.order.findIndex((e) => e.shotId === scope.shotId);
    return { scope, shot: q(scope.shotId), prev: q(m.order[at - 1]?.shotId), next: q(m.order[at + 1]?.shotId), characters };
  }
  if (scope.kind === 'edge') return { scope, prev: q(scope.fromShotId), next: q(scope.toShotId), characters };
  if (scope.kind === 'scene') {
    const inScene = (studio?.shots ?? []).filter((s) => s.sceneId === scope.sceneId).sort((a, b) => a.index - b.index);
    return { scope, sceneLastShotId: inScene.at(-1)?.id ?? null, characters };
  }
  return { scope, characters };
}

export type ShotState = { key: 'draft' | 'storyboard' | 'queued' | 'generating' | 'editing' | 'review' | 'failed' | 'ready' | 'approved'; label: string; tone: string };

/** One status per shot, from the furthest it has come. */
export function shotState(s: StudioShot | undefined): ShotState {
  if (!s) return { key: 'ready', label: 'Your clip', tone: 'bg-white/10 text-fog-100' };
  if (s.operations.some((o) => o.status === 'processing' || o.status === 'queued')) return { key: 'editing', label: 'AI editing', tone: 'bg-iris-500/90 text-white' };
  if (s.status === 'generating') return { key: 'generating', label: 'Generating', tone: 'bg-iris-500/90 text-white' };
  if (s.status === 'queued') return { key: 'queued', label: 'Queued', tone: 'bg-sky-500/80 text-white' };
  if (s.status === 'failed' && !s.versions.length) return { key: 'failed', label: 'Failed', tone: 'bg-signal-red/90 text-white' };
  if (s.operations.some((o) => o.status === 'ready')) return { key: 'review', label: 'Needs review', tone: 'bg-signal-amber text-black' };
  if (s.approved && s.versions.length) return { key: 'approved', label: 'Approved', tone: 'bg-signal-green text-black' };
  if (s.versions.length) return { key: 'ready', label: 'Ready', tone: 'bg-emerald-500/80 text-white' };
  if (s.storyboardUrl) return { key: 'storyboard', label: s.storyboardIsFixture ? 'Frame (placeholder)' : 'Storyboard ready', tone: 'bg-white/15 text-white' };
  return { key: 'draft', label: 'Draft', tone: 'bg-white/10 text-fog-200' };
}

const resolve = (id: string, created: Record<string, string>) => created[id] ?? id;
/** A paid step written before its new shot existed now points at the real shot. */
export function resolveRefs(op: DirectorOp, created: Record<string, string>): DirectorOp {
  if (op.op === 'storyboard.generate' || op.op === 'shot.generate') return { ...op, shotIds: op.shotIds.map((id) => resolve(id, created)) };
  if (op.op === 'shot.update') return { ...op, shotId: resolve(op.shotId, created) };
  return op;
}
export const hasUnresolvedRefs = (op: DirectorOp) => (op.op === 'storyboard.generate' || op.op === 'shot.generate' ? op.shotIds.some((id) => id.startsWith('new')) : false);

/** Shots taken out of the movie are remembered, so they are not put back automatically. */
export async function rememberRemoved(projectId: string, studio: StudioData | undefined, shotIds: string[], back = false) {
  const prev = new Set(studio?.removed ?? []);
  for (const id of shotIds) {
    if (back) prev.delete(id);
    else prev.add(id);
  }
  await api(`/api/projects/${projectId}/graph`, { method: 'PUT', body: { removed: [...prev] } }).catch(() => undefined);
}

/**
 * Apply the free steps of a plan (by index): story steps in one server transaction, then timeline
 * steps in the editor (one undoable change). Paid steps are left for their own approval.
 */
export async function applyFreeSteps(projectId: string, msg: ChatMessage, idx: number[], deps: { apply: Apply; studio: StudioData | undefined; refetch: () => unknown }) {
  const d = msg.director!;
  const chosen = idx.filter((i) => !d.items[i]!.blocked && !d.items[i]!.paid);
  const story = chosen.map((i) => d.items[i]!.op).filter(isStoryOp);
  const timelineOps = chosen.flatMap((i) => (d.items[i]!.op.op === 'timeline' ? [(d.items[i]!.op as Extract<DirectorOp, { op: 'timeline' }>).plan] : []));
  let res: { created: Record<string, string>; undo: DirectorOp[]; leaveMovie: string[] } = { created: {}, undo: [], leaveMovie: [] };
  if (story.length) res = await api(`/api/projects/${projectId}/director/apply`, { body: { ops: story, scope: d.scope } });
  if (timelineOps.length || res.leaveMovie.length) {
    deps.apply((t) => {
      let x = t;
      for (const op of timelineOps) x = applyPlanOp(x, op, () => newId('clip'));
      for (const sid of res.leaveMovie) {
        const node = sequenceOf(x).find((n) => n.shotId === sid);
        if (node) x = removeNode(x, node.key);
      }
      return x;
    });
  }
  if (res.leaveMovie.length) await rememberRemoved(projectId, deps.studio, res.leaveMovie);
  useAssistant.getState().setStates(projectId, msg.id, chosen, 'applied');
  useAssistant.getState().patchMessage(projectId, msg.id, (m) => ({ ...m, director: { ...m.director!, created: { ...m.director!.created, ...res.created }, undo: [...res.undo, ...(m.director!.undo ?? [])] } }));
  await deps.refetch();
}

/** Put the story back (timeline steps are undone with the editor's own Undo). */
export async function undoFreeSteps(projectId: string, msg: ChatMessage, refetch: () => unknown) {
  const undo = msg.director?.undo ?? [];
  if (undo.length) await api(`/api/projects/${projectId}/director/apply`, { body: { ops: undo, scope: { kind: 'project' } } });
  useAssistant.getState().patchMessage(projectId, msg.id, (m) => ({ ...m, director: { ...m.director!, undo: [], undone: true }, states: m.states?.map((s) => (s === 'applied' ? 'cancelled' : s)) }));
  await refetch();
}

export async function priceOf(projectId: string, op: DirectorOp): Promise<{ estimate: DirectorEstimate | null; blocked?: string }> {
  const r = await api<{ estimates: { estimate: DirectorEstimate | null; blocked?: string }[] }>(`/api/projects/${projectId}/director/estimate`, { body: { ops: [op] } });
  return r.estimates[0] ?? { estimate: null };
}

/** Run one paid step at the price the user approved. */
export async function runPaidStep(projectId: string, msg: ChatMessage, i: number, op: DirectorOp, credits: number, refetch: () => unknown) {
  await api(`/api/projects/${projectId}/director/run`, { body: { op, approvedCredits: credits, idempotencyKey: `dir-${msg.id}-${i}-${credits}` } });
  useAssistant.getState().setStates(projectId, msg.id, [i], 'started');
  await refetch();
}

/**
 * A shot generated while you work joins the movie where the script puts it (once). Shots you took
 * out of the movie, and shots that were outside it before this session, are left alone.
 */
export function useAutoInsertShots(studio: StudioData | undefined, timeline: Timeline | null | undefined, apply: Apply) {
  const planned = useRef(new Set<string>());
  useEffect(() => {
    if (!studio || !timeline) return;
    const seq = sequenceOf(timeline);
    const fresh = studio.shots.filter((s) => s.versions.length && planned.current.has(s.id) && !seq.some((n) => n.shotId === s.id) && !studio.removed.includes(s.id));
    for (const s of studio.shots) if (!s.versions.length) planned.current.add(s.id);
    if (!fresh.length) return;
    const sceneIndex = new Map(studio.scenes.map((s, i) => [s.id, i]));
    const lite = studio.shots.map((s) => ({ id: s.id, sceneIndex: sceneIndex.get(s.sceneId) ?? 0, index: s.index, generated: s.versions.length > 0 }));
    for (const s of fresh) planned.current.delete(s.id);
    apply((t) => {
      let x = t;
      for (const s of fresh) {
        const v = activeVersion(s);
        if (!v) continue;
        x = insertShot(x, { shotId: s.id, assetId: v.assetId, versionId: v.id, durationSec: v.media?.durationSec ?? s.durationSec, label: s.description.slice(0, 120) }, anchorKeyFor(s.id, sequenceOf(x), lite), newId('clip'));
      }
      return x;
    });
    toast.success(fresh.length === 1 ? 'A new shot is ready — it is now in the movie' : `${fresh.length} new shots are ready — now in the movie`);
  }, [studio, timeline, apply]);
}
