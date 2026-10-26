'use client';

import { create } from 'zustand';
import type { EditMask } from '@framecraft/shared';

/* What the shot editor has selected (shot, seconds, area) — read by the one shared assistant. */
type State = {
  shot: { id: string; number: number; versionId?: string } | null;
  range: { start: number; end: number } | null;
  mask: EditMask | null;
  set: (patch: Partial<Omit<State, 'set'>>) => void;
};

export const useShotContext = create<State>((set) => ({ shot: null, range: null, mask: null, set: (patch) => set(patch) }));
