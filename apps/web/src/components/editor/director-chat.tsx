'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, Check, CircleDollarSign, Clapperboard, Loader2, Lock, RotateCcw, Sparkles, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import type { DirectorItem, DirectorScope, Timeline } from '@framecraft/shared';
import { ApiError } from '@/lib/api';
import { directorKey, useAssistant, type ChatMessage } from '@/lib/assistant';
import { applyFreeSteps, directorNames, hasUnresolvedRefs, priceOf, quickContextFor, resolveRefs, runPaidStep, scopeLabel, undoFreeSteps } from '@/lib/director';
import { useEditor } from '@/lib/editor-store';
import type { StudioData } from '@/lib/studio';
import { cn } from '@/lib/utils';

/*
 * The AI Director's conversation pieces, shared by the Director node on the graph, the Ask AI card
 * on a shot / scene / connection and the storyboard: the plan list (free steps apply at once and
 * can be undone; paid steps show their price and wait for approval), the thread and the composer.
 */

export type DirectorDeps = {
  projectId: string;
  studio: StudioData | undefined;
  timeline: Timeline;
  apply: (fn: (t: Timeline) => Timeline) => void;
  refetch: () => unknown;
};

function PaidStep({ deps, msg, i, item }: { deps: DirectorDeps; msg: ChatMessage; i: number; item: DirectorItem }) {
  const op = resolveRefs(item.op, msg.director?.created ?? {});
  const waiting = hasUnresolvedRefs(op);
  const state = msg.states?.[i] ?? 'proposed';
  const price = useQuery({
    queryKey: ['director-price', deps.projectId, JSON.stringify(op)],
    queryFn: () => priceOf(deps.projectId, op),
    enabled: !waiting && !item.blocked && state === 'proposed',
    staleTime: 60_000,
  });
  const [busy, setBusy] = useState(false);
  const est = price.data?.estimate ?? item.estimate ?? null;
  const blocked = item.blocked ?? price.data?.blocked;
  const start = async () => {
    if (!est) return;
    setBusy(true);
    try {
      await runPaidStep(deps.projectId, msg, i, op, est.credits, deps.refetch);
      toast.success('Started — the card updates by itself when it is ready.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start it');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-5 text-[11px]">
      {state === 'started' ? (
        <span className="flex items-center gap-1 text-iris-200"><Loader2 className="size-3 animate-spin" /> Started — you will review the result before it is used</span>
      ) : blocked ? null : waiting ? (
        <span className="text-fog-500">Price shown once the new shot is added (apply the free steps first)</span>
      ) : price.isLoading ? (
        <span className="flex items-center gap-1 text-fog-400"><Loader2 className="size-3 animate-spin" /> Pricing…</span>
      ) : est ? (
        <>
          <span className="text-fog-300">
            ≈ <b className="text-white">{est.credits}</b> credits{est.model ? ` · ${est.model}` : ''}
          </span>
          <button type="button" disabled={busy || state !== 'proposed'} onClick={start} className="nodrag flex items-center gap-1 rounded-lg bg-iris-500 px-2 py-1 font-medium text-white hover:bg-iris-400 disabled:opacity-50">
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Approve {est.credits} credits
          </button>
          {est.notes?.[0] && <span className="w-full text-[10px] text-fog-500">{est.notes[0]}</span>}
        </>
      ) : null}
    </div>
  );
}

/** A Director plan: what each step does, which are free, which cost credits, and what became of them. */
export function DirectorPlan({ deps, msg }: { deps: DirectorDeps; msg: ChatMessage }) {
  const d = msg.director!;
  const [busy, setBusy] = useState(false);
  const states = msg.states ?? d.items.map(() => 'proposed' as const);
  // Free steps apply together; once there is an undo for them they count as applied.
  const done = Boolean(d.undo?.length) && !d.undone;
  const freeOpen = done ? [] : d.items.flatMap((it, i) => (!it.paid && !it.blocked && states[i] === 'proposed' ? [i] : []));
  const applyAll = async () => {
    setBusy(true);
    try {
      await applyFreeSteps(deps.projectId, msg, freeOpen, deps);
      toast.success(freeOpen.length > 1 ? `Applied ${freeOpen.length} changes` : 'Applied');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not apply it');
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    setBusy(true);
    try {
      await undoFreeSteps(deps.projectId, msg, deps.refetch);
      const timelineSteps = d.items.some((it, i) => it.op.op === 'timeline' && states[i] === 'applied');
      toast.success(timelineSteps ? 'Story changes undone — press Ctrl+Z for the timeline edits' : 'Undone');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not undo it');
    } finally {
      setBusy(false);
    }
  };
  if (!d.items.length) return null;
  return (
    <div className="mt-2 space-y-1.5 rounded-xl border hairline bg-black/25 p-2">
      {d.items.map((it, i) => (
        <div key={i} className={cn('text-xs', states[i] === 'cancelled' && 'opacity-50')}>
          <div className="flex items-start gap-1.5">
            {it.paid ? <CircleDollarSign className="mt-0.5 size-3.5 shrink-0 text-amber-300" /> : states[i] === 'applied' ? <Check className="mt-0.5 size-3.5 shrink-0 text-signal-green" /> : <Sparkles className="mt-0.5 size-3.5 shrink-0 text-iris-300" />}
            <span className={cn('min-w-0 flex-1 text-fog-100', states[i] === 'applied' && 'text-fog-300')}>{it.summary}</span>
            {!it.paid && !it.blocked && <span className="shrink-0 rounded bg-white/[0.06] px-1 text-[9px] uppercase tracking-wide text-fog-400">free</span>}
          </div>
          {it.blocked && (
            <div className="mt-0.5 flex items-start gap-1 pl-5 text-[11px] text-signal-amber">
              <Lock className="mt-0.5 size-3 shrink-0" /> {it.blocked}
            </div>
          )}
          {it.paid && !it.blocked && <PaidStep deps={deps} msg={msg} i={i} item={it} />}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        {freeOpen.length > 0 && (
          <button type="button" disabled={busy} onClick={applyAll} className="nodrag flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-[11px] font-medium text-ink-950 hover:bg-fog-100 disabled:opacity-50">
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Apply {freeOpen.length > 1 ? `${freeOpen.length} changes` : 'change'}
          </button>
        )}
        {(d.undo?.length ?? 0) > 0 && !d.undone && (
          <button type="button" disabled={busy} onClick={undo} className="nodrag flex items-center gap-1 rounded-lg border hairline px-2 py-1 text-[11px] text-fog-200 hover:border-white/25">
            <RotateCcw className="size-3" /> Undo
          </button>
        )}
        {d.undone && <span className="text-[11px] text-fog-500">Undone</span>}
        {d.offline && <span className="text-[10px] text-fog-500">Offline planner</span>}
      </div>
    </div>
  );
}

export function DirectorMessage({ deps, m }: { deps: DirectorDeps; m: ChatMessage }) {
  if (m.role === 'user') {
    return (
      <div className="ml-6 rounded-2xl rounded-br-md bg-iris-500 px-3 py-2 text-sm text-white">
        <div className="whitespace-pre-wrap">{m.text}</div>
        {m.scope && <div className="mt-1 text-[10px] text-white/70">on: {m.scope}</div>}
      </div>
    );
  }
  return (
    <div className={cn('text-sm text-fog-100', m.error && 'text-signal-amber')}>
      <div className="whitespace-pre-wrap">{m.text}</div>
      {m.local && <div className="mt-0.5 text-[10px] text-fog-500">Understood instantly — no AI call, no credits</div>}
      {m.director && <DirectorPlan deps={deps} msg={m} />}
    </div>
  );
}

export function suggestionsFor(studio: StudioData | undefined, scope: DirectorScope): string[] {
  if (scope.kind === 'shot') {
    const s = studio?.shots.find((x) => x.id === scope.shotId);
    return s?.versions.length
      ? ['Slow zoom in', 'Make it shorter', 'Continue the action', 'Add a close-up after this', 'Match the colour to the shot before', 'Make the character smile']
      : ['Generate this shot', 'Draw the storyboard frame', 'Make it 4 seconds', 'Slow zoom in', 'Add a close-up after this', 'Make it more emotional'];
  }
  if (scope.kind === 'scene') return ['Add two shots showing the environment', 'Make this scene more dramatic', 'Make this scene shorter', 'Make the lighting consistent'];
  if (scope.kind === 'edge') return ['Add a close-up between these', 'Add a reaction shot', 'Add an establishing shot', 'Continue the action', 'Add a dissolve', 'Match the lighting'];
  return ['Make the story funnier', 'Add a new scene at the end', 'Make the whole film more cinematic', 'Change the ending'];
}

/** Input with its own unsent draft per target; Enter sends, Shift+Enter is a new line. */
export function DirectorComposer({ deps, scope, autoFocus, compact, placeholder }: { deps: DirectorDeps; scope: DirectorScope; autoFocus?: boolean; compact?: boolean; placeholder?: string }) {
  const key = directorKey(scope);
  const draft = useAssistant((s) => s.threads[deps.projectId]?.drafts?.[key] ?? '');
  const busy = useAssistant((s) => Boolean(s.busy[deps.projectId]));
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, key]);
  const send = () => {
    const names = directorNames(deps.studio, deps.timeline);
    void useAssistant.getState().sendDirector(deps.projectId, draft, {
      scope,
      scopeLabel: scopeLabel(deps.studio, scope),
      quick: quickContextFor(deps.studio, deps.timeline, scope),
      names,
      timeline: useEditor.getState().timeline ?? deps.timeline,
      visible: true,
    });
  };
  return (
    <div className="nodrag nowheel flex items-end gap-1.5 rounded-xl border hairline bg-black/30 p-1.5 focus-within:border-iris-400/70">
      <textarea
        ref={ref}
        value={draft}
        rows={compact ? 1 : 2}
        maxLength={2000}
        aria-label="Ask the AI Director"
        placeholder={placeholder ?? 'Describe the change in your own words…'}
        onChange={(e) => useAssistant.getState().setDirectorDraft(deps.projectId, key, e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (draft.trim() && !busy) send();
          }
        }}
        className="max-h-32 min-h-[34px] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-white placeholder:text-fog-500 focus:outline-none"
      />
      <button type="button" aria-label="Send" disabled={!draft.trim() || busy} onClick={send} className="grid size-8 shrink-0 place-items-center rounded-lg bg-iris-500 text-white hover:bg-iris-400 disabled:opacity-40">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
      </button>
    </div>
  );
}

/**
 * Ask AI on one target (a shot, a scene or a connection): the target is already known, so the user
 * only says what to change. Shows this target's latest answer and plan; the whole conversation
 * stays in the AI Director.
 */
export function AskCard({ deps, scope, onClose, onOpenDirector, title }: { deps: DirectorDeps; scope: DirectorScope; onClose: () => void; onOpenDirector?: () => void; title?: string }) {
  const key = directorKey(scope);
  const msgs = useAssistant((s) => s.threads[deps.projectId]?.msgs);
  const busy = useAssistant((s) => Boolean(s.busy[deps.projectId]));
  const last = useMemo(() => {
    const list = msgs ?? [];
    const at = list.findLastIndex((m) => m.role === 'assistant' && m.director && directorKey(m.director.scope) === key);
    return at < 0 ? null : { q: list[at - 1]?.role === 'user' ? list[at - 1] : undefined, a: list[at]! };
  }, [msgs, key]);
  const label = title ?? scopeLabel(deps.studio, scope);
  return (
    <div className="nodrag nowheel w-[min(380px,90vw)] cursor-default rounded-2xl border border-iris-400/40 bg-ink-900/97 p-3 text-left shadow-2xl backdrop-blur" role="dialog" aria-label={`Ask AI about ${label}`} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="mb-2 flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-lg bg-gradient-to-br from-iris-400 to-fuchsia-500 text-white"><Clapperboard className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-fog-500">Ask the AI Director about</div>
          <div className="truncate text-xs font-medium text-white">{label}</div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="grid size-7 place-items-center rounded-lg text-fog-400 hover:bg-white/[0.06] hover:text-white"><X className="size-4" /></button>
      </div>
      {last ? (
        <div className="mb-2 max-h-[min(300px,40vh)] space-y-2 overflow-y-auto pr-1">
          {last.q && <DirectorMessage deps={deps} m={last.q} />}
          <DirectorMessage deps={deps} m={last.a} />
        </div>
      ) : (
        <div className="mb-2 flex flex-wrap gap-1">
          {suggestionsFor(deps.studio, scope).map((s) => (
            <button key={s} type="button" onClick={() => useAssistant.getState().setDirectorDraft(deps.projectId, key, s)} className="rounded-full border hairline px-2 py-0.5 text-[11px] text-fog-200 hover:border-iris-400/60 hover:text-white">{s}</button>
          ))}
        </div>
      )}
      {busy && <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-fog-300"><Loader2 className="size-3 animate-spin" /> The Director is planning…</div>}
      <DirectorComposer deps={deps} scope={scope} autoFocus compact />
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-fog-500">
        <span>Only this {scope.kind === 'edge' ? 'connection' : scope.kind} changes unless you say otherwise.</span>
        {onOpenDirector && <button type="button" onClick={onOpenDirector} className="text-iris-200 hover:text-white">Full conversation</button>}
      </div>
    </div>
  );
}

/** The whole conversation with the AI Director (on the canvas node, or docked beside it). */
export function DirectorPanel({ deps, header, resizable }: { deps: DirectorDeps; header?: ReactNode; resizable?: boolean }) {
  const thread = useAssistant((s) => s.threads[deps.projectId]);
  const busy = useAssistant((s) => Boolean(s.busy[deps.projectId]));
  const msgs = thread?.msgs ?? [];
  const scope: DirectorScope = thread?.scope ?? { kind: 'project' };
  const label = scopeLabel(deps.studio, scope);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [msgs.length, busy]);
  return (
    <div className={cn('flex size-full min-h-0 flex-col', resizable && 'min-h-[300px] min-w-[320px]')}>
      {header}
      <div ref={list} className="nowheel nodrag min-h-0 flex-1 cursor-auto select-text space-y-3 overflow-y-auto p-3">
        {!msgs.length && (
          <div className="space-y-2 text-xs text-fog-300">
            <p>Tell me what to make or change — a whole cartoon, a scene, one shot or the moment between two shots. Select something on the canvas and I work on just that.</p>
            <p className="text-[11px] text-fog-500">Simple changes are free and instant. Anything that costs credits shows its price and waits for you.</p>
            <div className="flex flex-wrap gap-1">
              {suggestionsFor(deps.studio, scope).map((s) => (
                <button key={s} type="button" onClick={() => useAssistant.getState().setDirectorDraft(deps.projectId, directorKey(scope), s)} className="rounded-full border hairline px-2 py-0.5 text-[11px] text-fog-200 hover:border-iris-400/60 hover:text-white">{s}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) => <DirectorMessage key={m.id} deps={deps} m={m} />)}
        {busy && <div className="flex items-center gap-1.5 text-[11px] text-fog-300"><Loader2 className="size-3 animate-spin" /> Planning… (you can keep working)</div>}
      </div>
      <div className="nodrag border-t hairline p-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px]">
          <span className="text-fog-500">On:</span>
          <span className="min-w-0 truncate rounded-md bg-white/[0.07] px-1.5 py-0.5 font-medium text-white" data-testid="director-scope">{label}</span>
          {scope.kind !== 'project' && (
            <button type="button" aria-label="Talk about the whole project" title="Whole project" onClick={() => useAssistant.getState().setDirectorScope(deps.projectId, { kind: 'project' }, 'Whole project')} className="grid size-5 place-items-center rounded text-fog-400 hover:text-white"><X className="size-3" /></button>
          )}
        </div>
        <DirectorComposer deps={deps} scope={scope} />
      </div>
    </div>
  );
}
