'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/*
 * Editor workspace layout: which panels are open, their sizes and where the assistant is docked.
 * Remembered per browser (a viewer convenience), restored on reload.
 */

export type AssistantDock = 'right' | 'bottom' | 'float';
export type FloatRect = { x: number; y: number; w: number; h: number };

type Layout = {
  /** Tool panel next to the icon rail (the rail itself always stays). */
  leftOpen: boolean;
  leftWidth: number;
  inspectorOpen: boolean;
  inspectorWidth: number;
  timelineHeight: number;
  /** false = minimised to the floating "Assistant" button; the conversation is kept. */
  assistantOpen: boolean;
  assistantDock: AssistantDock;
  assistantWidth: number;
  assistantHeight: number;
  assistantFloat: FloatRect;
};

type UiState = Layout & {
  set: (patch: Partial<Layout>) => void;
  toggleAssistant: () => void;
  reset: () => void;
};

export const DEFAULT_LAYOUT: Layout = {
  leftOpen: true,
  leftWidth: 264,
  inspectorOpen: true,
  inspectorWidth: 320,
  timelineHeight: 260,
  assistantOpen: false,
  assistantDock: 'right',
  assistantWidth: 360,
  assistantHeight: 280,
  assistantFloat: { x: -1, y: -1, w: 380, h: 520 },
};

export const LIMITS = {
  leftWidth: [200, 420],
  inspectorWidth: [260, 520],
  timelineHeight: [150, 640],
  assistantWidth: [300, 640],
  assistantHeight: [180, 560],
} as const;

export const clampTo = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Math.round(v)));

export const useEditorUi = create<UiState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_LAYOUT,
      set: (patch) => set(patch),
      toggleAssistant: () => set({ assistantOpen: !get().assistantOpen }),
      reset: () => set(DEFAULT_LAYOUT),
    }),
    {
      name: 'fc-editor-layout',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ set: _s, toggleAssistant: _t, reset: _r, ...layout }) => {
        void _s;
        void _t;
        void _r;
        return layout;
      },
    },
  ),
);
