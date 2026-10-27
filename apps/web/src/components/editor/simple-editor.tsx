'use client';

import { useEffect, useState } from 'react';
import { Blend, Captions, ChevronLeft, ChevronRight, Copy, Gauge, Maximize2, Music, Palette, Pause, Play, Plus, RectangleHorizontal, Scissors, SquarePen, Trash2, Type, Upload, Volume2, X } from 'lucide-react';
import { LOOKS, clipDuration, layerSchema, timelineDuration, type Timeline } from '@framecraft/shared';
import type { Asset } from '@/lib/api';
import { freeTrack, newId, splitAtPlayhead } from '@/lib/editor-store';
import { lookActive, lookSwatch } from '@/lib/looks';
import { TRANSITION_LABEL, TRANSITIONS } from '@/lib/transitions';
import { cn, seconds } from '@/lib/utils';
import { timecode } from './preview';
import { Button } from '@/components/ui';
import { MediaDropzone } from '@/components/studio/media-dropzone';
import { CaptionsTab, TEXT_STYLES } from './toolbox';

/*
 * The simple editor (default): a big picture, one toolbar, the timeline. Only tools that work
 * reliably and need no explanation — add video, split, speed, volume, filter, transition, text,
 * music, captions, format, export. Everything else lives behind "Pro tools".
 */

type Apply = (fn: (t: Timeline) => Timeline) => void;
type Tool = 'speed' | 'volume' | 'filter' | 'transition' | 'text' | 'edit-text' | 'music' | 'captions' | 'format' | 'audio-volume';
export type SimpleFocus = 'clip' | 'layer' | 'audio' | 'none';

const SPEEDS = [0.5, 1, 1.5, 2, 3];
const FORMATS = [
  { key: '9:16', label: '9:16', hint: 'TikTok · Reels' },
  { key: '16:9', label: '16:9', hint: 'YouTube' },
  { key: '1:1', label: '1:1', hint: 'Square' },
  { key: '4:5', label: '4:5', hint: 'Feed' },
] as const;

function ToolBtn({ icon: Icon, label, active, onClick, disabled, danger }: { icon: typeof Scissors; label: string; active?: boolean; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={label}
      className={cn(
        'flex h-[52px] w-[58px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl text-[11px] transition disabled:pointer-events-none disabled:opacity-35',
        active ? 'bg-white/[0.12] text-white' : 'text-fog-300 hover:bg-white/[0.06] hover:text-white',
        danger && 'hover:text-signal-red',
      )}
    >
      <Icon className="size-[18px]" />
      <span className="max-w-full truncate leading-none">{label}</span>
    </button>
  );
}

function Chip({ active, onClick, children, disabled }: { active?: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={active} className={cn('rounded-lg border px-2.5 py-1.5 text-xs transition disabled:opacity-40', active ? 'border-iris-400 bg-iris-500/20 text-white' : 'hairline text-fog-200 hover:border-white/25')}>
      {children}
    </button>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string }) {
  return (
    <label className="block text-xs text-fog-300">
      <span className="flex justify-between">
        {label} <span className="tabular-nums text-white">{format(value)}</span>
      </span>
      <input type="range" aria-label={label} className="mt-1.5 w-full accent-iris-500" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function SimpleEditor(p: {
  projectId: string;
  timeline: Timeline;
  assets: Map<string, Asset>;
  apply: Apply;
  playhead: number;
  setPlayhead: (t: number) => void;
  playing: boolean;
  selected: string | null;
  select: (id: string | null) => void;
  focus: SimpleFocus;
  selectedLayer: string | null;
  setSelectedLayer: (id: string | null) => void;
  selectedAudio: string | null;
  setSelectedAudio: (id: string | null) => void;
  preview: React.ReactNode;
  timelineEl: React.ReactNode;
  timelineHeight: string;
  /** Drag handle between the picture and the timeline. */
  resizeHandle?: React.ReactNode;
  onAddFromLibrary: () => void;
  onUploadVideo: () => void;
  onAddMusic: (a: Asset) => void;
  transcribe: React.ReactNode;
}) {
  const { timeline: t, apply, playhead, selected } = p;
  const [tool, setTool] = useState<Tool | null>(null);
  // Which clip / text / sound a panel belongs to: it closes when something else is selected.
  const [owner, setOwner] = useState<string | null>(null);
  const clipIndex = t.clips.findIndex((c) => c.id === selected);
  const clip = clipIndex >= 0 ? t.clips[clipIndex] : undefined;
  const layer = p.focus === 'layer' ? t.layers.find((l) => l.id === p.selectedLayer) : undefined;
  const audio = p.focus === 'audio' ? t.audio.find((a) => a.id === p.selectedAudio) : undefined;
  const context: 'clip' | 'layer' | 'audio' | 'none' = layer ? 'layer' : audio ? 'audio' : clip ? 'clip' : 'none';
  const current = layer?.id ?? audio?.id ?? clip?.id ?? null;
  const toggle = (k: Tool) => {
    setOwner(current);
    setTool((cur) => (cur === k ? null : k));
  };
  useEffect(() => {
    setTool((cur) => (cur && ['speed', 'volume', 'filter', 'transition', 'edit-text', 'audio-volume'].includes(cur) && owner !== current ? null : cur));
  }, [current, owner]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setTool(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setClip = (fn: (c: Timeline['clips'][number]) => void) =>
    apply((x) => {
      const c = x.clips.find((y) => y.id === selected);
      if (c) fn(c);
      return x;
    });
  const removeClip = () => {
    if (t.clips.length < 2 || !clip) return;
    const next = t.clips[clipIndex + 1] ?? t.clips[clipIndex - 1];
    apply((x) => ({ ...x, clips: x.clips.filter((c) => c.id !== selected) }));
    p.select(next?.id ?? null);
  };
  const addText = (k: number) => {
    const made = layerSchema.parse(TEXT_STYLES[k]!.make(Math.floor(playhead * 10) / 10));
    const placed = { ...made, track: freeTrack(t, made.startSec, made.endSec, made.track) };
    apply((x) => ({ ...x, layers: [...x.layers, placed] }));
    p.setSelectedLayer(placed.id);
    setOwner(placed.id);
    setTool('edit-text');
  };
  const restyle = (k: number) =>
    layer?.text &&
    apply((x) => ({
      ...x,
      layers: x.layers.map((l) => {
        if (l.id !== layer.id) return l;
        const made = layerSchema.parse(TEXT_STYLES[k]!.make(l.startSec));
        return layerSchema.parse({ ...l, text: { ...made.text!, content: l.text?.content ?? made.text!.content }, animIn: made.animIn, animOut: made.animOut });
      }),
    }));
  const audioAssets = [...p.assets.values()].filter((a) => a.mediaType === 'audio').slice(0, 30);

  // ------------------------------------------------------------------ panels
  let panel: React.ReactNode = null;
  let panelTitle = '';
  if (tool === 'speed' && clip) {
    panelTitle = `Speed · clip ${clipIndex + 1}`;
    panel = (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {SPEEDS.map((s) => (
            <Chip key={s} active={clip.speed === s} disabled={Boolean(clip.freezeSec)} onClick={() => setClip((c) => (c.speed = s))}>{s}×</Chip>
          ))}
        </div>
        <Slider label="Exact speed" value={clip.speed} min={0.25} max={4} step={0.05} onChange={(v) => setClip((c) => (c.speed = v))} format={(v) => `${v.toFixed(2)}×`} />
        <p className="text-[11px] text-fog-500">Now {seconds(clipDuration(clip))} long on the timeline.</p>
      </div>
    );
  } else if (tool === 'volume' && clip) {
    panelTitle = `Sound · clip ${clipIndex + 1}`;
    panel = (
      <div className="space-y-3">
        <Slider label="Volume" value={clip.volume} min={0} max={2} step={0.05} onChange={(v) => setClip((c) => (c.volume = v))} format={(v) => `${Math.round(v * 100)}%`} />
        <div className="flex gap-1.5">
          <Chip active={clip.volume === 0} onClick={() => setClip((c) => (c.volume = c.volume === 0 ? 1 : 0))}>{clip.volume === 0 ? 'Muted' : 'Mute'}</Chip>
          <Chip active={clip.fadeInSec > 0} onClick={() => setClip((c) => (c.fadeInSec = c.fadeInSec > 0 ? 0 : 0.5))}>Fade in</Chip>
          <Chip active={clip.fadeOutSec > 0} onClick={() => setClip((c) => (c.fadeOutSec = c.fadeOutSec > 0 ? 0 : 0.5))}>Fade out</Chip>
        </div>
      </div>
    );
  } else if (tool === 'filter') {
    const target = clip;
    panelTitle = target ? `Filter · clip ${clipIndex + 1}` : 'Filter · every clip';
    const setLook = (grade: Record<string, unknown> | undefined, all: boolean) => apply((x) => ({ ...x, clips: x.clips.map((c) => (all || c.id === target?.id ? { ...c, adjust: grade ? ({ ...grade } as typeof c.adjust) : undefined } : c)) }));
    panel = (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
          <button type="button" onClick={() => setLook(undefined, !target)} aria-pressed={Boolean(target && !target.adjust)} className={cn('rounded-lg border p-1.5 text-left text-[11px]', target && !target.adjust ? 'border-iris-400 bg-iris-500/15 text-white' : 'hairline text-fog-200 hover:border-white/25')}>
            <span className="mb-1 block h-7 rounded bg-gradient-to-r from-zinc-500 to-zinc-300" />None
          </button>
          {LOOKS.map((l) => {
            const on = Boolean(target && lookActive(l.grade, target.adjust as Record<string, unknown> | undefined));
            return (
              <button key={l.key} type="button" onClick={() => setLook(l.grade, !target)} aria-pressed={on} className={cn('rounded-lg border p-1.5 text-left text-[11px]', on ? 'border-iris-400 bg-iris-500/15 text-white' : 'hairline text-fog-200 hover:border-white/25')}>
                <span className="mb-1 block h-7 rounded" style={{ background: lookSwatch(l.grade) }} />
                <span className="block truncate">{l.label}</span>
              </button>
            );
          })}
        </div>
        {target && (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => setLook(target.adjust as Record<string, unknown> | undefined, true)}>
            Use this filter on every clip
          </Button>
        )}
      </div>
    );
  } else if (tool === 'transition' && clip) {
    const last = clipIndex === t.clips.length - 1;
    panelTitle = `Transition after clip ${clipIndex + 1}`;
    panel = last ? (
      <p className="text-xs text-fog-400">This is the last clip — a transition goes between two clips. Select an earlier clip.</p>
    ) : (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {TRANSITIONS.map((k) => (
            <Chip key={k} active={(clip.transition?.type ?? 'cut') === k} onClick={() => setClip((c) => (c.transition = k === 'cut' ? undefined : { type: k, durationSec: c.transition?.durationSec ?? Math.min(0.5, clipDuration(c) / 3) }))}>
              {TRANSITION_LABEL[k]}
            </Chip>
          ))}
        </div>
        {clip.transition && <Slider label="Length" value={clip.transition.durationSec} min={0.2} max={1.5} step={0.1} onChange={(v) => setClip((c) => c.transition && (c.transition.durationSec = v))} format={(v) => `${v.toFixed(1)} s`} />}
      </div>
    );
  } else if (tool === 'text') {
    panelTitle = 'Add text at the playhead';
    panel = (
      <div className="grid grid-cols-3 gap-1.5">
        {TEXT_STYLES.map((s, k) => (
          <button key={s.key} type="button" onClick={() => addText(k)} className="grid h-16 place-items-center rounded-lg border hairline bg-black/40 p-1 text-center hover:border-iris-400/60">
            <span className="text-base" style={s.demo}>Aa</span>
            <span className="text-[10px] text-fog-400">{s.label}</span>
          </button>
        ))}
      </div>
    );
  } else if (tool === 'edit-text' && layer?.text) {
    panelTitle = 'Text';
    panel = (
      <div className="space-y-3">
        <textarea
          aria-label="Text"
          value={layer.text.content}
          rows={2}
          maxLength={300}
          onChange={(e) => apply((x) => ({ ...x, layers: x.layers.map((l) => (l.id === layer.id && l.text ? { ...l, text: { ...l.text, content: e.target.value || ' ' } } : l)) }))}
          className="w-full resize-none rounded-lg border hairline bg-black/30 px-2.5 py-2 text-sm text-white focus:border-iris-400 focus:outline-none"
        />
        <div className="grid grid-cols-3 gap-1.5">
          {TEXT_STYLES.map((s, k) => (
            <button key={s.key} type="button" onClick={() => restyle(k)} className="grid h-12 place-items-center rounded-lg border hairline bg-black/40 text-center hover:border-iris-400/60">
              <span className="text-sm" style={s.demo}>Aa</span>
              <span className="text-[10px] text-fog-400">{s.label}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-fog-500">Drag the text in the picture to move it; drag its corner to resize.</p>
      </div>
    );
  } else if (tool === 'music') {
    panelTitle = 'Music';
    panel = (
      <div className="space-y-2">
        <MediaDropzone compact accept="audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg,.mp3,.wav,.m4a" label="Import music" hint="MP3, WAV, M4A" projectId={p.projectId} onAsset={(a) => p.onAddMusic(a as unknown as Asset)} />
        {audioAssets.length > 0 && (
          <div className="max-h-40 space-y-0.5 overflow-y-auto pr-1">
            {audioAssets.map((a) => (
              <button key={a.id} type="button" onClick={() => p.onAddMusic(a)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-fog-200 hover:bg-white/[0.05]">
                <Music className="size-3.5 shrink-0 text-fog-400" />
                <span className="min-w-0 flex-1 truncate">{a.originalName ?? 'Audio'}</span>
                {a.durationMs ? <span className="text-fog-500">{seconds(a.durationMs / 1000)}</span> : null}
                <Plus className="size-3.5" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  } else if (tool === 'audio-volume' && audio) {
    panelTitle = audio.kind === 'music' ? 'Music' : 'Sound';
    const setAudio = (fn: (a: Timeline['audio'][number]) => void) => apply((x) => ({ ...x, audio: x.audio.map((a) => (a.id === audio.id ? (fn(a), a) : a)) }));
    panel = (
      <div className="space-y-3">
        <Slider label="Volume" value={audio.volume} min={0} max={1.5} step={0.05} onChange={(v) => setAudio((a) => (a.volume = v))} format={(v) => `${Math.round(v * 100)}%`} />
        <div className="flex gap-1.5">
          <Chip active={audio.fadeInSec > 0} onClick={() => setAudio((a) => (a.fadeInSec = a.fadeInSec > 0 ? 0 : 1))}>Fade in</Chip>
          <Chip active={audio.fadeOutSec > 0} onClick={() => setAudio((a) => (a.fadeOutSec = a.fadeOutSec > 0 ? 0 : 1))}>Fade out</Chip>
          <Chip active={audio.duck} onClick={() => setAudio((a) => (a.duck = !a.duck))}>Quieter under speech</Chip>
        </div>
      </div>
    );
  } else if (tool === 'captions') {
    panelTitle = 'Captions';
    panel = <CaptionsTab timeline={t} apply={apply} transcribe={p.transcribe} playhead={playhead} />;
  } else if (tool === 'format') {
    panelTitle = 'Format';
    panel = (
      <div className="flex flex-wrap gap-1.5">
        {FORMATS.map((f) => (
          <Chip key={f.key} active={t.aspectRatio === f.key} onClick={() => apply((x) => ({ ...x, aspectRatio: f.key }))}>
            <span className="font-medium">{f.label}</span> <span className="text-fog-400">· {f.hint}</span>
          </Chip>
        ))}
      </div>
    );
  }

  // ------------------------------------------------------------------ toolbar
  const contextTools =
    context === 'clip' && clip ? (
      <>
        <span className="hidden px-2 text-[11px] text-fog-500 md:inline">Clip {clipIndex + 1}</span>
        <ToolBtn icon={Scissors} label="Split" onClick={() => apply((x) => splitAtPlayhead(x, playhead, selected))} />
        <ToolBtn icon={Gauge} label="Speed" active={tool === 'speed'} onClick={() => toggle('speed')} disabled={Boolean(clip.freezeSec)} />
        <ToolBtn icon={Volume2} label="Sound" active={tool === 'volume'} onClick={() => toggle('volume')} />
        <ToolBtn icon={Palette} label="Filter" active={tool === 'filter'} onClick={() => toggle('filter')} />
        <ToolBtn icon={Blend} label="Transition" active={tool === 'transition'} onClick={() => toggle('transition')} />
        <ToolBtn icon={Copy} label="Duplicate" onClick={() => apply((x) => { const c = x.clips[clipIndex]!; x.clips.splice(clipIndex + 1, 0, { ...c, id: newId('clip'), transition: undefined }); return x; })} />
        <ToolBtn icon={Trash2} label="Delete" danger disabled={t.clips.length < 2} onClick={removeClip} />
      </>
    ) : context === 'layer' && layer ? (
      <>
        <span className="hidden px-2 text-[11px] text-fog-500 md:inline">{layer.kind === 'text' ? 'Text' : layer.name ?? 'Layer'}</span>
        {layer.text && <ToolBtn icon={SquarePen} label="Edit" active={tool === 'edit-text'} onClick={() => toggle('edit-text')} />}
        <ToolBtn icon={Copy} label="Duplicate" onClick={() => apply((x) => ({ ...x, layers: [...x.layers, { ...layer, id: newId('ly'), startSec: layer.endSec, endSec: layer.endSec + (layer.endSec - layer.startSec) }] }))} />
        <ToolBtn icon={Trash2} label="Delete" danger onClick={() => { apply((x) => ({ ...x, layers: x.layers.filter((l) => l.id !== layer.id) })); p.setSelectedLayer(null); }} />
      </>
    ) : context === 'audio' && audio ? (
      <>
        <span className="hidden px-2 text-[11px] text-fog-500 md:inline">{audio.kind === 'music' ? 'Music' : 'Sound'}</span>
        <ToolBtn icon={Volume2} label="Volume" active={tool === 'audio-volume'} onClick={() => toggle('audio-volume')} />
        <ToolBtn icon={Trash2} label="Delete" danger onClick={() => { apply((x) => ({ ...x, audio: x.audio.filter((a) => a.id !== audio.id) })); p.setSelectedAudio(null); }} />
      </>
    ) : (
      <ToolBtn icon={Palette} label="Filter" active={tool === 'filter'} onClick={() => toggle('filter')} />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5" data-testid="simple-editor">
      <section aria-label="Preview" className="relative min-h-[180px] flex-1 rounded-2xl border hairline bg-black/30 p-2 max-lg:h-[52dvh] max-lg:flex-none">
        {p.preview}
        {panel && (
          // Docked at the right of the stage, beside the picture: the change stays visible and the
          // header is never covered.
          <div role="dialog" aria-label={panelTitle} className="absolute bottom-2 right-2 top-2 z-30 w-[min(460px,46%)] overflow-y-auto rounded-2xl border hairline bg-ink-900/95 p-3 shadow-2xl backdrop-blur max-md:w-[calc(100%-1rem)]">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-white">{panelTitle}</span>
              <button type="button" aria-label="Close" onClick={() => setTool(null)} className="grid size-7 place-items-center rounded-lg text-fog-400 hover:bg-white/[0.06] hover:text-white"><X className="size-4" /></button>
            </div>
            {panel}
          </div>
        )}
      </section>

      <div className="relative z-20 flex shrink-0 justify-center">
        <div className="flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-2xl border hairline bg-ink-900/80 p-1" role="toolbar" aria-label="Edit tools">
          <span className="flex items-center gap-0.5">
            <ToolBtn icon={Plus} label="Video" onClick={p.onAddFromLibrary} />
            <ToolBtn icon={Upload} label="Upload" onClick={p.onUploadVideo} />
            <ToolBtn icon={Type} label="Text" active={tool === 'text'} onClick={() => toggle('text')} disabled={!t.clips.length} />
            <ToolBtn icon={Music} label="Music" active={tool === 'music'} onClick={() => toggle('music')} disabled={!t.clips.length} />
            <ToolBtn icon={Captions} label="Captions" active={tool === 'captions'} onClick={() => toggle('captions')} disabled={!t.clips.length} />
            <ToolBtn icon={RectangleHorizontal} label="Format" active={tool === 'format'} onClick={() => toggle('format')} />
          </span>
          {/* Playback lives here, so the picture gets the whole stage. */}
          <span className="flex items-center gap-1">
            <button type="button" aria-label="Previous frame" title="Previous frame (←)" onClick={() => p.setPlayhead(Math.max(0, Math.round((playhead - 1 / (t.fps || 30)) * (t.fps || 30)) / (t.fps || 30)))} className="grid size-8 place-items-center rounded-lg text-fog-300 hover:bg-white/[0.06] hover:text-white"><ChevronLeft className="size-4" /></button>
            <button type="button" aria-label={p.playing ? 'Pause' : 'Play'} title="Play / pause (Space)" disabled={!t.clips.length} onClick={() => window.dispatchEvent(new Event('fc-editor-toggle-play'))} className="grid size-10 place-items-center rounded-full bg-white text-ink-950 transition hover:bg-fog-100 disabled:opacity-40">
              {p.playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
            </button>
            <button type="button" aria-label="Next frame" title="Next frame (→)" onClick={() => p.setPlayhead(Math.min(timelineDuration(t), Math.round((playhead + 1 / (t.fps || 30)) * (t.fps || 30)) / (t.fps || 30)))} className="grid size-8 place-items-center rounded-lg text-fog-300 hover:bg-white/[0.06] hover:text-white"><ChevronRight className="size-4" /></button>
            <span className="w-[8.5rem] text-center font-mono text-[11px] tabular-nums text-fog-300" aria-label="Time"><span className="text-white">{timecode(playhead)}</span> / {timecode(timelineDuration(t))}</span>
            <button type="button" aria-label="Full screen" title="Full screen preview" onClick={() => window.dispatchEvent(new Event('fc-editor-fullscreen'))} className="grid size-8 place-items-center rounded-lg text-fog-300 hover:bg-white/[0.06] hover:text-white"><Maximize2 className="size-3.5" /></button>
          </span>
          <span className="flex items-center gap-0.5">{t.clips.length ? contextTools : <span className="px-3 text-[11px] text-fog-500">Add a video to start editing</span>}</span>
        </div>
      </div>

      {p.resizeHandle}
      <section aria-label="Timeline" className="shrink-0 overflow-hidden rounded-2xl border hairline bg-ink-900/40 px-3 py-2" style={{ height: p.timelineHeight }}>
        {p.timelineEl}
      </section>
      <span className="sr-only" aria-live="polite">{seconds(timelineDuration(t))} video</span>
    </div>
  );
}
