'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, type Location } from '@/lib/api';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import { CAMERA_PRESETS } from '@framecraft/shared';
import { scopeLabel } from '@/lib/director';
import { cn } from '@/lib/utils';
import type { DirectorDeps } from '../director-chat';

/**
 * + Location for a scene: a saved place from the Location library. Its reference photos go into
 * every shot of the scene (prompts and keyframes), so the place stays the same from shot to shot.
 */
export function PlacePicker({ deps, sceneId }: { deps: DirectorDeps; sceneId: string }) {
  const places = useQuery({ queryKey: ['locations'], queryFn: () => api<{ locations: Location[] }>('/api/locations'), staleTime: 60_000 });
  const scene = deps.studio?.scenes.find((s) => s.id === sceneId);
  const [busy, setBusy] = useState(false);
  const set = async (locationId: string) => {
    setBusy(true);
    try {
      await api(`/api/projects/${deps.projectId}/director/apply`, { body: { ops: [{ op: 'scene.update', sceneId, locationId: locationId || null }], scope: { kind: 'project' } } });
      await deps.refetch();
      toast.success(locationId ? 'Place set for the whole scene' : 'Place removed');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not set the place');
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="block text-[11px] text-fog-400">
      Place (whole scene)
      <span className="mt-1 flex items-center gap-1.5">
        <select value={scene?.locationId ?? ''} disabled={busy} onChange={(e) => void set(e.target.value)} aria-label="Place of this scene" className="min-w-0 flex-1 rounded-lg border hairline bg-black/30 px-2 py-1.5 text-xs text-white focus:border-iris-400 focus:outline-none">
          <option value="">{scene?.place && !scene.locationId ? scene.place : 'No saved place'}</option>
          {(places.data?.locations ?? []).map((l) => (
            <option key={l.id} value={l.id}>{l.name}{l.references.length ? '' : ' (no photo yet)'}</option>
          ))}
        </select>
        <Link href="/app/locations" className="shrink-0 rounded-lg border hairline px-2 py-1.5 text-[11px] text-iris-300 hover:text-white">+ Location</Link>
      </span>
    </label>
  );
}

/**
 * A shot's plan in place: what happens, camera, length, who is in it and what they say, and the
 * full generation prompt for those who want it. Saving is free; a generated shot keeps its video
 * until it is regenerated.
 */
export function ShotDetailsCard({ deps, shotId, onSave, onClose }: { deps: DirectorDeps; shotId: string; onSave: (patch: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const shot = deps.studio?.shots.find((s) => s.id === shotId);
  const [description, setDescription] = useState(shot?.description ?? '');
  const [prompt, setPrompt] = useState(shot?.prompt ?? '');
  const [camera, setCamera] = useState(shot?.camera ?? '');
  const [duration, setDuration] = useState(shot?.durationSec ?? 5);
  const [cast, setCast] = useState<string[]>(shot?.characterIds ?? []);
  const [lines, setLines] = useState(shot?.dialogue ?? []);
  const [busy, setBusy] = useState(false);
  if (!shot) return null;
  const generated = shot.versions.length > 0;
  const save = async () => {
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {};
      if (description.trim() && description.trim() !== shot.description) patch.description = description.trim().slice(0, 500);
      if (prompt.trim() && prompt.trim() !== shot.prompt) patch.prompt = prompt.trim().slice(0, 4000);
      if ((camera || null) !== (shot.camera ?? null)) patch.camera = camera || null;
      if (duration !== shot.durationSec) patch.durationSec = duration;
      if (cast.join() !== shot.characterIds.join()) patch.characterIds = cast;
      const clean = lines.filter((l) => l.line.trim()).map((l) => ({ ...l, line: l.line.trim().slice(0, 400) }));
      if (JSON.stringify(clean) !== JSON.stringify(shot.dialogue)) patch.dialogue = clean;
      if (Object.keys(patch).length) await onSave(patch);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  const field = 'w-full rounded-lg border hairline bg-black/30 px-2.5 py-1.5 text-xs text-white focus:border-iris-400 focus:outline-none';
  return (
    <div className="nodrag nowheel max-h-[70vh] w-[min(380px,92vw)] cursor-default overflow-y-auto rounded-2xl border border-white/15 bg-ink-900/98 p-3 shadow-2xl" role="dialog" aria-label="Shot details" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold text-white">Shot details</div>
          <div className="text-[10px] text-fog-500">{scopeLabel(deps.studio, { kind: 'shot', shotId })}{generated ? ' · changes apply when you regenerate' : ''}</div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="grid size-7 place-items-center rounded-lg text-fog-400 hover:bg-white/[0.06] hover:text-white"><X className="size-4" /></button>
      </div>
      <div className="space-y-2.5">
        <label className="block text-[11px] text-fog-400">
          What happens
          <textarea value={description} rows={2} maxLength={500} onChange={(e) => setDescription(e.target.value)} className={cn(field, 'mt-1 resize-none')} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[11px] text-fog-400">
            Camera
            <select value={camera} onChange={(e) => setCamera(e.target.value)} className={cn(field, 'mt-1')}>
              <option value="">Director decides</option>
              {CAMERA_PRESETS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <label className="block text-[11px] text-fog-400">
            Length · {duration} s
            <input type="range" min={2} max={30} step={1} value={duration} disabled={generated} onChange={(e) => setDuration(Number(e.target.value))} className="mt-2.5 w-full accent-iris-500 disabled:opacity-40" aria-label="Length in seconds" />
          </label>
        </div>
        <PlacePicker deps={deps} sceneId={shot.sceneId} />
        {(deps.studio?.characters.length ?? 0) > 0 && (
          <div className="text-[11px] text-fog-400">
            In this shot
            <div className="mt-1 flex flex-wrap gap-1">
              {deps.studio!.characters.map((c) => {
                const on = cast.includes(c.id);
                return (
                  <button key={c.id} type="button" aria-pressed={on} onClick={() => setCast((x) => (on ? x.filter((y) => y !== c.id) : [...x, c.id]))} className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]', on ? 'border-iris-400 bg-iris-500/20 text-white' : 'hairline text-fog-300 hover:border-white/25')}>
                    {c.imageUrl ? <img src={c.imageUrl} alt="" className="size-4 rounded-full object-cover" /> : null}
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="text-[11px] text-fog-400">
          Dialogue
          <div className="mt-1 space-y-1">
            {lines.map((l, i) => (
              <div key={i} className="flex items-center gap-1">
                <input value={l.speaker} aria-label="Speaker" onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, speaker: e.target.value.slice(0, 60) } : y)))} className={cn(field, 'w-24 shrink-0')} />
                <input value={l.line} aria-label="Line" onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, line: e.target.value } : y)))} className={field} />
                <button type="button" aria-label="Remove line" onClick={() => setLines((x) => x.filter((_, j) => j !== i))} className="grid size-7 shrink-0 place-items-center rounded-lg text-fog-400 hover:text-signal-red"><Trash2 className="size-3.5" /></button>
              </div>
            ))}
            <button type="button" onClick={() => setLines((x) => [...x, { speaker: deps.studio?.characters.find((c) => cast.includes(c.id))?.name ?? 'Narrator', line: '' }])} className="flex items-center gap-1 text-[11px] text-iris-200 hover:text-white"><Plus className="size-3" /> Add a line</button>
          </div>
        </div>
        <details className="text-[11px] text-fog-400">
          <summary className="cursor-pointer select-none">Generation prompt (advanced)</summary>
          <textarea value={prompt} rows={5} maxLength={4000} onChange={(e) => setPrompt(e.target.value)} className={cn(field, 'mt-1 resize-y font-mono text-[11px]')} />
        </details>
        <button type="button" disabled={busy} onClick={save} className="flex w-full items-center justify-center gap-1 rounded-lg bg-white py-1.5 text-xs font-medium text-ink-950 hover:bg-fog-100 disabled:opacity-50">
          {busy && <Loader2 className="size-3 animate-spin" />} Save (free)
        </button>
      </div>
    </div>
  );
}
