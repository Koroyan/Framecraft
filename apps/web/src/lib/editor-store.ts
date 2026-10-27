'use client';

import { create } from 'zustand';
import { clipDuration, type Timeline, type TimelineClip } from '@framecraft/shared';

const MAX_HISTORY = 100;
const uid = () => Math.random().toString(36).slice(2, 10);

type State = {
  timeline: Timeline | null;
  past: Timeline[];
  future: Timeline[];
  selected: string | null;
  /** Further clips selected with Shift/Ctrl-click (batch edits); the primary one is `selected`. */
  extra: string[];
  dirty: boolean;
  load: (t: Timeline) => void;
  /** Apply a change as one undoable step. */
  apply: (fn: (t: Timeline) => Timeline) => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  /** Add or remove a clip from the multi-selection (Shift/Ctrl-click). */
  toggleExtra: (id: string) => void;
  clearExtra: () => void;
  markSaved: () => void;
};

export const useEditor = create<State>((set, get) => ({
  timeline: null,
  past: [],
  future: [],
  selected: null,
  extra: [],
  dirty: false,
  load: (t) => set({ timeline: t, past: [], future: [], dirty: false, selected: t.clips[0]?.id ?? null, extra: [] }),
  apply: (fn) => {
    const cur = get().timeline;
    if (!cur) return;
    const next = fn(structuredClone(cur));
    set({ timeline: next, past: [...get().past, cur].slice(-MAX_HISTORY), future: [], dirty: true });
  },
  undo: () => {
    const { past, timeline, future } = get();
    if (!past.length || !timeline) return;
    set({ timeline: past[past.length - 1]!, past: past.slice(0, -1), future: [timeline, ...future], dirty: true });
  },
  redo: () => {
    const { past, timeline, future } = get();
    if (!future.length || !timeline) return;
    set({ timeline: future[0]!, future: future.slice(1), past: [...past, timeline], dirty: true });
  },
  select: (id) => set({ selected: id, extra: [] }),
  toggleExtra: (id) => {
    const { selected, extra } = get();
    if (!selected) return set({ selected: id });
    if (id === selected) return;
    set({ extra: extra.includes(id) ? extra.filter((x) => x !== id) : [...extra, id] });
  },
  clearExtra: () => set({ extra: [] }),
  markSaved: () => set({ dirty: false }),
}));

// ------------------------------------------------------------------ pure timeline operations

/** Length on the timeline (speed and freeze frames included). */
export const clipLen = (c: TimelineClip) => clipDuration(c);

export function clipStarts(t: Timeline): number[] {
  const starts: number[] = [];
  let acc = 0;
  t.clips.forEach((c, i) => {
    starts.push(acc);
    acc += clipLen(c);
    const tr = c.transition;
    if (tr && tr.type !== 'cut' && i < t.clips.length - 1) acc -= tr.durationSec;
  });
  return starts;
}

export function splitClip(t: Timeline, clipId: string, atSourceSec: number): Timeline {
  const i = t.clips.findIndex((c) => c.id === clipId);
  const c = t.clips[i];
  if (!c || atSourceSec <= c.inSec + 0.2 || atSourceSec >= c.outSec - 0.2) return t;
  const a = { ...c, outSec: atSourceSec, transition: undefined };
  const b = { ...c, id: `clip-${uid()}`, inSec: atSourceSec };
  t.clips.splice(i, 1, a, b);
  return t;
}

/**
 * Split at the playhead (timeline seconds): the preferred (selected) clip if the playhead is inside
 * it, otherwise whichever clip is under the playhead — never a silent no-op because the selection
 * is elsewhere.
 */
export function splitAtPlayhead(t: Timeline, playhead: number, preferId?: string | null): Timeline {
  const starts = clipStarts(t);
  const inside = (k: number) => k >= 0 && k < t.clips.length && playhead > (starts[k] ?? 0) + 0.05 && playhead < (starts[k] ?? 0) + clipLen(t.clips[k]!) - 0.05;
  let i = t.clips.findIndex((c) => c.id === preferId);
  if (!inside(i)) i = t.clips.map((_, k) => k).filter(inside).pop() ?? -1;
  if (i < 0) return t;
  const c = t.clips[i]!;
  return splitClip(t, c.id, c.inSec + (playhead - (starts[i] ?? 0)) * (c.freezeSec ? 0 : c.speed || 1));
}

/** The first layer track (from `from` up) with nothing between start and end — so new texts and stickers never pile up on each other. */
export function freeTrack(t: Timeline, start: number, end: number, from: number): number {
  for (let tr = from; tr < from + 12; tr++) if (!t.layers.some((l) => l.track === tr && l.startSec < end - 0.01 && l.endSec > start + 0.01)) return tr;
  return from + 12;
}

export function moveClip(t: Timeline, clipId: string, dir: -1 | 1): Timeline {
  const i = t.clips.findIndex((c) => c.id === clipId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= t.clips.length) return t;
  [t.clips[i], t.clips[j]] = [t.clips[j]!, t.clips[i]!];
  return t;
}

export const newId = (prefix: string) => `${prefix}-${uid()}`;
