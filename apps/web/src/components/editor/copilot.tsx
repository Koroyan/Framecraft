'use client';

import { useState } from 'react';
import { ArrowUp, Bot, Check, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { applyPlanOp, sequenceOf, type EditMask, type PlanOp, type Timeline } from '@framecraft/shared';
import { api, ApiError } from '@/lib/api';
import { newId } from '@/lib/editor-store';
import type { CopilotReply, PlanItem } from '@/lib/studio';
import { Button, Segmented, Spinner, Textarea } from '@/components/ui';
import { cn, newKey, seconds } from '@/lib/utils';

type Scope = 'shot' | 'range' | 'project';
type Msg = { role: 'user' | 'assistant'; text: string; plan?: PlanItem[]; applied?: number[] };

const describe = (op: PlanOp): string => {
  switch (op.op) {
    case 'trim': return `Trim shot ${op.shot}${op.durationSec ? ` to ${op.durationSec} s` : ''}`;
    case 'speed': return `Shot ${op.shot} at ${op.speed}× speed`;
    case 'transition': return `${op.type} from shot ${op.shot} into the next (${op.durationSec} s)`;
    case 'color': return `Colour of shot ${op.shot}: ${Object.entries(op.adjust).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${(v as number) > 0 ? '+' : ''}${v}`).join(', ')}`;
    case 'match_color': return `Match shot ${op.shot}’s colour to shot ${op.fromShot}`;
    case 'camera': return `Camera on shot ${op.shot}: ${op.preset.replaceAll('_', ' ')}`;
    case 'fade': return `Fade shot ${op.shot} (in ${op.inSec} s, out ${op.outSec} s)`;
    case 'move': return `Move shot ${op.shot} ${op.afterShot ? `after shot ${op.afterShot}` : 'to the start'}`;
    case 'remove': return `Take shot ${op.shot} out of the movie`;
    case 'text': return `Title “${op.text}” at ${seconds(op.startSec)}`;
    case 'color_all': return `Colour of every shot: ${Object.entries(op.adjust).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${(v as number) > 0 ? '+' : ''}${v}`).join(', ')}`;
    case 'logo': return `Logo ${op.position.replace('-', ' ')}${op.lastSec ? ` for the last ${op.lastSec} s` : ''}`;
    case 'duck_music': return 'Music ducks under the voice-over';
    case 'animated_captions': return `Animated captions (${op.style})`;
    case 'ai_edit': return `AI ${op.mode.replaceAll('_', ' ')} on shot ${op.shot}${op.startSec != null ? ` (${seconds(op.startSec)}–${seconds(op.endSec ?? op.startSec)})` : ''}: ${op.instruction}`;
  }
};

/**
 * The editing assistant. It proposes a plan within the chosen scope; free operations apply to the
 * timeline on click (undoable), AI edits start only with an explicit, priced confirmation.
 */
export function Copilot({ projectId, timeline, apply, shot, range, mask, onEditStarted }: { projectId: string; timeline: Timeline; apply: (fn: (t: Timeline) => Timeline) => void; shot?: { id: string; number: number; versionId?: string } | null; range?: { start: number; end: number } | null; mask?: EditMask | null; onEditStarted?: () => void }) {
  const [scope, setScope] = useState<Scope>(shot ? (range ? 'range' : 'shot') : 'project');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const effective: Scope = !shot ? 'project' : scope === 'range' && !range ? 'shot' : scope;

  const send = async () => {
    const message = text.trim();
    if (!message) return;
    setText('');
    setMsgs((m) => [...m, { role: 'user', text: message }]);
    setBusy(true);
    try {
      const r = await api<CopilotReply>(`/api/projects/${projectId}/copilot`, {
        body: {
          message,
          timeline,
          history: msgs.slice(-8).map((m) => ({ role: m.role, text: m.text })),
          scope: effective === 'project' ? {} : { shotId: shot!.id, ...(effective === 'range' && range ? { startSec: range.start, endSec: range.end, mask: mask ?? null } : {}) },
        },
      });
      setMsgs((m) => [...m, { role: 'assistant', text: r.reply, plan: r.plan, applied: [] }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', text: e instanceof ApiError ? e.message : 'The assistant is unavailable right now.' }]);
    } finally {
      setBusy(false);
    }
  };

  const applyFree = (mi: number, items: number[]) => {
    const m = msgs[mi]!;
    apply((t) => items.reduce((acc, i) => applyPlanOp(acc, m.plan![i]!.op, () => newId('clip')), t));
    setMsgs((all) => all.map((x, j) => (j === mi ? { ...x, applied: [...(x.applied ?? []), ...items] } : x)));
    toast.success('Applied — Ctrl+Z undoes it');
  };

  const runAi = async (mi: number, i: number) => {
    const item = msgs[mi]!.plan![i]!;
    if (item.op.op !== 'ai_edit' || !item.estimate) return;
    const seqNode = sequenceOf(timeline)[item.op.shot - 1];
    const node = seqNode && timeline.clips.find((c) => c.id === seqNode.clipIds[0]);
    if (!node?.shotId) return;
    setRunning(`${mi}:${i}`);
    try {
      await api('/api/edits', { body: { shotId: node.shotId, versionId: node.versionId, mode: item.op.mode, instruction: item.op.instruction, startSec: item.estimate.rangeStart, endSec: item.estimate.rangeEnd, mask: effective === 'range' ? (mask ?? null) : null, referenceAssetIds: [], idempotencyKey: newKey() } });
      setMsgs((all) => all.map((x, j) => (j === mi ? { ...x, applied: [...(x.applied ?? []), i] } : x)));
      toast.success('AI edit started — you’ll review it before it replaces anything.');
      onEditStarted?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start the edit');
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 pb-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-white"><Bot className="size-4 text-iris-300" /> AI assistant</span>
        <Segmented
          size="sm"
          value={effective}
          onChange={(v) => setScope(v)}
          options={[
            ...(shot ? [{ value: 'shot' as Scope, label: `Shot ${shot.number}` }] : []),
            ...(shot && range ? [{ value: 'range' as Scope, label: `${seconds(range.start)}–${seconds(range.end)}` }] : []),
            { value: 'project' as Scope, label: 'Whole movie' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {!msgs.length && (
          <div className="space-y-1.5 text-xs text-fog-400">
            <p>Ask for any change. Free edits (trim, colour, camera, transitions) apply instantly; AI edits of the footage show their cost first.</p>
            {['Make the colours consistent across the movie', 'Add a smooth transition between shots 2 and 3', shot ? 'Fix the character’s hand in the selected seconds' : 'Make shot 1 more cinematic'].map((s) => (
              <button key={s} type="button" onClick={() => setText(s)} className="block w-full rounded-lg border hairline px-2.5 py-1.5 text-left text-fog-200 hover:border-white/25">{s}</button>
            ))}
          </div>
        )}
        {msgs.map((m, mi) => (
          <div key={mi} className={cn('text-sm', m.role === 'user' ? 'ml-6 rounded-2xl rounded-br-md bg-iris-500 px-3 py-2 text-white' : 'text-fog-100')}>
            <div className="whitespace-pre-wrap">{m.text}</div>
            {m.plan && m.plan.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {m.plan.map((p, i) => {
                  const done = m.applied?.includes(i);
                  return (
                    <div key={i} className={cn('rounded-xl border px-2.5 py-2 text-xs', p.blocked ? 'border-signal-amber/30 bg-signal-amber/5' : 'hairline bg-white/[0.03]')}>
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-fog-100">{p.generative && <Sparkles className="mr-1 inline size-3 text-iris-300" />}{describe(p.op)}</span>
                        {done ? (
                          <Check className="size-4 shrink-0 text-signal-green" />
                        ) : p.blocked ? null : p.generative ? (
                          <Button size="sm" variant="secondary" loading={running === `${mi}:${i}`} disabled={!p.estimate || (!p.estimate.available && !p.estimate.fixture)} onClick={() => runAi(mi, i)}>
                            Run · {p.estimate?.fixture && !p.estimate.available ? 'test' : `${p.estimate?.credits ?? '?'} cr`}
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => applyFree(mi, [i])}>Apply</Button>
                        )}
                      </div>
                      {p.why && <div className="mt-0.5 text-fog-400">{p.why}</div>}
                      {p.blocked && <div className="mt-0.5 text-signal-amber">{p.blocked}</div>}
                    </div>
                  );
                })}
                {m.plan.filter((p, i) => !p.generative && !p.blocked && !m.applied?.includes(i)).length > 1 && (
                  <Button size="sm" onClick={() => applyFree(mi, m.plan!.map((p, i) => (!p.generative && !p.blocked && !m.applied?.includes(i) ? i : -1)).filter((i) => i >= 0))}>Apply all free edits</Button>
                )}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-xs text-fog-300"><Spinner /> Planning…</div>}
      </div>
      <form className="mt-2 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000} placeholder={effective === 'project' ? 'e.g. Make the colours consistent' : 'e.g. Better, but make the jacket slightly darker'} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} className="min-h-0 text-sm" />
        <Button type="submit" size="icon" disabled={busy || !text.trim()} aria-label="Send"><ArrowUp /></Button>
      </form>
    </div>
  );
}
