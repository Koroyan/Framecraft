'use client';

import { useState } from 'react';
import { Blend, Crop, FastForward, Film, ImageIcon, MessageSquareQuote, Mountain, Palette, PersonStanding, Sparkles, Sun, Video, Wand2, X } from 'lucide-react';
import { CAMERA_PRESETS, describeDirectorOp, isPaidDirectorOp, type AiEditMode, type CameraKey, type DirectorItem, type DirectorOp, type DirectorScope } from '@framecraft/shared';
import { useAssistant } from '@/lib/assistant';
import { directorNames, quickContextFor, scopeLabel } from '@/lib/director';
import type { DirectorDeps } from '../director-chat';
import { cn } from '@/lib/utils';

/*
 * AI actions you can drag onto a shot (or click with a shot selected). Each opens a small card with
 * only what that action needs; the result is an ordinary Director plan — free steps apply at once,
 * paid ones show their price and wait for approval.
 */

export const AI_ACTIONS = [
  { key: 'generate', label: 'Generate video', icon: Film, hint: 'Make this shot’s video — price first' },
  { key: 'storyboard', label: 'Storyboard frame', icon: ImageIcon, hint: 'A still preview, much cheaper than video' },
  { key: 'continue', label: 'Continue', icon: FastForward, hint: 'A new shot that starts where this one ends' },
  { key: 'camera', label: 'Camera move', icon: Video, hint: 'How the camera moves (free)' },
  { key: 'dialogue', label: 'Add dialogue', icon: MessageSquareQuote, hint: 'A line someone says (free)' },
  { key: 'fix', label: 'Fix with AI', icon: Wand2, hint: 'Hands, faces, glitches', mode: 'fix' },
  { key: 'background', label: 'New background', icon: Mountain, hint: 'Keep the subject, change the place', mode: 'background' },
  { key: 'relight', label: 'Lighting', icon: Sun, hint: 'Change the light only', mode: 'relight' },
  { key: 'motion', label: 'Change action', icon: PersonStanding, hint: 'Wave, jump, smile…', mode: 'motion' },
  { key: 'restyle', label: 'Restyle', icon: Palette, hint: 'Change the look', mode: 'restyle' },
  { key: 'enhance', label: 'Improve quality', icon: Sparkles, hint: 'Cleaner detail (AI re-render)', mode: 'enhance' },
  { key: 'reframe', label: 'Reframe', icon: Crop, hint: 'Outpaint to another shape', mode: 'reframe' },
  { key: 'match', label: 'Colour match', icon: Blend, hint: 'Match the shot before (free)' },
] as const satisfies readonly { key: string; label: string; icon: unknown; hint: string; mode?: AiEditMode }[];
export type AiActionKey = (typeof AI_ACTIONS)[number]['key'];
export const AI_ACTION_MIME = 'application/x-framecraft-ai-action';

const PLACEHOLDER: Partial<Record<AiActionKey, string>> = {
  fix: 'e.g. fix the hand at 3 seconds',
  background: 'e.g. a snowy village at dusk',
  relight: 'e.g. warm sunset light from the left',
  motion: 'e.g. the robot waves at the camera',
  restyle: 'e.g. make the shirt blue, keep everything else',
  enhance: 'e.g. sharper face, steadier details',
  reframe: 'e.g. 9:16 for Reels — keep the robot centred',
};

export function ActionPalette({ selectedShot, onPick }: { selectedShot: string | null; onPick: (a: AiActionKey) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pointer-events-auto relative">
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-[300px] rounded-2xl border hairline bg-ink-900/97 p-2 shadow-2xl backdrop-blur" role="toolbar" aria-label="AI actions">
          <div className="mb-1.5 px-1 text-[10px] text-fog-400">Drag an action onto a shot{selectedShot ? ' — or click it for the selected shot' : ''}.</div>
          <div className="grid grid-cols-2 gap-1">
            {AI_ACTIONS.map((a) => (
              <button
                key={a.key}
                type="button"
                draggable
                title={a.hint}
                onDragStart={(e) => {
                  e.dataTransfer.setData(AI_ACTION_MIME, a.key);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onDragEnd={() => setOpen(false)}
                onClick={() => {
                  onPick(a.key);
                  if (selectedShot) setOpen(false);
                }}
                className="flex cursor-grab items-center gap-1.5 rounded-xl px-2 py-1.5 text-left text-[11px] text-fog-200 transition hover:bg-white/[0.07] hover:text-white active:cursor-grabbing"
              >
                <a.icon className="size-3.5 shrink-0 text-iris-200" /> <span className="truncate">{a.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cn('flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium shadow-xl backdrop-blur transition', open ? 'border-iris-400 bg-iris-500 text-white' : 'border-iris-400/40 bg-ink-900/90 text-iris-100 hover:bg-iris-500/25')}>
        <Sparkles className="size-3.5" /> AI actions
      </button>
    </div>
  );
}

/** The small form an action needs, then a ready plan in the AI Director's conversation. */
export function ActionCard({ deps, action, shotId, onDone, onClose }: { deps: DirectorDeps; action: AiActionKey; shotId: string; onDone: () => void; onClose: () => void }) {
  const meta = AI_ACTIONS.find((a) => a.key === action)!;
  const shot = deps.studio?.shots.find((s) => s.id === shotId);
  const scope: DirectorScope = { kind: 'shot', shotId };
  const quick = quickContextFor(deps.studio, deps.timeline, scope);
  const generated = Boolean(shot?.versions.length);
  const [text, setText] = useState('');
  const [camera, setCamera] = useState<CameraKey>('dolly_in');
  const [speaker, setSpeaker] = useState(deps.studio?.characters.find((c) => shot?.characterIds.includes(c.id))?.id ?? 'narrator');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const names = directorNames(deps.studio, deps.timeline);

  const plan = (ops: DirectorOp[], request: string, reply: string) => {
    const items: DirectorItem[] = ops.map((op) => ({ op, paid: isPaidDirectorOp(op), summary: describeDirectorOp(op, names) }));
    useAssistant.getState().pushDirectorPlan(deps.projectId, request, reply, { scope, items }, scopeLabel(deps.studio, scope));
    onDone();
  };

  const needsFootage = 'mode' in meta && !generated;
  const submit = () => {
    if (!shot) return;
    switch (action) {
      case 'generate':
        return plan([{ op: 'shot.generate', shotIds: [shot.id] }], generated ? 'Generate a new take of this shot' : 'Generate this shot', 'Here is the price. Nothing runs until you approve it; the new take is kept as a version.');
      case 'storyboard':
        return plan([{ op: 'storyboard.generate', shotIds: [shot.id] }], 'Draw the storyboard frame', 'A still frame to check the shot before paying for video.');
      case 'continue':
        return plan(
          [{ op: 'shot.insert', ref: 'new1', sceneId: shot.sceneId, afterShotId: shot.id, shot: { description: text.trim() || `Continues: ${shot.description}`.slice(0, 500), prompt: '', durationSec: 5, characterIds: shot.characterIds, dialogue: [], ...(generated ? { continueFrom: shot.id } : {}) } }],
          `Continue the action${text.trim() ? `: ${text.trim()}` : ''}`,
          generated ? 'A new shot right after this one, starting from its last frame. Add it (free), then generate it when you are ready.' : 'A new planned shot right after this one (free).',
        );
      case 'camera':
        return generated
          ? plan([{ op: 'timeline', plan: { op: 'camera', shot: quick.shot?.number || 1, preset: camera === 'dolly_out' ? 'pull_out' : camera === 'pan' ? 'pan_right' : camera === 'tilt' ? 'tilt_up' : camera === 'handheld' ? 'handheld' : camera === 'static' ? 'static' : camera === 'tracking' ? 'tracking' : 'push_in', intensity: 0.45 } }], `Camera: ${CAMERA_PRESETS.find((c) => c.key === camera)?.label}`, 'A digital move on the finished footage — free and instant. For a real camera move, regenerate the shot.')
          : plan([{ op: 'shot.update', shotId: shot.id, patch: { camera } }], `Camera: ${CAMERA_PRESETS.find((c) => c.key === camera)?.label}`, 'Saved in the shot’s plan; it is used when the shot is generated.');
      case 'dialogue': {
        const who = deps.studio?.characters.find((c) => c.id === speaker);
        const line = { speaker: who?.name ?? 'Narrator', line: text.trim().slice(0, 400), ...(who ? { characterId: who.id } : {}) };
        return plan([{ op: 'shot.update', shotId: shot.id, patch: { dialogue: [...shot.dialogue, line] } }], `${line.speaker} says “${line.line}”`, generated ? 'Added to the script. The line is voiced when the film’s dialogue is (re)recorded.' : 'Added to the script; it is voiced when the shot is generated.');
      }
      case 'match': {
        const prev = quick.prev;
        if (!prev?.generated || !quick.shot?.number) return plan([], 'Colour match', 'There is no finished shot before this one to match.');
        return plan([{ op: 'timeline', plan: { op: 'match_color', shot: quick.shot.number, fromShot: prev.number } }], 'Match the colour to the shot before', 'Free and instant — Ctrl+Z undoes it.');
      }
      default: {
        if (!('mode' in meta)) return;
        const start = from ? Number(from) : undefined;
        const end = to ? Number(to) : undefined;
        return plan(
          [{ op: 'shot.ai_edit', shotId: shot.id, mode: meta.mode, instruction: `${text.trim()}. Keep everything else in the shot unchanged.`.slice(0, 900), ...(start !== undefined && Number.isFinite(start) ? { startSec: start } : {}), ...(end !== undefined && Number.isFinite(end) ? { endSec: end } : {}) }],
          `${meta.label}: ${text.trim()}`,
          'Only this shot changes, and only the seconds shown; the original stays as a version. Check the price before approving.',
        );
      }
    }
  };

  const needsText = 'mode' in meta || action === 'dialogue';
  return (
    <div className="nodrag nowheel w-[min(360px,90vw)] cursor-default rounded-2xl border border-iris-400/40 bg-ink-900/97 p-3 shadow-2xl backdrop-blur" role="dialog" aria-label={meta.label} onPointerDown={(e) => e.stopPropagation()}>
      <div className="mb-2 flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-lg bg-iris-500/25 text-iris-100"><meta.icon className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-white">{meta.label}</div>
          <div className="truncate text-[10px] text-fog-500">{scopeLabel(deps.studio, scope)} · {meta.hint}</div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="grid size-7 place-items-center rounded-lg text-fog-400 hover:bg-white/[0.06] hover:text-white"><X className="size-4" /></button>
      </div>
      {needsFootage ? (
        <div className="space-y-2 text-xs text-fog-300">
          <p>This shot has no video yet — AI edits change footage. Generate it first, or describe the change in the shot’s plan.</p>
          <button type="button" onClick={() => plan([{ op: 'shot.generate', shotIds: [shotId] }], 'Generate this shot', 'Here is the price. Nothing runs until you approve it.')} className="rounded-lg bg-iris-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-iris-400">Generate it first</button>
        </div>
      ) : (
        <div className="space-y-2">
          {action === 'camera' && (
            <div className="flex flex-wrap gap-1">
              {CAMERA_PRESETS.filter((c) => (generated ? ['dolly_in', 'dolly_out', 'pan', 'tilt', 'handheld', 'tracking', 'static'].includes(c.key) : true)).map((c) => (
                <button key={c.key} type="button" onClick={() => setCamera(c.key)} aria-pressed={camera === c.key} className={cn('rounded-lg border px-2 py-1 text-[11px]', camera === c.key ? 'border-iris-400 bg-iris-500/20 text-white' : 'hairline text-fog-200 hover:border-white/25')}>{c.label}</button>
              ))}
            </div>
          )}
          {action === 'dialogue' && (
            <select value={speaker} onChange={(e) => setSpeaker(e.target.value)} aria-label="Who speaks" className="w-full rounded-lg border hairline bg-black/30 px-2 py-1.5 text-xs text-white">
              <option value="narrator">Narrator</option>
              {(deps.studio?.characters ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {(needsText || action === 'continue') && (
            <textarea
              autoFocus
              rows={2}
              value={text}
              maxLength={600}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label={action === 'dialogue' ? 'The line' : 'What should change'}
              placeholder={action === 'dialogue' ? 'The line, in any language' : action === 'continue' ? 'What happens next (optional)' : PLACEHOLDER[action]}
              className="w-full resize-none rounded-lg border hairline bg-black/30 px-2.5 py-2 text-sm text-white placeholder:text-fog-500 focus:border-iris-400 focus:outline-none"
            />
          )}
          {'mode' in meta && meta.mode !== 'reframe' && (
            <div className="flex items-center gap-1.5 text-[11px] text-fog-400">
              Only seconds
              <input value={from} onChange={(e) => setFrom(e.target.value.replace(/[^\d.]/g, ''))} placeholder="from" aria-label="From second" className="w-14 rounded-md border hairline bg-black/30 px-1.5 py-1 text-white" />
              –
              <input value={to} onChange={(e) => setTo(e.target.value.replace(/[^\d.]/g, ''))} placeholder="to" aria-label="To second" className="w-14 rounded-md border hairline bg-black/30 px-1.5 py-1 text-white" />
              <span className="text-fog-500">(empty = whole shot)</span>
            </div>
          )}
          <button type="button" disabled={needsText && !text.trim()} onClick={submit} className="w-full rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-ink-950 hover:bg-fog-100 disabled:opacity-40">
            {'mode' in meta || action === 'generate' || action === 'storyboard' ? 'Show the plan and price' : 'Show the change'}
          </button>
        </div>
      )}
    </div>
  );
}
