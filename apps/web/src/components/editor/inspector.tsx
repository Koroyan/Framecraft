'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, AudioLines, ChevronsRight, Copy, Crosshair, Film, ImagePlus, Layers, MousePointerClick, Music, Mic, Pause, Plus, RotateCcw, Scissors, Settings2, Sparkles, Trash2, Type } from 'lucide-react';
import { toast } from 'sonner';
import { applyPlanOp, clipDuration, describeEffects, LOOKS, type Timeline } from '@framecraft/shared';
import { api, ApiError, type Asset } from '@/lib/api';
import { clipStarts, moveClip, newId, splitClip, useEditor } from '@/lib/editor-store';
import { useObjectUi } from '@/lib/object-ui';
import { Badge, Button, Dialog, Field, Input, NativeSelect, Segmented, Spinner, Switch } from '@/components/ui';
import { ColorPro } from '@/components/editor/color-pro';
import { LayersPanel } from '@/components/editor/layers';
import { ObjectInspector } from '@/components/editor/object-tool';
import { TranscribeButton, type LibraryKind } from '@/components/editor/editor-dialogs';
import { cn, newKey, seconds } from '@/lib/utils';

export type Focus = 'clip' | 'layer' | 'audio' | 'object' | 'project';
type Apply = (fn: (t: Timeline) => Timeline) => void;
type Logo = NonNullable<Timeline['logo']>;

const TRANSITIONS = ['cut', 'fade', 'dissolve', 'fadeblack', 'wipeleft', 'wiperight', 'slideup', 'circleopen'] as const;
const SPEEDS = [0.5, 1, 1.5, 2, 3] as const;

export type InspectorProps = {
  projectId: string;
  timeline: Timeline;
  apply: Apply;
  assets: Map<string, Asset>;
  playhead: number;
  setPlayhead: (t: number) => void;
  focus: Focus;
  setFocus: (f: Focus) => void;
  selectedClipId: string | null;
  selectClip: (id: string | null) => void;
  selectedLayer: string | null;
  setSelectedLayer: (id: string | null) => void;
  selectedAudio: string | null;
  setSelectedAudio: (id: string | null) => void;
  onOpenShot: (clipId: string) => void;
  onLibrary: (kind: LibraryKind) => void;
  onUploadLogo: () => void;
  onUploadAudio: () => void;
  onTts: () => void;
  onRefetchAssets: () => void;
  onPickLayerAsset: (kind: 'image' | 'video', cb: (a: Asset) => void) => void;
  onEditStarted?: () => void;
  /** Collapse the panel (wide layouts). */
  onHide?: () => void;
};

const HEAD: Record<Focus, { icon: typeof Film; label: string }> = {
  clip: { icon: Film, label: 'Clip' },
  layer: { icon: Layers, label: 'Layer' },
  audio: { icon: AudioLines, label: 'Audio' },
  object: { icon: MousePointerClick, label: 'Object' },
  project: { icon: Settings2, label: 'Project' },
};

/** Properties of whatever is selected — it follows the selection (clip, layer, audio, object). */
export function Inspector(p: InspectorProps) {
  const extra = useEditor((s) => s.extra);
  const sel = p.timeline.clips.find((c) => c.id === p.selectedClipId);
  const focus: Focus = p.focus === 'clip' && !sel ? 'project' : p.focus;
  const H = HEAD[focus];
  const index = sel ? p.timeline.clips.indexOf(sel) : -1;
  const many = focus === 'clip' && sel && extra.length > 0;
  const title = many ? `${extra.length + 1} clips selected` : focus === 'clip' && sel ? `Clip ${index + 1}` : focus === 'layer' ? (p.timeline.layers.find((l) => l.id === p.selectedLayer)?.name ?? 'Layers') : H.label;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b hairline px-3">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-white">
          <H.icon className="size-4 shrink-0 text-iris-300" />
          <span className="truncate">{title}</span>
          {focus === 'clip' && sel && <span className="shrink-0 text-[11px] font-normal text-fog-400">{seconds(clipDuration(sel))}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={() => p.setFocus(focus === 'project' ? (sel ? 'clip' : 'project') : 'project')} className={cn('flex h-7 items-center gap-1 rounded-md px-2 text-[11px]', focus === 'project' ? 'bg-white/10 text-white' : 'text-fog-400 hover:bg-white/[0.06] hover:text-white')} title="Format, logo, subtitles">
            <Settings2 className="size-3.5" /> Project
          </button>
          {p.onHide && (
            <button type="button" onClick={p.onHide} aria-label="Hide properties" title="Hide properties" className="grid size-7 place-items-center rounded-md text-fog-500 hover:bg-white/[0.06] hover:text-white">
              <ChevronsRight className="size-3.5" />
            </button>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {focus === 'clip' && sel && (many ? <BatchPanel {...p} ids={[sel.id, ...extra]} /> : <ClipPanel {...p} />)}
        {focus === 'layer' && <LayersPanel timeline={p.timeline} apply={p.apply} playhead={p.playhead} selectedId={p.selectedLayer} setSelectedId={p.setSelectedLayer} logoAssetId={p.timeline.logo?.assetId} onPickAsset={p.onPickLayerAsset} />}
        {focus === 'audio' && <AudioPanel {...p} />}
        {focus === 'object' && <ObjectInspector projectId={p.projectId} timeline={p.timeline} apply={p.apply} playhead={p.playhead} setPlayhead={p.setPlayhead} clipStart={(() => { const t = p.timeline; const ref = useObjectUi.getState().sel; const i = t.clips.findIndex((c) => c.id === ref?.clipId); return i >= 0 ? (clipStarts(t)[i] ?? 0) : 0; })()} />}
        {focus === 'project' && <ProjectPanel {...p} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ several clips

function BatchPanel(p: InspectorProps & { ids: string[] }) {
  const ids = new Set(p.ids);
  const t = p.timeline;
  const clips = t.clips.filter((c) => ids.has(c.id));
  const each = (fn: (c: Timeline['clips'][number], i: number) => void) =>
    p.apply((tl) => {
      tl.clips.forEach((c, i) => ids.has(c.id) && fn(c, i));
      return tl;
    });
  const sameSpeed = clips.every((c) => c.speed === clips[0]!.speed) ? clips[0]!.speed : null;
  const vol = Math.round((clips.reduce((s, c) => s + c.volume, 0) / clips.length) * 100) / 100;
  return (
    <div className="space-y-4">
      <p className="text-xs text-fog-400">Changes here apply to all {clips.length} selected clips. Shift- or Ctrl-click a clip on the timeline to add or remove it.</p>
      <Field label="Transition into the next clip">
        <div className="flex flex-wrap gap-1">
          {TRANSITIONS.map((x) => (
            <button key={x} type="button" onClick={() => each((c, i) => (c.transition = x === 'cut' || i === t.clips.length - 1 ? undefined : { type: x, durationSec: Math.min(0.5, clipDuration(c) / 3) }))} className="rounded-lg border hairline px-2 py-1 text-[11px] text-fog-200 hover:border-white/25">{x}</button>
          ))}
        </div>
      </Field>
      <Field label={`Speed${sameSpeed ? ` · ${sameSpeed}×` : ' · mixed'}`}>
        <div className="flex gap-1">
          {SPEEDS.map((v) => (
            <button key={v} type="button" onClick={() => each((c) => !c.freezeSec && (c.speed = v))} className={cn('flex-1 rounded-lg border py-1 text-xs', sameSpeed === v ? 'border-iris-400 bg-iris-500/20 text-white' : 'hairline text-fog-300 hover:border-white/25')}>{v}×</button>
          ))}
        </div>
      </Field>
      <Field label={`Volume · ${Math.round(vol * 100)}%`}>
        <input type="range" aria-label="Volume of the selected clips" className="w-full" min={0} max={2} step={0.05} value={vol} onChange={(e) => each((c) => (c.volume = Number(e.target.value)))} />
      </Field>
      <Field label="Look">
        <div className="flex flex-wrap gap-1">
          {LOOKS.map((l) => (
            <button key={l.key} type="button" onClick={() => p.apply((tl) => applyPlanOp(tl, { op: 'look', clipIds: p.ids, key: l.key }, () => newId('clip')))} className="rounded-lg border hairline px-2 py-1 text-[11px] text-fog-200 hover:border-white/25">{l.label}</button>
          ))}
          <button type="button" onClick={() => each((c) => (c.adjust = undefined))} className="rounded-lg border hairline px-2 py-1 text-[11px] text-fog-400 hover:border-white/25">Original</button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" variant="ghost" onClick={() => useEditor.getState().clearExtra()}>Select one</Button>
        <Button
          size="sm"
          variant="danger"
          disabled={clips.length >= t.clips.length}
          onClick={() => {
            p.apply((tl) => ({ ...tl, clips: tl.clips.filter((c) => !ids.has(c.id)) }));
            p.selectClip(null);
            toast.success(`Removed ${clips.length} clips — Ctrl+Z undoes it`);
          }}
        >
          <Trash2 /> Remove {clips.length}
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ clip

type ClipTab = 'edit' | 'color' | 'objects' | 'ai';

function ClipPanel(p: InspectorProps) {
  const [tab, setTab] = useState<ClipTab>('edit');
  const t = p.timeline;
  const selIndex = t.clips.findIndex((c) => c.id === p.selectedClipId);
  const sel = t.clips[selIndex]!;
  const asset = p.assets.get(sel.assetId);
  const max = asset?.durationMs ? asset.durationMs / 1000 : sel.outSec;
  const starts = clipStarts(t);
  const set = (fn: (c: Timeline['clips'][number]) => void) =>
    p.apply((tl) => {
      fn(tl.clips[selIndex]!);
      return tl;
    });
  const objects = sel.objects ?? [];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-1 rounded-xl border hairline bg-white/[0.02] p-1" role="tablist" aria-label="Clip tools">
        {(
          [
            ['edit', Scissors, 'Edit'],
            ['color', Sparkles, 'Colour'],
            ['objects', MousePointerClick, `Objects${objects.length ? ` ${objects.length}` : ''}`],
            ['ai', Sparkles, 'AI'],
          ] as const
        ).map(([k, Icon, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('flex items-center justify-center gap-1 rounded-lg px-1.5 py-1.5 text-[11px]', tab === k ? 'bg-iris-500 text-white' : 'text-fog-300 hover:bg-white/[0.06]')}>
            <Icon className="size-3" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'edit' && (
        <div className="space-y-4">
          {asset?.isFixture && <Badge tone="amber">test fixture — not AI</Badge>}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Starts at (source s)">
              <Input type="number" step={0.05} min={0} max={sel.outSec - 0.2} value={Math.round(sel.inSec * 100) / 100} onChange={(e) => set((c) => (c.inSec = Math.min(Math.max(0, Number(e.target.value)), c.outSec - 0.2)))} className="h-9" />
            </Field>
            <Field label="Ends at (source s)">
              <Input type="number" step={0.05} min={sel.inSec + 0.2} max={max} value={Math.round(sel.outSec * 100) / 100} onChange={(e) => set((c) => (c.outSec = Math.min(max, Math.max(Number(e.target.value), c.inSec + 0.2))))} className="h-9" />
            </Field>
          </div>
          <p className="-mt-2 text-[11px] text-fog-500">Tip: drag the clip’s edges on the timeline to trim.</p>
          <Field label={`Speed · ${sel.speed}×`} hint={sel.freezeSec ? 'Freeze frames hold one frame.' : `Lasts ${seconds(clipDuration(sel))} on the timeline.`}>
            <div className="flex gap-1">
              {SPEEDS.map((s) => (
                <button key={s} type="button" disabled={Boolean(sel.freezeSec)} onClick={() => set((c) => (c.speed = s))} className={cn('flex-1 rounded-lg border py-1 text-xs', sel.speed === s ? 'border-iris-400 bg-iris-500/20 text-white' : 'hairline text-fog-300 hover:border-white/25')}>{s}×</button>
              ))}
            </div>
            <input type="range" aria-label="Speed" className="mt-2 w-full" min={0.25} max={4} step={0.05} value={sel.speed} disabled={Boolean(sel.freezeSec)} onChange={(e) => set((c) => (c.speed = Number(e.target.value)))} />
          </Field>
          <Field label={`Volume · ${Math.round(sel.volume * 100)}%`}>
            <input type="range" aria-label="Clip volume" className="w-full" min={0} max={2} step={0.05} value={sel.volume} onChange={(e) => set((c) => (c.volume = Number(e.target.value)))} />
          </Field>
          <Field label="Transition into the next clip">
            <div className="grid grid-cols-[1fr_80px] gap-2">
              <NativeSelect aria-label="Transition" value={sel.transition?.type ?? 'cut'} onChange={(e) => set((c) => (c.transition = e.target.value === 'cut' ? undefined : { type: e.target.value as (typeof TRANSITIONS)[number], durationSec: c.transition?.durationSec ?? 0.5 }))}>
                {TRANSITIONS.map((x) => <option key={x}>{x}</option>)}
              </NativeSelect>
              <Input type="number" step={0.1} min={0.1} max={3} aria-label="Transition seconds" value={sel.transition?.durationSec ?? 0.5} disabled={!sel.transition} onChange={(e) => set((c) => c.transition && (c.transition.durationSec = Number(e.target.value)))} className="h-9" />
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={`Fade in · ${sel.fadeInSec}s`}><input type="range" aria-label="Fade in" className="w-full" min={0} max={3} step={0.1} value={sel.fadeInSec} onChange={(e) => set((c) => (c.fadeInSec = Number(e.target.value)))} /></Field>
            <Field label={`Fade out · ${sel.fadeOutSec}s`}><input type="range" aria-label="Fade out" className="w-full" min={0} max={3} step={0.1} value={sel.fadeOutSec} onChange={(e) => set((c) => (c.fadeOutSec = Number(e.target.value)))} /></Field>
          </div>
          <Field label={`Opacity · ${Math.round(sel.opacity * 100)}%`} hint="Fades the picture towards black.">
            <input type="range" aria-label="Opacity" className="w-full" min={0} max={1} step={0.05} value={sel.opacity} onChange={(e) => set((c) => (c.opacity = Number(e.target.value)))} />
          </Field>
          <label className="flex items-center justify-between text-sm text-fog-200">Play backwards <Switch checked={sel.reverse} onCheckedChange={(v) => set((c) => (c.reverse = v))} label="Reverse clip" /></label>
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="secondary" onClick={() => p.apply((tl) => splitClip(tl, sel.id, sel.inSec + (p.playhead - (starts[selIndex] ?? 0)) * (sel.speed || 1)))}><Scissors /> Split (S)</Button>
            <Button size="sm" variant="secondary" onClick={() => p.onLibrary('replace')}><RotateCcw /> Replace</Button>
            <Button size="sm" variant="secondary" onClick={() => p.apply((tl) => { const c = tl.clips[selIndex]!; const at = Math.min(c.outSec - 0.05, c.inSec + (p.playhead - (starts[selIndex] ?? 0)) * (c.speed || 1)); tl.clips.splice(selIndex + 1, 0, { ...c, id: newId('clip'), inSec: Math.max(0, at), outSec: Math.max(at + 0.1, c.outSec), freezeSec: 2, transition: undefined, camera: undefined, objects: undefined }); return tl; })}><Pause /> Freeze frame</Button>
            <Button size="sm" variant="secondary" onClick={() => p.apply((tl) => { const c = tl.clips[selIndex]!; tl.clips.splice(selIndex + 1, 0, { ...c, id: newId('clip'), transition: undefined }); return tl; })}><Copy /> Duplicate</Button>
            <Button size="sm" variant="ghost" onClick={() => p.apply((tl) => moveClip(tl, sel.id, -1))} disabled={selIndex === 0}><ArrowLeft /> Earlier</Button>
            <Button size="sm" variant="ghost" onClick={() => p.apply((tl) => moveClip(tl, sel.id, 1))} disabled={selIndex === t.clips.length - 1}>Later <ArrowRight /></Button>
          </div>
          <Button size="sm" variant="danger" className="w-full" disabled={t.clips.length < 2} onClick={() => { p.apply((tl) => ({ ...tl, clips: tl.clips.filter((c) => c.id !== sel.id) })); p.selectClip(null); }}><Trash2 /> Remove from timeline</Button>
          <p className="text-[11px] text-fog-500">Removing keeps the file in Media.</p>
        </div>
      )}

      {tab === 'color' && (
        <ColorPro
          adjust={sel.adjust}
          onChange={(a) => set((c) => (c.adjust = a))}
          onCopyToAll={() => {
            p.apply((tl) => ({ ...tl, clips: tl.clips.map((c) => ({ ...c, adjust: sel.adjust ? { ...sel.adjust, replace: undefined } : undefined })) }));
            toast.success('Colour applied to every clip');
          }}
          otherShots={t.clips.filter((c) => c.id !== sel.id && c.adjust).map((c) => ({ label: c.label ?? `Clip ${t.clips.indexOf(c) + 1}`, adjust: c.adjust }))}
          onMatchFrom={(a) => set((c) => (c.adjust = a ? { ...a, replace: c.adjust?.replace } as typeof c.adjust : undefined))}
        />
      )}

      {tab === 'objects' && (
        <div className="space-y-3">
          <Button size="sm" className="w-full" onClick={() => useObjectUi.getState().set({ selecting: true })}><MousePointerClick /> Select an object in the picture</Button>
          <p className="text-[11px] text-fog-400">Click a jacket, a product, a face… then change its colour, light or blur — only that object, only the seconds you choose. Free.</p>
          {objects.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => {
                useObjectUi.getState().set({ sel: { clipId: sel.id, objectId: o.id } });
                p.setFocus('object');
              }}
              className="flex w-full items-center gap-2.5 rounded-xl border hairline p-2.5 text-left text-xs hover:border-white/25"
            >
              <span className="size-4 shrink-0 rounded-full border border-white/40" style={{ background: o.color ?? '#888' }} />
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-white', !o.enabled && 'line-through opacity-60')}>{o.name}</span>
                <span className="block truncate text-fog-400">{describeEffects(o.effects)} · {o.scope === 'frame' ? 'one frame' : `${seconds(o.startSec)}–${seconds(o.endSec)}`}{o.mask.track ? ' · tracked' : ''}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {tab === 'ai' && <ClipAi {...p} />}
    </div>
  );
}

function ClipAi(p: InspectorProps) {
  const sel = p.timeline.clips.find((c) => c.id === p.selectedClipId)!;
  const [credits, setCredits] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!sel.shotId) return setCredits(null);
    let alive = true;
    void api<{ credits: number }>(`/api/shots/${sel.shotId}/regenerate/estimate`).then((r) => alive && setCredits(r.credits)).catch(() => alive && setCredits(null));
    return () => {
      alive = false;
    };
  }, [sel.shotId]);
  const regenerate = async () => {
    setBusy(true);
    try {
      await api(`/api/shots/${sel.shotId}/regenerate`, { body: { idempotencyKey: newKey() } });
      toast.success('Regenerating — the new version appears in the shot’s versions; the current one stays until you choose.');
      setConfirm(false);
      p.onEditStarted?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not regenerate');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="rounded-xl border hairline p-3 text-xs">
        <div className="font-medium text-white">Change part of this clip</div>
        <p className="mt-1 text-fog-400">Select the object (or draw the area) and choose the seconds — AI changes only that. Price shown first.</p>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => useObjectUi.getState().set({ selecting: true })}><MousePointerClick /> Select object</Button>
          <Button size="sm" variant="ghost" onClick={() => p.onOpenShot(sel.id)}><Crosshair /> Shot editor</Button>
        </div>
      </div>
      {sel.shotId && (
        <div className="rounded-xl border hairline p-3 text-xs">
          <div className="font-medium text-white">Regenerate the whole shot</div>
          <p className="mt-1 text-fog-400">Makes a new version from the shot’s prompt. The current version stays in the movie until you pick the new one.</p>
          <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => setConfirm(true)} disabled={credits === null && !sel.shotId}>
            <Sparkles /> Regenerate{credits !== null ? ` · ≈ ${credits} credits` : ''}
          </Button>
        </div>
      )}
      {confirm && (
        <Dialog open onOpenChange={(o) => !o && setConfirm(false)} title="Regenerate this shot?" description="A paid AI model makes a new version of the whole shot." footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button loading={busy} onClick={regenerate}><Sparkles /> Regenerate · ≈ {credits ?? '?'} credits</Button></>}>
          <p className="text-sm text-fog-300">Only this shot is regenerated. Other shots, your edits on the timeline and the current version are kept — you choose which version plays.</p>
        </Dialog>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ audio

function AudioPanel(p: InspectorProps) {
  const t = p.timeline;
  const total = t.clips.reduce((s, c) => s + clipDuration(c), 0);
  const list = p.selectedAudio ? t.audio.filter((a) => a.id === p.selectedAudio) : t.audio;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" variant="secondary" onClick={p.onUploadAudio}><Music /> Upload music</Button>
        <Button size="sm" variant="secondary" onClick={() => p.onLibrary('audio')}><AudioLines /> From library</Button>
        <Button size="sm" variant="outline" className="col-span-2" onClick={p.onTts}><Mic /> Generate voice-over</Button>
      </div>
      {p.selectedAudio && t.audio.length > 1 && <button type="button" className="text-[11px] text-fog-400 hover:text-white" onClick={() => p.setSelectedAudio(null)}>Show all {t.audio.length} audio items</button>}
      {list.map((a) => {
        const i = t.audio.indexOf(a);
        const upd = (fn: (x: Timeline['audio'][number]) => void) => p.apply((tl) => { fn(tl.audio[i]!); return tl; });
        return (
          <div key={a.id} className={cn('space-y-2 rounded-xl border p-3', a.id === p.selectedAudio ? 'border-iris-400/60' : 'hairline')}>
            <div className="flex items-center justify-between">
              <NativeSelect className="h-8 w-28 text-xs" aria-label="Kind" value={a.kind} onChange={(e) => upd((x) => (x.kind = e.target.value as 'music'))}>
                <option value="music">music</option>
                <option value="voice">voice</option>
                <option value="sfx">sound effect</option>
              </NativeSelect>
              <div className="flex items-center gap-1">
                <Button size="sm" variant={a.muted ? 'secondary' : 'ghost'} aria-pressed={a.muted} onClick={() => upd((x) => (x.muted = !x.muted))}>{a.muted ? 'Muted' : 'Mute'}</Button>
                <Button size="sm" variant="ghost" title="Solo: mute every other track" onClick={() => p.apply((tl) => { const solo = tl.audio.every((x, j) => j === i || x.muted) && !tl.audio[i]!.muted; tl.audio.forEach((x, j) => (x.muted = solo ? false : j !== i)); return tl; })}>Solo</Button>
                <Button size="icon" variant="ghost" aria-label="Remove audio" onClick={() => { p.apply((tl) => { tl.audio.splice(i, 1); return tl; }); p.setSelectedAudio(null); }}><Trash2 /></Button>
              </div>
            </div>
            <div className="truncate text-[11px] text-fog-400">{p.assets.get(a.assetId)?.originalName ?? a.kind}</div>
            <Field label={`Starts at ${seconds(a.startSec)}`}><input type="range" aria-label="Start" className="w-full" min={0} max={Math.max(total, 1)} step={0.1} value={a.startSec} onChange={(e) => upd((x) => (x.startSec = Number(e.target.value)))} /></Field>
            <Field label={`Volume ${Math.round(a.volume * 100)}%`}><input type="range" aria-label="Volume" className="w-full" min={0} max={2} step={0.05} value={a.volume} onChange={(e) => upd((x) => (x.volume = Number(e.target.value)))} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Fade in (s)"><Input type="number" min={0} max={10} step={0.5} value={a.fadeInSec} onChange={(e) => upd((x) => (x.fadeInSec = Number(e.target.value)))} className="h-9" /></Field>
              <Field label="Fade out (s)"><Input type="number" min={0} max={10} step={0.5} value={a.fadeOutSec} onChange={(e) => upd((x) => (x.fadeOutSec = Number(e.target.value)))} className="h-9" /></Field>
            </div>
            {a.kind !== 'voice' && <label className="flex items-center justify-between text-xs text-fog-200">Duck under voice-over <Switch checked={a.duck} onCheckedChange={(v) => upd((x) => (x.duck = v))} label="Duck" /></label>}
          </div>
        );
      })}
      {!t.audio.length && <p className="text-sm text-fog-400">No music or voice yet. Clips with their own sound don’t need a second voice track.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ project

const CLEANUP = [
  { value: 0.07, label: 'Gentle' },
  { value: 0.12, label: 'Normal' },
  { value: 0.2, label: 'Strong' },
];

function LogoStyle({ logo, onChange }: { logo: Logo; onChange: (patch: Partial<Logo>) => void }) {
  const [busy, setBusy] = useState(false);
  const [strength, setStrength] = useState(0.12);
  const transparent = Boolean(logo.originalAssetId);
  const removeBg = async (tolerance: number) => {
    setBusy(true);
    try {
      const original = logo.originalAssetId ?? logo.assetId;
      const r = await api<{ asset: Asset }>(`/api/assets/${original}/remove-background`, { body: { tolerance } });
      setStrength(tolerance);
      onChange({ assetId: r.asset.id, originalAssetId: original });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not remove the background');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Segmented size="sm" value={transparent ? 'clean' : 'original'} onChange={(v) => (v === 'original' ? onChange({ assetId: logo.originalAssetId ?? logo.assetId, originalAssetId: undefined }) : void removeBg(strength))} options={[{ value: 'original', label: 'Original' }, { value: 'clean', label: 'No background' }]} />
        {busy && <Spinner />}
      </div>
      {transparent && (
        <div className="flex items-center gap-2 text-xs text-fog-400">
          Cleanup
          <Segmented size="sm" value={strength} onChange={(v) => void removeBg(v)} options={CLEANUP} />
        </div>
      )}
    </div>
  );
}

function ProjectPanel(p: InspectorProps) {
  const t = p.timeline;
  return (
    <div className="space-y-4">
      <Field label="Format">
        <Segmented size="sm" value={t.aspectRatio} onChange={(v) => p.apply((x) => ({ ...x, aspectRatio: v }))} options={(['9:16', '16:9', '1:1', '4:5'] as const).map((v) => ({ value: v, label: v }))} />
      </Field>
      <Field label="Resolution">
        <Segmented size="sm" value={t.resolution} onChange={(v) => p.apply((x) => ({ ...x, resolution: v }))} options={(['720p', '1080p'] as const).map((v) => ({ value: v, label: v }))} />
      </Field>
      <label className="flex items-center justify-between text-sm text-fog-200">Mute the clips’ own sound <Switch checked={t.muteClipAudio} onCheckedChange={(v) => p.apply((x) => ({ ...x, muteClipAudio: v }))} label="Mute clip audio" /></label>

      <section className="space-y-2 border-t hairline pt-4">
        <div className="flex items-center justify-between gap-2 text-sm text-fog-200">
          <span>Brand logo</span>
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={p.onUploadLogo}><ImagePlus /> Upload</Button>
            {t.logo && <Button size="sm" variant="ghost" onClick={() => p.apply((x) => ({ ...x, logo: undefined }))}>Remove</Button>}
          </div>
        </div>
        {t.logo && (
          <div className="space-y-3 rounded-xl border hairline p-3">
            <LogoStyle logo={t.logo} onChange={(patch) => { p.onRefetchAssets(); p.apply((x) => ({ ...x, logo: { ...x.logo!, ...patch } })); }} />
            <p className="text-xs text-fog-400">Drag the logo in the preview to place it anywhere.</p>
            <div className="flex flex-wrap gap-1.5">
              {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((pos) => (
                <Button key={pos} size="sm" variant={t.logo!.x === undefined && t.logo!.position === pos ? 'secondary' : 'ghost'} onClick={() => p.apply((x) => ({ ...x, logo: { ...x.logo!, position: pos, x: undefined, y: undefined } }))}>{pos.replace('-', ' ')}</Button>
              ))}
            </div>
            <Field label={`Size · ${Math.round(t.logo.scale * 100)}% of width`}><input type="range" aria-label="Logo size" className="w-full" min={0.03} max={0.5} step={0.01} value={t.logo.scale} onChange={(e) => p.apply((x) => ({ ...x, logo: { ...x.logo!, scale: Number(e.target.value) } }))} /></Field>
            <Field label={`Opacity · ${Math.round(t.logo.opacity * 100)}%`}><input type="range" aria-label="Logo opacity" className="w-full" min={0.1} max={1} step={0.05} value={t.logo.opacity} onChange={(e) => p.apply((x) => ({ ...x, logo: { ...x.logo!, opacity: Number(e.target.value) } }))} /></Field>
          </div>
        )}
      </section>

      <section className="space-y-2 border-t hairline pt-4">
        <div className="text-sm text-fog-200">Subtitles</div>
        <label className="flex items-center justify-between text-xs text-fog-300">Burn plain subtitles into the video <Switch checked={t.burnSubtitles} onCheckedChange={(v) => p.apply((x) => ({ ...x, burnSubtitles: v }))} label="Burn subtitles" /></label>
        <TranscribeButton projectId={p.projectId} timeline={t} assets={p.assets} onCues={(cues) => p.apply((x) => ({ ...x, subtitles: cues.map((c) => ({ ...c, id: newId('sub') })) }))} />
        <Button size="sm" variant="ghost" onClick={() => p.apply((x) => { x.subtitles.push({ id: newId('sub'), startSec: Math.round(p.playhead * 10) / 10, endSec: Math.round((p.playhead + 2) * 10) / 10, text: 'Subtitle' }); x.subtitles.sort((a, b) => a.startSec - b.startSec); return x; })}><Plus /> Add a line at the playhead</Button>
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {t.subtitles.map((s, i) => (
            <div key={s.id} className="grid grid-cols-[52px_52px_1fr_28px] gap-1">
              <Input className="h-8 px-1.5 text-xs" type="number" step={0.1} aria-label="Start" value={s.startSec} onChange={(e) => p.apply((x) => { x.subtitles[i]!.startSec = Number(e.target.value); return x; })} />
              <Input className="h-8 px-1.5 text-xs" type="number" step={0.1} aria-label="End" value={s.endSec} onChange={(e) => p.apply((x) => { x.subtitles[i]!.endSec = Number(e.target.value); return x; })} />
              <Input className="h-8 px-1.5 text-xs" aria-label="Text" value={s.text} onChange={(e) => p.apply((x) => { x.subtitles[i]!.text = e.target.value || ' '; return x; })} />
              <Button size="icon" variant="ghost" aria-label="Delete line" onClick={() => p.apply((x) => { x.subtitles.splice(i, 1); return x; })}><Trash2 /></Button>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-fog-500">For styled TikTok captions use Captions in the tools on the left.</p>
      </section>

      {(t.texts.length > 0 || t.overlays.length > 0) && (
        <section className="space-y-2 border-t hairline pt-4">
          <div className="text-sm text-fog-200">Older titles and overlays</div>
          <p className="text-[11px] text-fog-500">Made with an earlier version of the editor. They still export; new titles and stickers are layers.</p>
          {t.texts.map((x, i) => (
            <div key={x.id} className="flex items-center gap-1.5">
              <Type className="size-3.5 shrink-0 text-fog-400" />
              <Input className="h-8 text-xs" value={x.text} maxLength={300} onChange={(e) => p.apply((tl) => { tl.texts[i]!.text = e.target.value || ' '; return tl; })} />
              <span className="shrink-0 text-[10px] text-fog-500">{seconds(x.startSec)}–{seconds(x.endSec)}</span>
              <Button size="icon" variant="ghost" aria-label="Delete title" onClick={() => p.apply((tl) => { tl.texts.splice(i, 1); return tl; })}><Trash2 /></Button>
            </div>
          ))}
          {t.overlays.map((o, i) => (
            <div key={o.id} className="flex items-center justify-between text-xs text-fog-300">
              <span className="truncate">{p.assets.get(o.assetId)?.originalName ?? 'Overlay'} · {seconds(o.startSec)}–{seconds(o.endSec)}</span>
              <Button size="icon" variant="ghost" aria-label="Remove overlay" onClick={() => p.apply((tl) => { tl.overlays.splice(i, 1); return tl; })}><Trash2 /></Button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
