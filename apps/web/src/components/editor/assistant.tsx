'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Bot, Check, Eye, GripHorizontal, Minus, PanelBottom, PanelRight, PictureInPicture2, Sparkles, Trash2, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { applyPlanOp, sequenceOf, type PlanOp, type Timeline } from '@framecraft/shared';
import { api, ApiError } from '@/lib/api';
import { describeContext, useAssistant, type AssistantContext, type ChatMessage } from '@/lib/assistant';
import { newId, useEditor } from '@/lib/editor-store';
import { clampTo, LIMITS, useEditorUi, type AssistantDock } from '@/lib/editor-ui';
import { describeOp, opScope } from '@/lib/plan-describe';
import type { PlanItem } from '@/lib/studio';
import { Button, Dialog, Spinner } from '@/components/ui';
import { cn, newKey } from '@/lib/utils';

/*
 * The assistant as a dockable panel. Its conversation, draft and running requests live in a store,
 * so docking, floating, resizing or minimising never loses anything. Free edits are previewed and
 * applied as ordinary undoable timeline changes; AI edits of the footage always show their price
 * and ask before they run.
 */

const SCOPE_TONE = { object: 'text-iris-200 bg-iris-500/15', clip: 'text-sky-200 bg-sky-500/15', movie: 'text-amber-200 bg-amber-500/15', audio: 'text-emerald-200 bg-emerald-500/15' } as const;
const SCOPE_LABEL = { object: 'object only', clip: 'clip', movie: 'whole video', audio: 'sound' } as const;

function suggestions(ctx: AssistantContext): string[] {
  if (ctx.object) return ['Make it blue', 'Make this darker', 'Blur it', `Remove the ${ctx.object.name.toLowerCase()} with AI`];
  if (ctx.range) return ['Cut out this part', 'Make this part brighter', 'Fix the hand in this part'];
  if (ctx.clip) return ['Make this clip warmer', 'Slow this clip down', 'Make it black and white', 'Make the music quieter'];
  return ['Make it look cinematic', 'Add smooth transitions', 'Make the music quieter', 'Add a title “Summer sale”'];
}

type Props = {
  projectId: string;
  timeline: Timeline;
  apply: (fn: (t: Timeline) => Timeline) => void;
  context: AssistantContext;
  onEditStarted?: () => void;
};

/** Chat body (header controls are passed in by the dock). */
function AssistantBody({ projectId, timeline, apply, context, onEditStarted, visible }: Props & { visible: boolean }) {
  const thread = useAssistant((s) => s.threads[projectId]);
  const busy = useAssistant((s) => Boolean(s.busy[projectId]));
  const { send, setDraft, setStates, setUseSelection } = useAssistant.getState();
  const msgs = thread?.msgs ?? [];
  const draft = thread?.draft ?? '';
  const useSelection = thread?.useSelection ?? true;
  const list = useRef<HTMLDivElement>(null);
  const previews = useRef(new Map<string, number>()); // `${msgId}:${i}` → history length after the preview
  const [confirm, setConfirm] = useState<{ msg: ChatMessage; i: number } | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [msgs.length, busy]);
  useEffect(() => {
    if (visible) useAssistant.getState().markRead(projectId);
  }, [visible, projectId, msgs.length]);

  const ctxLabel = describeContext(context);
  const submit = () => void send(projectId, draft, { context, timeline: useEditor.getState().timeline, visible });

  const run = (ops: PlanOp[]) => (t: Timeline) => {
    let out = t;
    for (const op of ops) out = applyPlanOp(out, op, () => newId('clip'));
    return out;
  };
  const guard = (ops: PlanOp[]) => {
    if (ops.some((o) => o.op === 'logo') && !timeline.logo) {
      toast.error('Add your logo first: Project panel → Brand logo.');
      return false;
    }
    return true;
  };
  const preview = (m: ChatMessage, i: number) => {
    const op = m.plan![i]!.op;
    if (!guard([op])) return;
    apply(run([op]));
    previews.current.set(`${m.id}:${i}`, useEditor.getState().past.length);
    setStates(projectId, m.id, [i], 'previewing');
  };
  const applyNow = (m: ChatMessage, idx: number[]) => {
    const fresh = idx.filter((i) => (m.states?.[i] ?? 'proposed') === 'proposed');
    const ops = fresh.map((i) => m.plan![i]!.op);
    if (ops.length && !guard(ops)) return;
    if (ops.length) apply(run(ops));
    setStates(projectId, m.id, idx, 'applied');
    toast.success(idx.length > 1 ? `Applied ${idx.length} changes — Ctrl+Z undoes them` : 'Applied — Ctrl+Z undoes it');
  };
  const cancel = (m: ChatMessage, i: number) => {
    const at = previews.current.get(`${m.id}:${i}`);
    if (at !== undefined && useEditor.getState().past.length === at) {
      useEditor.getState().undo();
      setStates(projectId, m.id, [i], 'cancelled');
    } else toast.message('Other changes were made after the preview — use Undo (Ctrl+Z) to step back.');
  };
  const runAi = async (m: ChatMessage, i: number) => {
    const item = m.plan![i]!;
    if (item.op.op !== 'ai_edit' || !item.estimate) return;
    const seqNode = sequenceOf(timeline)[item.op.shot - 1];
    const node = seqNode && timeline.clips.find((c) => c.id === seqNode.clipIds[0]);
    if (!node) return void toast.error('That shot is no longer in the video.');
    setRunning(`${m.id}:${i}`);
    try {
      let shot = node.shotId ? { shotId: node.shotId, versionId: node.versionId } : null;
      if (!shot) {
        // Your own footage becomes a shot (free) so the AI edit has versions to compare.
        const r = await api<{ shotId: string; versionId: string }>(`/api/projects/${projectId}/shots/from-clip`, { body: { assetId: node.assetId, label: node.label } });
        shot = r;
        apply((t) => ({ ...t, clips: t.clips.map((c) => (c.assetId === node.assetId && !c.shotId ? { ...c, shotId: r.shotId, versionId: r.versionId } : c)) }));
      }
      await api('/api/edits', { body: { shotId: shot.shotId, versionId: shot.versionId, mode: item.op.mode, instruction: item.op.instruction, startSec: item.estimate.rangeStart, endSec: item.estimate.rangeEnd, mask: context.object?.mask ?? context.mask ?? null, referenceAssetIds: [], idempotencyKey: newKey() } });
      setStates(projectId, m.id, [i], 'started');
      toast.success('AI edit started — you’ll compare it before it replaces anything.');
      onEditStarted?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start the edit');
    } finally {
      setRunning(null);
      setConfirm(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!msgs.length && (
          <div className="space-y-2 text-xs text-fog-400">
            <p className="text-fog-300">Ask for a change in your own words. I work on what you have selected.</p>
            <ul className="space-y-1 text-[11px]">
              <li className="flex gap-1.5"><Check className="mt-0.5 size-3 shrink-0 text-signal-green" /> Everyday edits (colour, sound, cuts, titles, transitions) are free and instant.</li>
              <li className="flex gap-1.5"><Sparkles className="mt-0.5 size-3 shrink-0 text-iris-300" /> Changing the pixels with AI (remove, replace, fix) shows the price first and never runs without you.</li>
            </ul>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {suggestions(context).map((s) => (
                <button key={s} type="button" onClick={() => setDraft(projectId, s)} className="rounded-full border hairline px-2.5 py-1 text-[11px] text-fog-200 hover:border-white/25">{s}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={cn('text-sm', m.role === 'user' ? 'ml-8' : '')}>
            {m.role === 'user' ? (
              <div className="rounded-2xl rounded-br-md bg-iris-500 px-3 py-2 text-white">
                <div className="whitespace-pre-wrap">{m.text}</div>
                {m.scope && <div className="mt-1 text-[10px] text-white/70">on: {m.scope}</div>}
              </div>
            ) : (
              <div className={cn('text-fog-100', m.error && 'text-signal-amber')}>
                <div className="whitespace-pre-wrap">{m.text}</div>
                {m.local && <div className="mt-0.5 text-[10px] text-fog-500">Understood instantly — no AI call, no credits</div>}
                {m.plan && m.plan.length > 0 && <PlanList m={m} timeline={timeline} running={running} onPreview={preview} onApply={applyNow} onCancel={cancel} onAi={(i) => setConfirm({ msg: m, i })} />}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-fog-300">
            <Spinner /> Planning… (you can keep editing)
          </div>
        )}
      </div>
      <div className="border-t hairline p-2.5">
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
          <label className="flex min-w-0 items-center gap-1.5 text-fog-300">
            <input type="checkbox" checked={useSelection} onChange={(e) => setUseSelection(projectId, e.target.checked)} className="accent-iris-500" />
            <span className="truncate">{useSelection && ctxLabel ? <>On: <b className="font-medium text-white">{ctxLabel}</b></> : 'On: the whole project'}</span>
          </label>
          {msgs.length > 0 && (
            <button type="button" onClick={() => useAssistant.getState().clear(projectId)} className="flex shrink-0 items-center gap-1 text-fog-500 hover:text-white" title="Clear conversation">
              <Trash2 className="size-3" /> Clear
            </button>
          )}
        </div>
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(projectId, e.target.value)}
            rows={2}
            maxLength={2000}
            aria-label="Message the assistant"
            placeholder={context.object ? `e.g. Make the ${context.object.name.toLowerCase()} blue` : 'e.g. Make the music quieter'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="min-h-0 flex-1 resize-none rounded-xl border hairline bg-white/[0.03] px-3 py-2 text-sm text-fog-100 placeholder:text-fog-500 focus:border-iris-500/60 focus:outline-none"
          />
          <Button type="submit" size="icon" disabled={busy || !draft.trim()} aria-label="Send"><ArrowUp /></Button>
        </form>
      </div>
      {confirm && (() => {
        const item = confirm.msg.plan![confirm.i]!;
        const est = item.estimate;
        const op = item.op;
        return (
          <Dialog
            open
            onOpenChange={(o) => !o && setConfirm(null)}
            title="Generate an AI preview?"
            description="This changes pixels with a paid AI model. Nothing in your video changes until you compare and accept the result."
            footer={
              <>
                <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
                <Button loading={running === `${confirm.msg.id}:${confirm.i}`} onClick={() => runAi(confirm.msg, confirm.i)}>
                  <Sparkles /> {est?.fixture && !est.available ? 'Run test (no AI, no charge)' : `Generate · ≈ ${est?.credits ?? '?'} credits`}
                </Button>
              </>
            }
          >
            <div className="space-y-2 text-sm text-fog-200">
              <div className="rounded-xl bg-white/[0.04] p-3">{describeOp(op, timeline)}</div>
              {est && (
                <ul className="space-y-1 text-xs text-fog-300">
                  <li>Model: {est.model} · {est.seconds} s of video sent</li>
                  <li>Only {op.op === 'ai_edit' ? `shot ${op.shot}` : 'the selection'}, {est.rangeStart.toFixed(1)}–{est.rangeEnd.toFixed(1)} s changes; every other shot stays exactly as it is.</li>
                  {est.notes.map((n) => <li key={n}>• {n}</li>)}
                </ul>
              )}
            </div>
          </Dialog>
        );
      })()}
    </div>
  );
}

function PlanList({ m, timeline, running, onPreview, onApply, onCancel, onAi }: { m: ChatMessage; timeline: Timeline; running: string | null; onPreview: (m: ChatMessage, i: number) => void; onApply: (m: ChatMessage, idx: number[]) => void; onCancel: (m: ChatMessage, i: number) => void; onAi: (i: number) => void }) {
  const plan = m.plan as PlanItem[];
  const states = m.states ?? plan.map(() => 'proposed');
  const openFree = plan.map((p, i) => (!p.generative && !p.blocked && states[i] === 'proposed' ? i : -1)).filter((i) => i >= 0);
  return (
    <div className="mt-2 space-y-1.5">
      {plan.map((p, i) => {
        const st = states[i];
        const scope = opScope(p.op);
        return (
          <div key={i} className={cn('rounded-xl border px-2.5 py-2 text-xs', p.blocked ? 'border-signal-amber/30 bg-signal-amber/5' : st === 'applied' || st === 'started' ? 'border-signal-green/30 bg-signal-green/5' : st === 'previewing' ? 'border-iris-400/60 bg-iris-500/10' : 'hairline bg-white/[0.03]')}>
            <div className="flex items-start gap-2">
              {p.generative ? <Sparkles className="mt-0.5 size-3.5 shrink-0 text-iris-300" /> : <Check className="mt-0.5 size-3.5 shrink-0 text-fog-500" />}
              <div className="min-w-0 flex-1">
                <div className="text-fog-100">{describeOp(p.op, timeline)}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                  <span className={cn('rounded px-1.5 py-0.5', SCOPE_TONE[scope])}>{SCOPE_LABEL[scope]}</span>
                  <span className="text-fog-500">{p.generative ? (p.estimate ? (p.estimate.fixture && !p.estimate.available ? 'test mode · no charge' : `AI · ≈ ${p.estimate.credits} credits`) : 'AI') : 'free · undoable'}</span>
                  {st === 'applied' && <span className="text-signal-green">applied</span>}
                  {st === 'started' && <span className="text-signal-green">AI preview running — review when ready</span>}
                  {st === 'cancelled' && <span className="text-fog-500">cancelled</span>}
                </div>
                {p.why && <div className="mt-0.5 text-fog-400">{p.why}</div>}
                {p.blocked && <div className="mt-0.5 text-signal-amber">{p.blocked}</div>}
              </div>
            </div>
            {!p.blocked && st !== 'applied' && st !== 'cancelled' && st !== 'started' && (
              <div className="mt-2 flex justify-end gap-1.5">
                {p.generative ? (
                  <Button size="sm" variant="secondary" loading={running === `${m.id}:${i}`} disabled={!p.estimate || (!p.estimate.available && !p.estimate.fixture)} onClick={() => onAi(i)}>
                    <Sparkles /> Generate preview…
                  </Button>
                ) : st === 'previewing' ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => onCancel(m, i)}><Undo2 /> Cancel</Button>
                    <Button size="sm" onClick={() => onApply(m, [i])}><Check /> Keep</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => onPreview(m, i)}><Eye /> Preview</Button>
                    <Button size="sm" variant="secondary" onClick={() => onApply(m, [i])}>Apply</Button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      {openFree.length > 1 && (
        <Button size="sm" className="w-full" onClick={() => onApply(m, openFree)}>Apply all {openFree.length} free changes</Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ dock

function DockButtons({ dock }: { dock: AssistantDock }) {
  const set = useEditorUi((s) => s.set);
  const btn = (d: AssistantDock, Icon: typeof PanelRight, label: string) => (
    <button key={d} type="button" title={label} aria-label={label} aria-pressed={dock === d} onClick={() => set({ assistantDock: d })} className={cn('grid size-7 place-items-center rounded-md', dock === d ? 'bg-white/10 text-white' : 'text-fog-400 hover:bg-white/[0.06] hover:text-white')}>
      <Icon className="size-3.5" />
    </button>
  );
  return (
    <div className="flex items-center gap-0.5">
      {btn('right', PanelRight, 'Dock right')}
      {btn('bottom', PanelBottom, 'Dock at the bottom')}
      {btn('float', PictureInPicture2, 'Float over the editor')}
      <button type="button" title="Minimise (Ctrl+J)" aria-label="Minimise assistant" onClick={() => set({ assistantOpen: false })} className="grid size-7 place-items-center rounded-md text-fog-400 hover:bg-white/[0.06] hover:text-white">
        <Minus className="size-3.5" />
      </button>
    </div>
  );
}

function Header({ dock, onDragStart }: { dock: AssistantDock; onDragStart?: (e: React.PointerEvent) => void }) {
  return (
    <div className={cn('flex h-10 shrink-0 items-center justify-between gap-2 border-b hairline px-3', onDragStart && 'cursor-grab active:cursor-grabbing')} onPointerDown={onDragStart}>
      <span className="flex items-center gap-1.5 text-sm font-medium text-white">
        {onDragStart && <GripHorizontal className="size-3.5 text-fog-500" />}
        <Bot className="size-4 text-iris-300" /> Assistant
      </span>
      <div onPointerDown={(e) => e.stopPropagation()}>
        <DockButtons dock={dock} />
      </div>
    </div>
  );
}

/** Drag handle that reports the pointer delta since the drag began. */
export function ResizeHandle({ axis, onDelta, onEnd, className, label }: { axis: 'x' | 'y'; onDelta: (d: number) => void; onEnd?: () => void; className?: string; label: string }) {
  const start = useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      className={cn('group relative z-10 shrink-0 touch-none select-none', axis === 'x' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize', className)}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = axis === 'x' ? e.clientX : e.clientY;
      }}
      onPointerMove={(e) => {
        if (start.current === null) return;
        onDelta((axis === 'x' ? e.clientX : e.clientY) - start.current);
      }}
      onPointerUp={() => {
        start.current = null;
        onEnd?.();
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        const d = axis === 'x' ? ({ ArrowLeft: -step, ArrowRight: step } as Record<string, number>)[e.key] : ({ ArrowUp: -step, ArrowDown: step } as Record<string, number>)[e.key];
        if (d === undefined) return;
        e.preventDefault();
        onDelta(d);
        onEnd?.();
      }}
    >
      <span className={cn('absolute rounded-full bg-white/0 transition group-hover:bg-iris-400/60 group-focus-visible:bg-iris-400', axis === 'x' ? 'inset-y-2 left-1/2 w-0.5 -translate-x-1/2' : 'inset-x-2 top-1/2 h-0.5 -translate-y-1/2')} />
    </div>
  );
}

/** Ctrl/Cmd + J toggles the assistant; Esc minimises a floating one. */
export function useAssistantShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        useEditorUi.getState().toggleAssistant();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** The docked assistant for one side ("right" | "bottom"); renders nothing when it lives elsewhere. */
export function DockedAssistant(props: Props & { side: 'right' | 'bottom' }) {
  const { assistantOpen, assistantDock, assistantWidth, assistantHeight, set } = useEditorUi();
  const base = useRef(0);
  if (!assistantOpen || assistantDock !== props.side) return null;
  const right = props.side === 'right';
  return (
    <>
      <ResizeHandle
        axis={right ? 'x' : 'y'}
        label="Resize assistant"
        onDelta={(d) => {
          if (!base.current) base.current = right ? assistantWidth : assistantHeight;
          if (right) set({ assistantWidth: clampTo(base.current - d, LIMITS.assistantWidth) });
          else set({ assistantHeight: clampTo(base.current - d, LIMITS.assistantHeight) });
        }}
        onEnd={() => (base.current = 0)}
      />
      <section aria-label="Assistant" className={cn('flex flex-col overflow-hidden rounded-2xl border hairline bg-ink-900/80', right ? 'min-h-0 shrink-0' : 'min-h-[150px] shrink')} style={right ? { width: assistantWidth } : { height: `min(${assistantHeight}px, 40dvh)` }}>
        <Header dock={props.side} />
        <AssistantBody {...props} visible />
      </section>
    </>
  );
}

/** Floating window (draggable, resizable) and the minimised launcher button. */
export function FloatingAssistant(props: Props & { compact: boolean }) {
  const { assistantOpen, assistantDock, assistantFloat, set } = useEditorUi();
  const unread = useAssistant((s) => s.unread[props.projectId] ?? 0);
  const busy = useAssistant((s) => Boolean(s.busy[props.projectId]));
  const [vw, setVw] = useState({ w: 1280, h: 800 });
  useEffect(() => {
    const on = () => setVw({ w: window.innerWidth, h: window.innerHeight });
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const floating = assistantOpen && (assistantDock === 'float' || props.compact);
  const rect = useMemo(() => {
    const w = Math.min(assistantFloat.w, vw.w - 16);
    const h = Math.min(assistantFloat.h, vw.h - 72);
    const x = assistantFloat.x < 0 ? vw.w - w - 20 : Math.min(Math.max(8, assistantFloat.x), vw.w - w - 8);
    const y = assistantFloat.y < 0 ? vw.h - h - 20 : Math.min(Math.max(56, assistantFloat.y), vw.h - h - 8);
    return { x, y, w, h };
  }, [assistantFloat, vw]);
  const drag = useRef<{ mode: 'move' | 'size'; x0: number; y0: number; r: typeof rect } | null>(null);
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (d.mode === 'move') set({ assistantFloat: { ...assistantFloat, x: Math.round(d.r.x + dx), y: Math.round(d.r.y + dy), w: d.r.w, h: d.r.h } });
    else set({ assistantFloat: { ...assistantFloat, x: d.r.x, y: d.r.y, w: clampTo(d.r.w + dx, [300, 900]), h: clampTo(d.r.h + dy, [260, 900]) } });
  };
  useEffect(() => {
    if (!floating || props.compact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (document.activeElement as HTMLElement | null)?.closest('[data-assistant-float]')) set({ assistantOpen: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [floating, props.compact, set]);

  // On wide screens the top bar's Assistant button is the launcher; the floating one is for phones/tablets.
  if (!assistantOpen && !props.compact) return null;
  if (!assistantOpen)
    return (
      <button type="button" onClick={() => set({ assistantOpen: true })} className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-iris-400/40 bg-ink-900/95 px-4 py-2.5 text-sm text-white shadow-2xl backdrop-blur transition hover:border-iris-300" title="Open the assistant (Ctrl+J)">
        <Bot className="size-4 text-iris-300" /> Assistant
        {busy && <Spinner className="size-3.5" />}
        {unread > 0 && <span className="grid size-5 place-items-center rounded-full bg-iris-500 text-[10px] font-semibold">{unread}</span>}
      </button>
    );
  if (!floating) return null;
  if (props.compact)
    return (
      <section aria-label="Assistant" className="fixed inset-x-2 bottom-2 z-40 flex h-[min(70dvh,560px)] flex-col overflow-hidden rounded-2xl border hairline bg-ink-900/97 shadow-2xl backdrop-blur">
        <div className="flex h-10 shrink-0 items-center justify-between border-b hairline px-3">
          <span className="flex items-center gap-1.5 text-sm font-medium text-white"><Bot className="size-4 text-iris-300" /> Assistant</span>
          <button type="button" aria-label="Minimise assistant" onClick={() => set({ assistantOpen: false })} className="grid size-8 place-items-center rounded-md text-fog-300 hover:bg-white/[0.06]"><X className="size-4" /></button>
        </div>
        <AssistantBody {...props} visible />
      </section>
    );
  return (
    <section
      aria-label="Assistant"
      data-assistant-float
      className="fixed z-40 flex flex-col overflow-hidden rounded-2xl border hairline bg-ink-900/97 shadow-2xl backdrop-blur"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerMove={onMove}
      onPointerUp={() => (drag.current = null)}
    >
      <Header
        dock="float"
        onDragStart={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { mode: 'move', x0: e.clientX, y0: e.clientY, r: rect };
        }}
      />
      <AssistantBody {...props} visible />
      <span
        aria-hidden
        className="absolute bottom-0 right-0 size-4 cursor-nwse-resize"
        onPointerDown={(e) => {
          e.stopPropagation();
          (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { mode: 'size', x0: e.clientX, y0: e.clientY, r: rect };
        }}
      />
    </section>
  );
}
