'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { quickPlan, type EditMask } from '@framecraft/shared';
import { api, ApiError } from '@/lib/api';
import type { CopilotReply, PlanItem } from '@/lib/studio';

/*
 * The editing assistant's state lives here, not in a component: hiding, docking or moving the panel
 * never resets the conversation, never erases the draft and never cancels a request in flight.
 * Threads are kept per project in this browser (restored after a reload).
 */

/** What the user has selected right now — "this" in a request means this. */
export type AssistantContext = {
  clip?: { id: string; index: number; label: string; shotId?: string; versionId?: string };
  /** Selected stretch of the movie (timeline seconds) — "this part". */
  range?: { start: number; end: number };
  /** The same stretch on the selected clip's own clock (what AI edits use), when it lies inside one clip. */
  srcRange?: { start: number; end: number };
  object?: { id: string; name: string; mask: EditMask };
  /** An area drawn in the shot editor (not an object edit): limits AI edits to it. */
  mask?: EditMask;
  layer?: { id: string; name: string };
  playhead?: number;
  /** Several clips selected (Shift/Ctrl-click): "these clips". */
  clips?: { id: string; index: number }[];
};

export type ItemState = 'proposed' | 'previewing' | 'applied' | 'cancelled' | 'started';
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  plan?: PlanItem[];
  states?: ItemState[];
  /** Answered on this device without an AI call (free, instant). */
  local?: boolean;
  /** Human summary of the selection the request used. */
  scope?: string;
  error?: boolean;
};

type Thread = { msgs: ChatMessage[]; draft: string; useSelection: boolean };
const EMPTY: Thread = { msgs: [], draft: '', useSelection: true };

type State = {
  threads: Record<string, Thread>;
  /** Not persisted: requests in flight per project. */
  busy: Record<string, boolean>;
  unread: Record<string, number>;
  thread: (projectId: string) => Thread;
  setDraft: (projectId: string, draft: string) => void;
  setUseSelection: (projectId: string, v: boolean) => void;
  setStates: (projectId: string, msgId: string, idx: number[], s: ItemState) => void;
  clear: (projectId: string) => void;
  markRead: (projectId: string) => void;
  send: (projectId: string, message: string, o: { context: AssistantContext; timeline: unknown; visible: boolean; contextLabel?: string }) => Promise<void>;
};

const uid = () => Math.random().toString(36).slice(2, 10);
const MAX_MSGS = 80;
const MAX_THREADS = 30;

/** Human words for the current selection, shown above the input and stored with the request. */
export function describeContext(c: AssistantContext): string {
  const parts: string[] = [];
  if (c.clips && c.clips.length > 1) parts.push(`Clips ${c.clips.map((x) => x.index + 1).sort((a, b) => a - b).join(', ')}`);
  else if (c.clip) parts.push(`Clip ${c.clip.index + 1}`);
  if (c.object) parts.push(c.object.name);
  if (c.range) parts.push(`${c.range.start.toFixed(1)}–${c.range.end.toFixed(1)} s`);
  else if (c.srcRange) parts.push(`${c.srcRange.start.toFixed(1)}–${c.srcRange.end.toFixed(1)} s of the shot`);
  if (c.mask && !c.object) parts.push('selected area');
  if (c.layer) parts.push(c.layer.name);
  return parts.join(' · ');
}

export const useAssistant = create<State>()(
  persist(
    (set, get) => {
      const patch = (projectId: string, fn: (t: Thread) => Thread) => {
        const threads = { ...get().threads, [projectId]: fn(get().threads[projectId] ?? EMPTY) };
        // Keep the store small: newest threads only.
        const keys = Object.keys(threads);
        if (keys.length > MAX_THREADS) {
          const byAge = keys.sort((a, b) => (threads[a]!.msgs.at(-1)?.at ?? 0) - (threads[b]!.msgs.at(-1)?.at ?? 0));
          for (const k of byAge.slice(0, keys.length - MAX_THREADS)) if (k !== projectId) delete threads[k];
        }
        set({ threads });
      };
      const push = (projectId: string, m: ChatMessage) => patch(projectId, (t) => ({ ...t, msgs: [...t.msgs, m].slice(-MAX_MSGS) }));

      return {
        threads: {},
        busy: {},
        unread: {},
        thread: (projectId) => get().threads[projectId] ?? EMPTY,
        setDraft: (projectId, draft) => patch(projectId, (t) => ({ ...t, draft })),
        setUseSelection: (projectId, v) => patch(projectId, (t) => ({ ...t, useSelection: v })),
        setStates: (projectId, msgId, idx, s) =>
          patch(projectId, (t) => ({
            ...t,
            msgs: t.msgs.map((m) => {
              if (m.id !== msgId || !m.plan) return m;
              const states = m.states ? [...m.states] : m.plan.map(() => 'proposed' as ItemState);
              idx.forEach((i) => (states[i] = s));
              return { ...m, states };
            }),
          })),
        clear: (projectId) => patch(projectId, (t) => ({ ...t, msgs: [] })),
        markRead: (projectId) => set({ unread: { ...get().unread, [projectId]: 0 } }),
        send: async (projectId, message, o) => {
          const text = message.trim();
          if (!text || get().busy[projectId]) return;
          const useSel = (get().threads[projectId] ?? EMPTY).useSelection;
          const ctx = useSel ? o.context : { playhead: o.context.playhead };
          const scope = describeContext(ctx) || 'Whole project';
          patch(projectId, (t) => ({ ...t, draft: '' }));
          push(projectId, { id: uid(), role: 'user', text, at: Date.now(), scope });
          const reply = (m: Omit<ChatMessage, 'id' | 'role' | 'at'>) => {
            push(projectId, { id: uid(), role: 'assistant', at: Date.now(), ...m, states: m.plan?.map(() => 'proposed') });
            if (!o.visible) set({ unread: { ...get().unread, [projectId]: (get().unread[projectId] ?? 0) + 1 } });
          };

          // 1) Common edits are understood right here: free, instant, no AI call.
          const quick = quickPlan(text, { clipIndex: ctx.clip?.index, objectId: ctx.object?.id, clipId: ctx.clip?.id, clipIds: ctx.clips?.map((c) => c.id), range: ctx.range, playhead: ctx.playhead });
          if (quick) {
            reply({ text: quick.reply, plan: quick.ops.map((op) => ({ op, generative: false })), local: true });
            return;
          }

          // 2) Everything else goes to the AI planner (it only proposes; nothing is applied without you).
          set({ busy: { ...get().busy, [projectId]: true } });
          try {
            const history = (get().threads[projectId] ?? EMPTY).msgs.slice(-9, -1).map((m) => ({ role: m.role, text: m.text.slice(0, 1500) }));
            const r = await api<CopilotReply>(`/api/projects/${projectId}/copilot`, {
              body: {
                message: text,
                timeline: o.timeline,
                history,
                scope: {
                  ...(ctx.clip ? { clipId: ctx.clip.id } : {}),
                  ...(ctx.clip?.shotId ? { shotId: ctx.clip.shotId } : {}),
                  ...(ctx.srcRange ? { startSec: ctx.srcRange.start, endSec: ctx.srcRange.end } : {}),
                  ...(ctx.object ? { objectId: ctx.object.id, mask: ctx.object.mask } : ctx.mask ? { mask: ctx.mask } : {}),
                },
              },
            });
            reply({ text: r.reply, plan: r.plan });
          } catch (e) {
            reply({ text: e instanceof ApiError ? e.message : 'The assistant is unavailable right now. Every change can still be made by hand.', error: true });
          } finally {
            set({ busy: { ...get().busy, [projectId]: false } });
          }
        },
      };
    },
    {
      name: 'fc-assistant',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ threads: s.threads }) as unknown as State,
    },
  ),
);
