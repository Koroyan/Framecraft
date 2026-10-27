'use client';

import { useState } from 'react';
import { AudioLines, Bot, Captions, ChevronsLeft, ChevronsRight, Crosshair, Film, Image as ImageIcon, Mic, MousePointerClick, Music, Palette, Plus, Shapes, Sparkles, Type, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import { LOOKS, layerSchema, snapClipsToBeats, type LayerInput, type Timeline } from '@framecraft/shared';
import { lookActive, lookSwatch } from '@/lib/looks';
import { api, ApiError, type Asset } from '@/lib/api';
import { Button, NativeSelect } from '@/components/ui';
import { MediaDropzone } from '@/components/studio/media-dropzone';
import { LAYER_TEMPLATES } from '@/components/editor/layers';
import { freeTrack, newId } from '@/lib/editor-store';
import { cn, seconds } from '@/lib/utils';

/*
 * CapCut-style asset panel on the left of the editor: media, audio (with cut-to-the-beat), text
 * styles, stickers, TikTok-style captions, one-click filters and transitions. Everything it adds is
 * a normal timeline item the inspector and the export already understand.
 */

type Apply = (fn: (t: Timeline) => Timeline) => void;
type Tab = 'media' | 'audio' | 'text' | 'stickers' | 'captions' | 'filters' | 'transitions' | 'ai';

const TABS: { key: Tab; label: string; icon: typeof Film }[] = [
  { key: 'media', label: 'Media', icon: Film },
  { key: 'audio', label: 'Audio', icon: Music },
  { key: 'text', label: 'Text', icon: Type },
  { key: 'stickers', label: 'Stickers', icon: Shapes },
  { key: 'captions', label: 'Captions', icon: Captions },
  { key: 'filters', label: 'Filters', icon: Palette },
  { key: 'transitions', label: 'Transitions', icon: Sparkles },
  { key: 'ai', label: 'AI tools', icon: Wand2 },
];

/** TikTok-style text looks (rendered by the server exactly like the preview). */
export const TEXT_STYLES: { key: string; label: string; demo: React.CSSProperties; make: (s: number) => LayerInput }[] = [
  { key: 'yellow', label: 'Bold yellow', demo: { color: '#FFE14D', WebkitTextStroke: '1px #000', fontWeight: 900 }, make: (s) => ({ id: newId('ly'), name: 'Bold yellow', kind: 'text', track: 2, startSec: s, endSec: s + 2.5, x: 0.5, y: 0.7, w: 0.84, text: { content: 'ეს უნდა ნახო', font: 'black', size: 84, color: '#FFE14D', stroke: { color: '#000000', width: 8 } }, animIn: { type: 'pop', durationSec: 0.3 } }) },
  { key: 'neon', label: 'Neon glow', demo: { color: '#7CF7FF', textShadow: '0 0 8px #00E5FF', fontWeight: 800 }, make: (s) => ({ id: newId('ly'), name: 'Neon', kind: 'text', track: 2, startSec: s, endSec: s + 3, x: 0.5, y: 0.3, w: 0.84, text: { content: 'NEW DROP', font: 'black', size: 96, color: '#7CF7FF', gradientTo: '#FF4FD8', shadow: { color: '#00E5FF', opacity: 0.8, offset: 0 } }, animIn: { type: 'zoom', durationSec: 0.4 } }) },
  { key: 'boxed', label: 'Boxed white', demo: { color: '#111', background: '#fff', padding: '0 4px', fontWeight: 700 }, make: (s) => ({ id: newId('ly'), name: 'Boxed', kind: 'text', track: 2, startSec: s, endSec: s + 3, x: 0.5, y: 0.72, w: 0.8, text: { content: 'შენი ტექსტი', font: 'bold', size: 62, color: '#111111', background: { color: '#FFFFFF', opacity: 1, padding: 18 } }, animIn: { type: 'slide_up', durationSec: 0.35 } }) },
  { key: 'gradient', label: 'Gradient title', demo: { background: 'linear-gradient(90deg,#FF7A59,#7C5CFF)', WebkitBackgroundClip: 'text', color: 'transparent', fontWeight: 900 }, make: (s) => ({ id: newId('ly'), name: 'Gradient title', kind: 'text', track: 2, startSec: s, endSec: s + 3, x: 0.5, y: 0.22, w: 0.86, text: { content: 'სათაური', font: 'black', size: 110, color: '#FF7A59', gradientTo: '#7C5CFF', shadow: { color: '#000000', opacity: 0.4, offset: 4 } }, animIn: { type: 'pop', durationSec: 0.45 }, animOut: { type: 'fade', durationSec: 0.3 } }) },
  { key: 'karaoke', label: 'Word by word', demo: { color: '#fff', fontWeight: 900, WebkitTextStroke: '1px #000' }, make: (s) => ({ id: newId('ly'), name: 'Word by word', kind: 'text', track: 2, startSec: s, endSec: s + 3, x: 0.5, y: 0.66, w: 0.84, text: { content: 'ერთი სიტყვა ერთ ჯერზე', font: 'black', size: 76, color: '#FFFFFF', stroke: { color: '#000000', width: 7 } }, animIn: { type: 'words', durationSec: 1.6 } }) },
  { key: 'minimal', label: 'Minimal serif', demo: { color: '#fff', fontFamily: 'serif', letterSpacing: 1 }, make: (s) => ({ id: newId('ly'), name: 'Minimal', kind: 'text', track: 2, startSec: s, endSec: s + 3.5, x: 0.5, y: 0.5, w: 0.8, text: { content: 'elegance', font: 'serif', size: 80, color: '#FFFFFF', shadow: { color: '#000000', opacity: 0.4, offset: 3 } }, animIn: { type: 'fade', durationSec: 0.6 }, animOut: { type: 'fade', durationSec: 0.5 } }) },
];

/** Caption looks for "TikTok captions": every subtitle cue becomes a styled, word-by-word layer. */
const CAPTION_STYLES = [
  { key: 'tiktok', label: 'TikTok bold', text: { font: 'black' as const, size: 74, color: '#FFFFFF', stroke: { color: '#000000', width: 8 } } },
  { key: 'yellow', label: 'Yellow pop', text: { font: 'black' as const, size: 76, color: '#FFE14D', stroke: { color: '#000000', width: 8 } } },
  { key: 'boxed', label: 'Boxed', text: { font: 'bold' as const, size: 60, color: '#FFFFFF', background: { color: '#000000', opacity: 0.7, padding: 16 } } },
];

export function EditorToolbox(p: {
  projectId: string;
  timeline: Timeline;
  apply: Apply;
  assets: Map<string, Asset>;
  playhead: number;
  selectedClipId: string | null;
  onAddClip: (a: Asset) => void;
  onAddMusic: (a: Asset) => void;
  onTts: () => void;
  onUploaded: () => void;
  onSelectLayer: (id: string) => void;
  transcribe: React.ReactNode;
  /** Tool panel next to the rail (collapsible); the rail always stays. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  panelWidth?: number;
  onSelectObject?: () => void;
  onOpenAssistant?: () => void;
  onOpenShot?: () => void;
}) {
  const [tab, setTab] = useState<Tab>('media');
  const open = p.open ?? true;
  const pick = (k: Tab) => {
    if (open && tab === k && p.onOpenChange) return p.onOpenChange(false);
    setTab(k);
    if (!open) p.onOpenChange?.(true);
  };
  const { timeline, apply, playhead } = p;
  const at = Math.round(playhead * 10) / 10;
  const list = [...p.assets.values()].filter((a) => a.kind !== 'thumbnail' && a.kind !== 'frame');
  const addLayer = (l: LayerInput) => {
    const made = layerSchema.parse(l);
    const layer = { ...made, track: freeTrack(timeline, made.startSec, made.endSec, made.track) };
    apply((t) => ({ ...t, layers: [...t.layers, layer] }));
    p.onSelectLayer(layer.id);
  };

  return (
    <div className="flex h-full overflow-hidden rounded-2xl border hairline bg-ink-900/70">
      <nav aria-label="Editor tools" className={cn('flex w-16 shrink-0 flex-col gap-0.5 overflow-y-auto p-1.5', open && 'border-r hairline')}>
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => pick(t.key)} aria-pressed={open && tab === t.key} title={t.label} className={cn('flex flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-[10px] transition', open && tab === t.key ? 'bg-iris-500/20 text-white' : 'text-fog-400 hover:bg-white/[0.05] hover:text-fog-100')}>
            <t.icon className="size-4" />
            {t.label}
          </button>
        ))}
        {p.onOpenChange && (
          <button type="button" onClick={() => p.onOpenChange!(!open)} title={open ? 'Hide the tool panel' : 'Show the tool panel'} aria-label={open ? 'Hide the tool panel' : 'Show the tool panel'} className="mt-auto grid h-8 place-items-center rounded-xl text-fog-500 hover:bg-white/[0.05] hover:text-white">
            {open ? <ChevronsLeft className="size-4" /> : <ChevronsRight className="size-4" />}
          </button>
        )}
      </nav>
      {open && <div className="min-w-0 flex-1 space-y-3 overflow-y-auto p-3" style={p.panelWidth ? { width: p.panelWidth } : undefined}>
        {tab === 'media' && (
          <>
            <MediaDropzone compact label="Import videos or photos" onAsset={() => p.onUploaded()} />
            <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
              {list.filter((a) => a.mediaType === 'video' || a.mediaType === 'image').slice(0, 60).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  title={a.mediaType === 'video' ? 'Add to the end of the timeline' : 'Add as a photo layer at the playhead'}
                  onClick={() => (a.mediaType === 'video' ? p.onAddClip(a) : addLayer({ id: newId('ly'), name: a.originalName ?? 'Photo', kind: 'image', track: 3, assetId: a.id, startSec: at, endSec: at + 3, x: 0.5, y: 0.45, w: 0.7 }))}
                  className="group relative overflow-hidden rounded-lg border hairline text-left hover:border-iris-400/60"
                >
                  <img src={a.thumbnailUrl ?? a.url} alt="" className="aspect-[3/4] w-full object-cover" loading="lazy" />
                  <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 px-1.5 pb-1 pt-3 text-[10px] text-white">{a.mediaType === 'video' && a.durationMs ? `${seconds(a.durationMs / 1000)} · ` : ''}{mediaLabel(a)}</span>
                  <span className="absolute right-1 top-1 hidden rounded-full bg-iris-500 p-0.5 text-white group-hover:block"><Plus className="size-3" /></span>
                </button>
              ))}
            </div>
          </>
        )}

        {tab === 'audio' && <AudioTab {...p} list={list} />}

        {tab === 'text' && (
          <div className="grid grid-cols-2 gap-2">
            {TEXT_STYLES.map((s) => (
              <button key={s.key} type="button" onClick={() => addLayer(s.make(at))} className="grid aspect-[4/3] place-items-center rounded-lg border hairline bg-black/40 p-2 text-center hover:border-iris-400/60">
                <span className="text-lg leading-tight" style={s.demo}>Aa</span>
                <span className="text-[10px] text-fog-400">{s.label}</span>
              </button>
            ))}
            {LAYER_TEMPLATES.filter((t) => t.make(0).kind === 'text').map((t) => (
              <button key={t.key} type="button" onClick={() => addLayer(t.make(at))} className="grid aspect-[4/3] place-items-center rounded-lg border hairline bg-black/40 p-2 text-center hover:border-iris-400/60">
                <Type className="size-4 text-fog-200" />
                <span className="text-[10px] text-fog-400">{t.label}</span>
              </button>
            ))}
          </div>
        )}

        {tab === 'stickers' && (
          <div className="grid grid-cols-2 gap-2">
            {LAYER_TEMPLATES.filter((t) => t.make(0).kind === 'shape').map((t) => {
              const shape = t.make(0).shape!;
              return (
                <button key={t.key} type="button" onClick={() => addLayer(t.make(at))} className="grid aspect-[4/3] place-items-center rounded-lg border hairline bg-black/40 p-2 hover:border-iris-400/60">
                  <span className={cn('px-2 py-0.5 text-[11px] font-bold', shape.type === 'burst' || shape.type === 'ellipse' ? 'rounded-full' : 'rounded-lg')} style={{ background: shape.fill, color: shape.labelColor }}>{shape.label ?? '➜'}</span>
                  <span className="text-[10px] text-fog-400">{t.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {tab === 'captions' && <CaptionsTab timeline={timeline} apply={apply} transcribe={p.transcribe} playhead={playhead} />}

        {tab === 'filters' && <FiltersTab timeline={timeline} apply={apply} selectedClipId={p.selectedClipId} />}

        {tab === 'transitions' && <TransitionsTab timeline={timeline} apply={apply} selectedClipId={p.selectedClipId} />}

        {tab === 'ai' && (
          <div className="space-y-2 text-xs">
            <AiTool icon={MousePointerClick} title="Select an object" text="Click anything in the picture to recolour, brighten or blur only it — it can follow the object." badge="Free" onClick={p.onSelectObject} />
            <AiTool icon={Bot} title="Ask the assistant" text="“Make the music quieter”, “cut this part”, “make it cinematic”. Everyday edits are instant." badge="Free" onClick={p.onOpenAssistant} />
            <AiTool icon={Crosshair} title="Fix part of a shot with AI" text="Choose the seconds and the area; AI changes only that. Price shown first, you compare before using it." badge="Paid" onClick={p.onOpenShot} />
            <AiTool icon={Sparkles} title="Generate a new clip" text="Make a shot from a description or an image, then add it here." badge="Paid" href="/app/create" />
          </div>
        )}
      </div>}
    </div>
  );
}

function AiTool({ icon: Icon, title, text, badge, onClick, href }: { icon: typeof Film; title: string; text: string; badge: 'Free' | 'Paid'; onClick?: () => void; href?: string }) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium text-white"><Icon className="size-3.5 text-iris-300" /> {title}</span>
        <span className={cn('rounded px-1.5 py-0.5 text-[10px]', badge === 'Free' ? 'bg-signal-green/15 text-signal-green' : 'bg-iris-500/15 text-iris-200')}>{badge}</span>
      </span>
      <span className="mt-1 block text-fog-400">{text}</span>
    </>
  );
  const cls = 'block w-full rounded-xl border hairline p-2.5 text-left transition hover:border-white/25';
  return href ? <a href={href} className={cls}>{body}</a> : <button type="button" onClick={onClick} className={cls}>{body}</button>;
}

function AudioTab(p: Parameters<typeof EditorToolbox>[0] & { list: Asset[] }) {
  const music = p.timeline.audio.find((a) => a.kind === 'music');
  const [beats, setBeats] = useState<{ bpm: number; beats: number[]; confidence: number } | null>(null);
  const [every, setEvery] = useState(2);
  const [busy, setBusy] = useState(false);
  const detect = async () => {
    if (!music) return;
    setBusy(true);
    try {
      setBeats((await api<{ beats: { bpm: number; beats: number[]; confidence: number } }>(`/api/assets/${music.assetId}/beats`, { body: {} })).beats);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not analyse the music');
    } finally {
      setBusy(false);
    }
  };
  const snap = () => {
    if (!music || !beats) return;
    // Beat times on the timeline (the track may be trimmed or start later).
    const grid = beats.beats.map((b) => music.startSec + (b - music.inSec)).filter((b) => b >= 0);
    p.apply((t) => {
      const lens = snapClipsToBeats(
        t.clips.map((c) => {
          const src = p.assets.get(c.assetId);
          const speed = c.speed || 1;
          return { lengthSec: (c.outSec - c.inSec) / speed, maxSec: ((src?.durationMs ? src.durationMs / 1000 : c.outSec) - c.inSec) / speed };
        }),
        grid,
        0,
        every,
      );
      // Cuts on the beat are hard cuts (a blend would move the change off the beat).
      return { ...t, clips: t.clips.map((c, i) => (c.freezeSec ? c : { ...c, outSec: Math.round((c.inSec + lens[i]! * (c.speed || 1)) * 1000) / 1000, transition: undefined })) };
    });
    toast.success(`Every cut now lands on the beat (${beats.bpm} BPM, every ${every} beat${every > 1 ? 's' : ''})`);
  };
  return (
    <div className="space-y-3">
      <Button size="sm" variant="secondary" className="w-full" onClick={p.onTts}><Mic /> AI voice-over</Button>
      <MediaDropzone compact accept="audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg,.mp3,.wav,.m4a" label="Import music or sound" hint="MP3, WAV, M4A · music or sound effects" onAsset={() => p.onUploaded()} />
      <div className="space-y-2 rounded-xl border hairline p-2.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-white"><Wand2 className="size-3.5 text-iris-300" /> Cut to the beat</div>
        {!music ? (
          <p className="text-[11px] text-fog-400">Add a music track first.</p>
        ) : !beats ? (
          <Button size="sm" variant="ghost" loading={busy} onClick={detect}>Detect beats in the music</Button>
        ) : (
          <div className="space-y-2 text-[11px] text-fog-300">
            <div>{beats.bpm} BPM · {beats.beats.length} beats{beats.confidence < 0.2 ? ' · weak rhythm, results may vary' : ''}</div>
            <div className="flex items-center gap-2">Cut every
              <NativeSelect className="h-8 w-28" value={every} onChange={(e) => setEvery(Number(e.target.value))}>{[1, 2, 4, 8].map((n) => <option key={n} value={n}>{n} beat{n > 1 ? 's' : ''}</option>)}</NativeSelect>
            </div>
            <Button size="sm" onClick={snap}><AudioLines /> Snap all cuts to the beat</Button>
          </div>
        )}
      </div>
      <div className="space-y-1">
        <div className="text-[11px] text-fog-400">Your audio</div>
        {p.list.filter((a) => a.mediaType === 'audio').slice(0, 40).map((a) => (
          <button key={a.id} type="button" onClick={() => p.onAddMusic(a)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-fog-200 hover:bg-white/[0.05]">
            <Music className="size-3.5 text-fog-400" />
            <span className="min-w-0 flex-1 truncate" title={audioLabel(a)}>{audioLabel(a)}</span>
            {a.durationMs ? <span className="text-fog-500">{seconds(a.durationMs / 1000)}</span> : null}
            <Plus className="size-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** What a media tile is called: its file name, or what it is (an export, an AI shot, a photo reference). */
function mediaLabel(a: Asset) {
  if (a.originalName) return a.originalName;
  return a.kind === 'render' ? 'Exported video' : a.kind === 'generated' ? (a.mediaType === 'image' ? 'AI image' : 'AI video') : a.kind === 'reference' ? 'Reference' : a.mediaType === 'image' ? 'Photo' : 'Video';
}

/** A name people can tell apart: the file name, or what was generated and when. */
function audioLabel(a: Asset) {
  if (a.originalName) return a.originalName;
  const kind = (a.source as { kind?: string } | null)?.kind;
  const what = kind === 'music' ? 'AI music' : kind === 'sfx' ? 'AI sound effect' : kind === 'voice' || kind === 'tts' ? 'AI voice-over' : 'Audio';
  const d = new Date(a.createdAt);
  return Number.isNaN(d.getTime()) ? what : `${what} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function CaptionsTab({ timeline, apply, transcribe, playhead }: { timeline: Timeline; apply: Apply; transcribe: React.ReactNode; playhead: number }) {
  const [style, setStyle] = useState(CAPTION_STYLES[0]!.key);
  const subs = timeline.subtitles;
  const styled = timeline.layers.filter((l) => l.name === 'Caption (auto)').length;
  const make = () => {
    const s = CAPTION_STYLES.find((x) => x.key === style)!;
    apply((t) => ({
      ...t,
      // The styled layers replace the plain burned-in subtitles (never both).
      burnSubtitles: false,
      layers: [
        ...t.layers.filter((l) => l.name !== 'Caption (auto)'),
        ...t.subtitles.map((c) => layerSchema.parse({ id: newId('cap'), name: 'Caption (auto)', kind: 'text', track: 4, startSec: c.startSec, endSec: Math.max(c.startSec + 0.4, c.endSec), x: 0.5, y: 0.7, w: 0.86, text: { content: c.text.slice(0, 120), ...s.text }, animIn: { type: 'words', durationSec: Math.min(1.2, Math.max(0.3, (c.endSec - c.startSec) * 0.7)) } })),
      ],
    }));
    toast.success(`${subs.length} captions styled`);
  };
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-fog-400">Auto captions from the speech, then TikTok-style word-by-word captions in one click.</p>
      {transcribe}
      <div className="text-[11px] text-fog-300">{subs.length} caption line{subs.length === 1 ? '' : 's'}{styled ? ` · ${styled} styled` : ''}</div>
      {/* Your own lines (free): typed, timed at the playhead, edited here. */}
      {subs.length > 0 && (
        <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
          {[...subs].sort((a, b) => a.startSec - b.startSec).map((c) => (
            <div key={c.id} className="flex items-center gap-1.5">
              <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-fog-500">{c.startSec.toFixed(1)}s</span>
              <input
                aria-label="Caption text"
                value={c.text}
                maxLength={200}
                onChange={(e) => apply((t) => ({ ...t, subtitles: t.subtitles.map((x) => (x.id === c.id ? { ...x, text: e.target.value || ' ' } : x)) }))}
                className="min-w-0 flex-1 rounded-md border hairline bg-transparent px-2 py-1 text-xs text-fog-100 focus:border-iris-400 focus:outline-none"
              />
              <button type="button" aria-label="Delete caption line" title="Delete this line" onClick={() => apply((t) => ({ ...t, subtitles: t.subtitles.filter((x) => x.id !== c.id) }))} className="grid size-6 shrink-0 place-items-center rounded-md text-fog-500 hover:bg-white/[0.06] hover:text-signal-red"><X className="size-3.5" /></button>
            </div>
          ))}
        </div>
      )}
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          apply((t) => {
            // Starts at the playhead (never after it, so it shows right away) and ends at the next line
            // (or 2 s later), so lines never overlap.
            const start = Math.floor(playhead * 10) / 10;
            const next = t.subtitles.filter((x) => x.startSec > start + 0.05).reduce((m, x) => Math.min(m, x.startSec), Infinity);
            return { ...t, burnSubtitles: styled ? t.burnSubtitles : true, subtitles: [...t.subtitles, { id: newId('sub'), startSec: start, endSec: Math.max(start + 0.4, Math.min(start + 2, next)), text: 'Your caption' }] };
          })
        }
      >
        <Plus /> Add a line at the playhead
      </Button>
      <div className="grid grid-cols-3 gap-1.5">
        {CAPTION_STYLES.map((s) => (
          <button key={s.key} type="button" onClick={() => setStyle(s.key)} className={cn('rounded-lg border px-1 py-2 text-center text-[11px]', style === s.key ? 'border-iris-400 bg-iris-500/15 text-white' : 'hairline text-fog-300')}>
            <span style={{ color: s.text.color, fontWeight: 900, WebkitTextStroke: 'stroke' in s.text ? '0.6px #000' : undefined, background: 'background' in s.text ? '#000a' : undefined, padding: '0 3px' }}>Aa</span>
            <div>{s.label}</div>
          </button>
        ))}
      </div>
      <Button size="sm" disabled={!subs.length} onClick={make}><Captions /> Style all captions</Button>
      {styled > 0 && <Button size="sm" variant="ghost" onClick={() => apply((t) => ({ ...t, layers: t.layers.filter((l) => l.name !== 'Caption (auto)'), burnSubtitles: true }))}>Back to plain subtitles</Button>}
    </div>
  );
}

function FiltersTab({ timeline, apply, selectedClipId }: { timeline: Timeline; apply: Apply; selectedClipId: string | null }) {
  const sel = timeline.clips.find((c) => c.id === selectedClipId);
  const set = (grade: Record<string, unknown> | undefined, all: boolean) => apply((t) => ({ ...t, clips: t.clips.map((c) => (all || c.id === selectedClipId ? { ...c, adjust: grade ? ({ ...grade } as typeof c.adjust) : undefined } : c)) }));
  const [all, setAll] = useState(!sel);
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5 text-[11px]">
        <button type="button" disabled={!sel} onClick={() => setAll(false)} className={cn('rounded-lg border px-2 py-1', !all ? 'border-iris-400 text-white' : 'hairline text-fog-300', !sel && 'opacity-40')}>Selected clip</button>
        <button type="button" onClick={() => setAll(true)} className={cn('rounded-lg border px-2 py-1', all ? 'border-iris-400 text-white' : 'hairline text-fog-300')}>All clips</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => set(undefined, all)} className="rounded-lg border hairline p-2 text-left text-[11px] text-fog-200 hover:border-white/25">
          <span className="mb-1 block h-8 rounded bg-gradient-to-r from-zinc-500 to-zinc-300" />Original
        </button>
        {LOOKS.map((l) => {
          const on = !all && lookActive(l.grade, sel?.adjust as Record<string, unknown> | undefined);
          return (
            <button key={l.key} type="button" aria-pressed={on} onClick={() => set(l.grade, all)} className={cn('rounded-lg border p-2 text-left text-[11px] hover:border-iris-400/60', on ? 'border-iris-400 bg-iris-500/15 text-white' : 'hairline text-fog-200')}>
              <span className="mb-1 block h-8 rounded" style={{ background: lookSwatch(l.grade) }} />
              {l.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TransitionsTab({ timeline, apply, selectedClipId }: { timeline: Timeline; apply: Apply; selectedClipId: string | null }) {
  const [dur, setDur] = useState(0.5);
  const set = (type: 'cut' | 'fade' | 'dissolve' | 'fadeblack', all: boolean) =>
    apply((t) => ({ ...t, clips: t.clips.map((c, i) => (i < t.clips.length - 1 && (all || c.id === selectedClipId) ? { ...c, transition: type === 'cut' ? undefined : { type, durationSec: Math.min(dur, (c.outSec - c.inSec) / 3) } } : c)) }));
  const types = [
    { key: 'cut', label: 'Cut', hint: 'Hard cut — energetic' },
    { key: 'dissolve', label: 'Dissolve', hint: 'Soft blend — calm, premium' },
    { key: 'fade', label: 'Fade', hint: 'Fade between shots' },
    { key: 'fadeblack', label: 'Dip to black', hint: 'Pause or chapter change' },
  ] as const;
  const sel = timeline.clips.find((c) => c.id === selectedClipId);
  const current = sel ? (sel.transition?.type ?? 'cut') : null;
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-fog-400">{sel ? 'Pick a transition for the selected clip, or apply it to every cut.' : 'Select a clip on the timeline, or apply to every cut.'}</p>
      <label className="flex items-center justify-between text-[11px] text-fog-300">Duration <input type="range" min={0.2} max={1.2} step={0.1} value={dur} onChange={(e) => setDur(Number(e.target.value))} className="w-32 accent-iris-500" /> {dur.toFixed(1)} s</label>
      {types.map((x) => (
        <div key={x.key} className={cn('flex items-center justify-between gap-2 rounded-lg border p-2 text-xs', current === x.key ? 'border-iris-400/70 bg-iris-500/10' : 'hairline')}>
          <div className="min-w-0">
            <div className="text-fog-100">{x.label}{current === x.key && <span className="ml-1.5 text-[10px] text-iris-300">· current</span>}</div>
            <div className="text-[10px] text-fog-500">{x.hint}</div>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" disabled={!sel} onClick={() => set(x.key, false)} title="Apply to the selected clip">This clip</Button>
            <Button size="sm" variant="ghost" onClick={() => set(x.key, true)} title="Apply to every cut">All</Button>
          </div>
        </div>
      ))}
      <p className="text-[10px] text-fog-500"><ImageIcon className="mr-1 inline size-3" />The transition plays at the end of each clip, into the next one.</p>
    </div>
  );
}
