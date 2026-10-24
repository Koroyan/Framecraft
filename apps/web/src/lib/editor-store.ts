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
  dirty: boolean;
  load: (t: Timeline) => void;
  /** Apply a change as one undoable step. */
  apply: (fn: (t: Timeline) => Timeline) => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  markSaved: () => void;
};

export const useEditor = create<State>((set, get) => ({
  timeline: null,
  past: [],
  future: [],
  selected: null,
  dirty: false,
  load: (t) => set({ timeline: t, past: [], future: [], dirty: false, selected: t.clips[0]?.id ?? null }),
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
  select: (id) => set({ selected: id }),
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

export function moveClip(t: Timeline, clipId: string, dir: -1 | 1): Timeline {
  const i = t.clips.findIndex((c) => c.id === clipId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= t.clips.length) return t;
  [t.clips[i], t.clips[j]] = [t.clips[j]!, t.clips[i]!];
  return t;
}

export const newId = (prefix: string) => `${prefix}-${uid()}`;
