'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Clock, Plus, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { DirectorOp, DirectorScope, Timeline } from '@framecraft/shared';
import { api, ApiError } from '@/lib/api';
import type { StudioData, StudioShot } from '@/lib/studio';
import { cn, seconds } from '@/lib/utils';
import { AskCard, type DirectorDeps } from './director-chat';
import { PlacePicker } from './graph/details';

/*
 * The script: the same scenes and shots as the storyboard and graph, written as a screenplay —
 * scene headings, action, dialogue and timing — and edited in place. AI rewrites of a scene come
 * as a plan you review before anything changes.
 */

type Props = { projectId: string; studio: StudioData | undefined; timeline: Timeline; apply: (fn: (t: Timeline) => Timeline) => void; refetch: () => unknown; onOpenStoryboard: () => void };

function Editable({ value, onSave, className, multiline, label, placeholder }: { value: string; onSave: (v: string) => void; className?: string; multiline?: boolean; label: string; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v.trim() !== value.trim()) onSave(v.trim());
  };
  return multiline ? (
    <textarea value={v} aria-label={label} placeholder={placeholder} rows={Math.min(6, Math.max(1, Math.ceil(v.length / 90)))} onChange={(e) => setV(e.target.value)} onBlur={commit} className={cn('w-full resize-none rounded-md border border-transparent bg-transparent px-1.5 py-0.5 hover:border-white/10 focus:border-iris-400/60 focus:bg-black/20 focus:outline-none', className)} />
  ) : (
    <input value={v} aria-label={label} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} className={cn('w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 hover:border-white/10 focus:border-iris-400/60 focus:bg-black/20 focus:outline-none', className)} />
  );
}

export function ScriptView({ projectId, studio, timeline, apply, refetch, onOpenStoryboard }: Props) {
  const deps: DirectorDeps = { projectId, studio, timeline, apply, refetch };
  const [ask, setAsk] = useState<string | null>(null);
  const run = async (ops: DirectorOp[], ok?: string) => {
    try {
      await api(`/api/projects/${projectId}/director/apply`, { body: { ops, scope: { kind: 'project' } } });
      await refetch();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    }
  };
  const updateShot = (s: StudioShot, patch: Record<string, unknown>) => run([{ op: 'shot.update', shotId: s.id, patch } as DirectorOp]);
  const scenes = studio?.scenes ?? [];
  const shotsOf = (sceneId: string) => (studio?.shots ?? []).filter((s) => s.sceneId === sceneId).sort((a, b) => a.index - b.index);
  const total = (studio?.shots ?? []).reduce((s, x) => s + x.durationSec, 0);

  if (!scenes.length) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-md">
          <div className="text-lg font-semibold text-white">No script yet</div>
          <p className="mt-1 text-sm text-fog-300">A script is written by the AI Director when you create a film or a cartoon — then every scene and shot is editable here, in the storyboard and in the graph. Your own clips can be turned into shots with Ask AI in the storyboard.</p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/app/cartoon" className="rounded-xl bg-iris-500 px-3 py-2 text-xs font-medium text-white hover:bg-iris-400">Create a cartoon</Link>
            <Link href="/app/movie" className="rounded-xl border hairline px-3 py-2 text-xs text-fog-100 hover:bg-white/[0.05]">Create a film</Link>
            <button type="button" onClick={onOpenStoryboard} className="rounded-xl border hairline px-3 py-2 text-xs text-fog-100 hover:bg-white/[0.05]">Open the storyboard</button>
          </div>
        </div>
      </div>
    );
  }

  let clock = 0;
  return (
    <div className="h-full overflow-y-auto" data-testid="script-view">
      <div className="mx-auto max-w-3xl px-5 py-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-iris-400">Script · {scenes.length} scene{scenes.length === 1 ? '' : 's'} · {(studio?.shots ?? []).length} shots</div>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-fog-400"><Clock className="size-3.5" /> About {seconds(total)} as planned · edits here change the storyboard, the graph and future generations (generated shots keep their video until regenerated).</p>
        <div className="mt-6 space-y-8">
          {scenes.map((sc, i) => {
            const list = shotsOf(sc.id);
            const len = list.reduce((s, x) => s + x.durationSec, 0);
            const from = clock;
            clock += len;
            const scope: DirectorScope = { kind: 'scene', sceneId: sc.id };
            return (
              <section key={sc.id} aria-label={`Scene ${i + 1}`} className="rounded-2xl border hairline bg-ink-900/60 p-4">
                <div className="flex items-start gap-3">
                  <span className="mt-1 shrink-0 rounded-lg border border-iris-400/40 px-2 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-iris-300">SCENE {i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <Editable label={`Scene ${i + 1} title`} value={sc.title} onSave={(v) => v && void run([{ op: 'scene.update', sceneId: sc.id, title: v.slice(0, 120) }], 'Scene renamed')} className="font-mono text-sm font-semibold uppercase tracking-wide text-white" />
                    <Editable label={`Scene ${i + 1} synopsis`} multiline value={sc.synopsis} placeholder="What happens in this scene" onSave={(v) => void run([{ op: 'scene.update', sceneId: sc.id, synopsis: v.slice(0, 2000) }], 'Saved')} className="mt-0.5 text-xs leading-relaxed text-fog-300" />
                  </div>
                  <span className="shrink-0 pt-1 text-[11px] tabular-nums text-fog-500">{seconds(from)}–{seconds(from + len)}</span>
                  <button type="button" onClick={() => setAsk(ask === sc.id ? null : sc.id)} className={cn('flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px]', ask === sc.id ? 'bg-iris-500 text-white' : 'bg-iris-500/15 text-iris-100 hover:bg-iris-500/30')}><Sparkles className="size-3" /> Rewrite with AI</button>
                </div>
                <div className="mt-2 max-w-xs pl-[72px]"><PlacePicker deps={deps} sceneId={sc.id} /></div>
                {ask === sc.id && (
                  <div className="mt-3 pl-[72px]">
                    <AskCard deps={deps} scope={scope} onClose={() => setAsk(null)} />
                  </div>
                )}
                <ol className="mt-4 space-y-3 pl-[72px]">
                  {list.map((s, j) => (
                    <li key={s.id} className="group rounded-xl border border-transparent p-2 hover:border-white/[0.06]" data-testid="script-shot">
                      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-fog-500">
                        <span>Shot {j + 1}</span>
                        <span>·</span>
                        <label className="flex items-center gap-1 normal-case">
                          <input type="number" min={2} max={30} defaultValue={s.durationSec} aria-label={`Shot ${j + 1} length in seconds`} onBlur={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 2 && n <= 30 && n !== s.durationSec) void updateShot(s, { durationSec: n }); }} className="w-10 rounded bg-black/30 px-1 text-center text-fog-200" /> s
                        </label>
                        {s.camera && <><span>·</span><span>{s.camera.replaceAll('_', ' ')}</span></>}
                        {s.versions.length > 0 && <span className="rounded bg-emerald-500/15 px-1 text-emerald-300 normal-case">has video</span>}
                      </div>
                      <Editable label={`Shot ${j + 1} action`} multiline value={s.description} onSave={(v) => v && void updateShot(s, { description: v.slice(0, 500) })} className="mt-1 text-sm leading-relaxed text-fog-100" />
                      {s.dialogue.map((d, k) => (
                        <div key={k} className="mx-auto mt-1.5 max-w-md text-center">
                          <Editable label={`Speaker of line ${k + 1}`} value={d.speaker} onSave={(v) => v && void updateShot(s, { dialogue: s.dialogue.map((x, m) => (m === k ? { ...x, speaker: v.slice(0, 60) } : x)) })} className="text-center font-mono text-[11px] font-semibold uppercase tracking-wide text-iris-200" />
                          <div className="flex items-start gap-1">
                            <Editable label={`Line ${k + 1}`} multiline value={d.line} onSave={(v) => void updateShot(s, { dialogue: v ? s.dialogue.map((x, m) => (m === k ? { ...x, line: v.slice(0, 400) } : x)) : s.dialogue.filter((_, m) => m !== k) })} className="text-center text-sm text-white" />
                            <button type="button" aria-label={`Delete line ${k + 1}`} onClick={() => void updateShot(s, { dialogue: s.dialogue.filter((_, m) => m !== k) })} className="mt-1 opacity-0 transition group-hover:opacity-100"><Trash2 className="size-3 text-fog-500 hover:text-signal-red" /></button>
                          </div>
                        </div>
                      ))}
                      <button type="button" onClick={() => void updateShot(s, { dialogue: [...s.dialogue, { speaker: studio?.characters.find((c) => s.characterIds.includes(c.id))?.name ?? 'Narrator', line: '…' }] })} className="mt-1 flex items-center gap-1 text-[11px] text-fog-500 opacity-0 transition hover:text-iris-200 group-hover:opacity-100"><Plus className="size-3" /> Add a line</button>
                    </li>
                  ))}
                </ol>
                <button type="button" onClick={() => void run([{ op: 'shot.insert', ref: 'new1', sceneId: sc.id, afterShotId: list.at(-1)?.id ?? null, shot: { description: 'New shot — describe what happens', prompt: '', durationSec: 5, characterIds: list.at(-1)?.characterIds ?? [], dialogue: [] } }], 'Shot added')} className="ml-[72px] mt-2 flex items-center gap-1 text-[11px] text-iris-300 hover:text-white"><Plus className="size-3" /> Add a shot</button>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
