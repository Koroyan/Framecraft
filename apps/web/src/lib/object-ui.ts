'use client';

import { create } from 'zustand';

/* Which object is selected in the preview, and what the object tool is doing. Not persisted. */

export type ObjectRef = { clipId: string; objectId: string };

type State = {
  /** Click-to-select mode is on (clicks on the picture select objects). */
  selecting: boolean;
  sel: ObjectRef | null;
  /** Selection tightness (scales the automatic edge threshold). */
  tightness: number;
  tracking: string | null;
  /** Which toolbar popover is open. */
  popover: 'color' | 'adjust' | 'blur' | 'ai' | 'refine' | 'scope' | null;
  /** AI edit dialog for the selected object (mode), or null. */
  ai: 'remove' | 'replace' | 'fix' | 'restyle' | 'relight' | null;
  set: (patch: Partial<Omit<State, 'set'>>) => void;
};

export const useObjectUi = create<State>((set) => ({
  selecting: false,
  sel: null,
  tightness: 1,
  tracking: null,
  popover: null,
  ai: null,
  set: (patch) => set(patch),
}));

/**
 * The shape the preview last found for objects that follow shape changes (normalised source
 * outline at source second `t`), so the dashed selection line hugs what is really being changed.
 */
export type FoundOutline = { t: number; polys: [number, number][][] };

export const useFoundOutlines = create<{ byId: Record<string, FoundOutline>; put: (id: string, f: FoundOutline | null) => void }>((set) => ({
  byId: {},
  put: (id, f) =>
    set((st) => {
      const byId = { ...st.byId };
      if (f) byId[id] = f;
      else delete byId[id];
      return { byId };
    }),
}));
