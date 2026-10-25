'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Captions,
  Download,
  History,
  ImagePlus,
  Mic,
  Music,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Scissors,
  Trash2,
  Type,
  Undo2,
  Keyboard,
  Upload,
  Bot,
  CheckCheck,
  Copy,
  Layers,
  Crosshair,
  Film,
  Network,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { clipDuration, coverPosition, LANGUAGES, reframeAt, swapShotVersion, timelineDuration, type Timeline } from '@framecraft/shared';
import { cameraStyle, Vignette } from '@/components/editor/look';
import { GradeCanvas, Grain } from '@/components/editor/grade-canvas';
import { LayersPanel, LayerStage } from '@/components/editor/layers';
import { api, ApiError, endpoints, type Asset, type Project } from '@/lib/api';
import { useJob } from '@/lib/hooks';
import { clipStarts, moveClip, newId, splitClip, useEditor } from '@/lib/editor-store';
import { Badge, Button, Card, Dialog, Field, Input, NativeSelect, Segmented, Skeleton, Spinner, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, buttonVariants } from '@/components/ui';
import { useUploader } from '@/components/studio/upload';
import { ProgressBar } from '@/components/studio/progress';
import { MultiTrack } from '@/components/editor/multitrack';
import { StoryGraph } from '@/components/editor/story-graph';
import { ShotEditor } from '@/components/editor/shot-editor';
import { Copilot } from '@/components/editor/copilot';
import { EditorToolbox } from '@/components/editor/toolbox';
import { useStudio } from '@/lib/studio';
import { cn, newKey, seconds } from '@/lib/utils';

const TRANSITIONS = ['cut', 'fade', 'dissolve', 'fadeblack', 'wipeleft', 'wiperight', 'slideup', 'circleopen'] as const;
const POS_CLASS = { top: 'top-[10%]', center: 'top-1/2 -translate-y-1/2', bottom: 'bottom-[22%]' } as const;

type Workspace = 'story' | 'edit' | 'shot' | 'review';
type TimelineResponse = { timeline: Timeline; version: number; label: string | null; durationSec: number; project: Project };

// ------------------------------------------------------------------ sequential preview player

type Logo = NonNullable<Timeline['logo']>;

/**
 * Brand logo that can be dragged anywhere in the preview (mouse, touch or arrow keys).
 * The position is stored as fractions of the frame, so the exported MP4 matches exactly.
 */
function DraggableLogo({ url, logo, onMove }: { url: string; logo: Logo; onMove: (pos: { x: number; y: number }) => void }) {
  const ref = useRef<HTMLImageElement>(null);
  // Drag state lives in refs: the frame is measured once per drag, the element is moved directly
  // in requestAnimationFrame (no React re-render per pointer move), and the final position is read
  // from the ref on release — never from a state value that may be a render behind.
  const drag = useRef<{ dx: number; dy: number; frame: DOMRect; w: number; h: number; pos: { x: number; y: number } | null; raf: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const placed = logo.x !== undefined && logo.y !== undefined ? { x: logo.x, y: logo.y } : null;

  /** Current position as fractions, measured from the DOM (works for corner presets too). */
  const measure = () => {
    const img = ref.current!;
    const frame = img.parentElement!.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    return { frame, r, x: (r.left - frame.left) / frame.width, y: (r.top - frame.top) / frame.height };
  };
  const clampPos = (x: number, y: number) => {
    const { frame, r } = measure();
    const maxX = 1 - r.width / frame.width;
    const maxY = 1 - r.height / frame.height;
    return { x: Math.min(Math.max(0, x), Math.max(0, maxX)), y: Math.min(Math.max(0, y), Math.max(0, maxY)) };
  };

  return (
    <img
      ref={ref}
      src={url}
      alt="Brand logo — drag to move"
      title="Drag to move · arrow keys to nudge"
      tabIndex={0}
      draggable={false}
      className={cn(
        'absolute cursor-grab touch-none select-none rounded outline-offset-2 focus-visible:outline-2',
        dragging ? 'cursor-grabbing outline outline-2 outline-iris-400' : 'hover:outline hover:outline-2 hover:outline-iris-400/70',
        !placed && (logo.position.includes('top') ? 'top-[4%]' : 'bottom-[4%]'),
        !placed && (logo.position.includes('left') ? 'left-[4%]' : 'right-[4%]'),
      )}
      style={{ width: `${logo.scale * 100}%`, opacity: logo.opacity, ...(placed ? { left: `${placed.x * 100}%`, top: `${placed.y * 100}%`, right: 'auto', bottom: 'auto' } : {}) }}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault();
        const img = e.currentTarget;
        const frame = img.parentElement!.getBoundingClientRect();
        const r = img.getBoundingClientRect();
        drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, frame, w: r.width, h: r.height, pos: null, raf: 0 };
        img.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const maxX = Math.max(0, 1 - d.w / d.frame.width);
        const maxY = Math.max(0, 1 - d.h / d.frame.height);
        d.pos = {
          x: Math.min(Math.max(0, (e.clientX - d.dx - d.frame.left) / d.frame.width), maxX),
          y: Math.min(Math.max(0, (e.clientY - d.dy - d.frame.top) / d.frame.height), maxY),
        };
        if (!d.raf) {
          d.raf = requestAnimationFrame(() => {
            d.raf = 0;
            const img = ref.current;
            if (!img || !d.pos) return;
            img.style.left = `${d.pos.x * 100}%`;
            img.style.top = `${d.pos.y * 100}%`;
            img.style.right = 'auto';
            img.style.bottom = 'auto';
          });
        }
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        setDragging(false);
        if (d?.raf) cancelAnimationFrame(d.raf);
        if (d?.pos) onMove(d.pos); // exact release position, one undo step per drag
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
        // Undo the direct style edits: back to the saved position (or the corner preset).
        const img = ref.current;
        if (img) {
          img.style.left = placed ? `${placed.x * 100}%` : '';
          img.style.top = placed ? `${placed.y * 100}%` : '';
          img.style.right = placed ? 'auto' : '';
          img.style.bottom = placed ? 'auto' : '';
        }
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.05 : 0.01;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!d) return;
        e.preventDefault();
        const cur = measure();
        onMove(clampPos(cur.x + d[0]!, cur.y + d[1]!));
      }}
    />
  );
}

function Preview({ timeline, assets, playhead, setPlayhead, onLogoMove, selectedLayer, onSelectLayer, onLayerChange }: { timeline: Timeline; assets: Map<string, Asset>; playhead: number; setPlayhead: (t: number) => void; onLogoMove: (pos: { x: number; y: number }) => void; selectedLayer: string | null; onSelectLayer: (id: string | null) => void; onLayerChange: (id: string, patch: Partial<Timeline['layers'][number]>) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [safe, setSafe] = useState<'off' | 'tiktok' | 'reels'>('off');
  const [playing, setPlaying] = useState(false);
  // Space (editor shortcut) toggles playback.
  useEffect(() => {
    const toggle = () => setPlaying((v) => !v);
    window.addEventListener('fc-editor-toggle-play', toggle);
    return () => window.removeEventListener('fc-editor-toggle-play', toggle);
  }, []);
  const starts = useMemo(() => clipStarts(timeline), [timeline]);
  const total = timelineDuration(timeline);
  const index = Math.max(0, starts.findLastIndex((s) => s <= playhead + 0.001));
  const clip = timeline.clips[index];
  const asset = clip ? assets.get(clip.assetId) : undefined;
  const clipT = playhead - (starts[index] ?? 0);
  const speed = clip?.freezeSec ? 1 : (clip?.speed ?? 1);
  const localTime = clip ? (clip.freezeSec ? clip.inSec : clip.inSec + clipT * speed) : 0;
  const clipLenNow = clip ? clipDuration(clip) : 0;

  // Keep the <video> element in sync with the playhead (seek when paused or when switching clips).
  useEffect(() => {
    const v = video.current;
    if (!v || !asset) return;
    if (Math.abs(v.currentTime - localTime) > 0.35) v.currentTime = Math.max(0, localTime);
  }, [asset, localTime]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.playbackRate = speed;
    if (playing && !clip?.freezeSec) void v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [playing, asset?.id, speed, clip?.freezeSec]);

  // Freeze frames have no video playback to drive the playhead: tick it.
  useEffect(() => {
    if (!playing || !clip?.freezeSec) return;
    const from = performance.now();
    const base = playhead;
    const id = setInterval(() => {
      const next = base + (performance.now() - from) / 1000;
      if (next >= (starts[index] ?? 0) + clipLenNow) {
        clearInterval(id);
        if (index + 1 >= timeline.clips.length) {
          setPlaying(false);
          setPlayhead(0);
        } else setPlayhead((starts[index + 1] ?? 0) + 0.001);
      } else setPlayhead(next);
    }, 80);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, clip?.id]);

  // Clip volume as in the export (dubbed shots duck or mute the clip's own audio).
  const clipVolume = clip?.volume ?? 1;
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.muted = timeline.muteClipAudio || clipVolume === 0;
    v.volume = Math.min(1, Math.max(0, clipVolume));
  }, [clipVolume, timeline.muteClipAudio, asset?.id]);

  // Audio tracks (music / voice-over / sfx) play in sync with the playhead, like the export.
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  useEffect(() => {
    const els = audioEls.current;
    for (const a of timeline.audio) {
      const src = assets.get(a.assetId)?.url;
      if (!src) continue;
      // Keyed by track and file: a new take on the same track replaces the old player (never both).
      const key = `${a.id}:${a.assetId}`;
      let el = els.get(key);
      if (!el) {
        el = new Audio(src);
        el.preload = 'auto';
        els.set(key, el);
      }
      el.volume = Math.min(1, Math.max(0, a.volume));
      const len = a.outSec - a.inSec;
      const local = playhead - a.startSec;
      if (playing && local >= 0 && local < len) {
        // The playhead only ticks a few times a second, so a track is noticed a little late:
        // start it from its beginning then (never skip the first syllable), and only resync drift later.
        const want = el.paused && local < 0.5 ? a.inSec : a.inSec + local;
        if (el.paused || Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
        if (el.paused) void el.play().catch(() => undefined);
      } else if (!el.paused) el.pause();
    }
    // Stop tracks that were removed (or whose file changed).
    for (const [key, el] of els) {
      if (!timeline.audio.some((a) => `${a.id}:${a.assetId}` === key)) {
        el.pause();
        els.delete(key);
      }
    }
  }, [playing, playhead, timeline.audio, assets]);
  useEffect(() => () => audioEls.current.forEach((el) => el.pause()), []);

  const onTime = () => {
    const v = video.current;
    if (!v || !clip || !playing || clip.freezeSec) return;
    if (v.currentTime >= clip.outSec - 0.04) {
      const next = (starts[index + 1] ?? total) + 0.001;
      if (index + 1 >= timeline.clips.length) {
        setPlaying(false);
        setPlayhead(0);
      } else setPlayhead(next);
      return;
    }
    setPlayhead((starts[index] ?? 0) + (v.currentTime - clip.inSec) / speed);
  };
  // Fades and opacity go towards black, like the export.
  const fade = clip ? Math.min(1, clip.fadeInSec ? clipT / clip.fadeInSec : 1, clip.fadeOutSec ? (clipLenNow - clipT) / clip.fadeOutSec : 1) * (clip.opacity ?? 1) : 1;
  const overlays = timeline.overlays.filter((o) => playhead >= o.startSec && playhead <= o.endSec);

  const [w, h] = timeline.aspectRatio.split(':').map(Number);
  const texts = timeline.texts.filter((t) => playhead >= t.startSec && playhead <= t.endSec);
  const subs = timeline.burnSubtitles ? timeline.subtitles.filter((s) => playhead >= s.startSec && playhead <= s.endSec) : [];
  const logo = timeline.logo ? assets.get(timeline.logo.assetId) : undefined;

  return (
    <div className="space-y-3">
      <div ref={frame} className="relative mx-auto max-h-[46dvh] overflow-hidden rounded-2xl border hairline bg-black" style={{ aspectRatio: `${w}/${h}` }} onPointerDown={() => onSelectLayer(null)}>
        {asset ? (
          <div className="absolute inset-0 overflow-hidden" style={{ opacity: Math.max(0, fade) }}>
            <div className="size-full" style={cameraStyle(clip?.camera, clipT)}>
              <video ref={video} src={asset.url} playsInline muted={timeline.muteClipAudio || clipVolume === 0} onTimeUpdate={onTime} className="size-full object-cover" preload="auto" style={clip?.reframe && video.current?.videoWidth ? (() => { const pos = coverPosition({ w: video.current!.videoWidth, h: video.current!.videoHeight }, { w: w!, h: h! }, reframeAt(clip.reframe!.points, localTime)); return { objectPosition: `${pos.x}% ${pos.y}%` }; })() : undefined} />
              <GradeCanvas video={video} adjust={clip?.adjust} lutUrl={clip?.adjust?.lut ? (assets.get(clip.adjust.lut.assetId)?.url ?? null) : null} />
            </div>
            <Vignette amount={clip?.adjust?.vignette} />
            <Grain amount={clip?.adjust?.grain} />
          </div>
        ) : (
          <div className="grid size-full place-items-center text-sm text-fog-400">Add clips to start</div>
        )}
        {overlays.map((o) => {
          const a = assets.get(o.assetId);
          if (!a) return null;
          const style = { left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, opacity: o.opacity } as const;
          return a.mediaType === 'video' ? <video key={o.id} src={a.url} muted autoPlay={playing} loop playsInline className="pointer-events-none absolute" style={style} /> : <img key={o.id} src={a.url} alt="" className="pointer-events-none absolute" style={style} />;
        })}
        {clip?.reverse && <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-white">Plays reversed in the export</span>}
        {clip?.freezeSec && <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-white">Freeze frame</span>}
        {texts.map((t) => (
          <div key={t.id} className={cn('pointer-events-none absolute inset-x-4 text-center font-semibold', POS_CLASS[t.position])} style={{ color: t.color, fontSize: `clamp(12px, ${t.fontSize / 18}vw, ${t.fontSize / 2.2}px)` }}>
            <span className={cn(t.background && 'rounded-md bg-black/50 px-2 py-0.5')}>{t.text}</span>
          </div>
        ))}
        {subs.map((s) => (
          <div key={s.id} className="pointer-events-none absolute inset-x-4 bottom-[14%] text-center text-sm font-semibold text-white [text-shadow:0_0_4px_#000,0_0_2px_#000] md:text-base">{s.text}</div>
        ))}
        <LayerStage timeline={timeline} t={playhead} playing={playing} assets={assets} selectedId={selectedLayer} onSelect={onSelectLayer} onChange={onLayerChange} frame={frame} frameH={540} />
        {safe !== 'off' && (
          // Platform UI that covers the video: keep text out of these areas.
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute inset-x-0 bottom-0 h-[20%] bg-signal-red/20" />
            <div className="absolute bottom-[20%] right-0 top-[38%] w-[16%] bg-signal-red/20" />
            <div className="absolute inset-x-0 top-0 h-[9%] bg-signal-red/15" />
            <span className="absolute bottom-1 left-2 text-[9px] text-white/80">{safe === 'tiktok' ? 'TikTok' : 'Reels'} UI area — keep text out</span>
          </div>
        )}
        {logo && timeline.logo && <DraggableLogo url={logo.url} logo={timeline.logo} onMove={onLogoMove} />}
        {asset?.isFixture && <span className="absolute left-2 top-2 rounded-full bg-signal-amber px-2 py-0.5 text-[10px] font-semibold text-black">TEST FIXTURE · NOT AI</span>}
      </div>
      <div className="flex items-center gap-3">
        <Button size="icon" variant="secondary" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((p) => !p)} disabled={!timeline.clips.length}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <input type="range" aria-label="Playhead" min={0} max={Math.max(0.1, total)} step={0.05} value={Math.min(playhead, total)} onChange={(e) => { setPlaying(false); setPlayhead(Number(e.target.value)); }} className="flex-1" />
        <span className="w-24 text-right text-xs tabular-nums text-fog-300">
          {seconds(playhead)} / {seconds(total)}
        </span>
        <select aria-label="Safe zones" value={safe} onChange={(e) => setSafe(e.target.value as typeof safe)} className="h-8 rounded-lg border hairline bg-ink-900 px-1.5 text-[11px] text-fog-200">
          <option value="off">Safe zones</option>
          <option value="tiktok">TikTok</option>
          <option value="reels">Reels</option>
        </select>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ logo style (original / no background)

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
        <Segmented
          size="sm"
          value={transparent ? 'clean' : 'original'}
          onChange={(v) => (v === 'original' ? onChange({ assetId: logo.originalAssetId ?? logo.assetId, originalAssetId: undefined }) : void removeBg(strength))}
          options={[
            { value: 'original', label: 'Original' },
            { value: 'clean', label: 'No background' },
          ]}
        />
        {busy && <Spinner />}
      </div>
      {transparent && (
        <div className="flex items-center gap-2 text-xs text-fog-400">
          Cleanup
          <Segmented size="sm" value={strength} onChange={(v) => void removeBg(v)} options={CLEANUP} />
        </div>
      )}
      {transparent && <p className="text-[11px] text-fog-400">Removes the plain background around the logo. If edges look rough, try Gentle or Strong.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ export panel

function ExportPanel({ projectId, timeline }: { projectId: string; timeline: Timeline }) {
  const [preset, setPreset] = useState<'master' | 'tiktok' | 'reels' | 'shorts' | 'youtube' | 'feed'>('master');
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data } = useJob(jobId);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ job: { id: string } }>(`/api/projects/${projectId}/render`, { body: { timeline, preset, idempotencyKey: newKey() } });
      setJobId(r.job.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };
  const job = data?.job;
  return (
    <div className="space-y-4">
      <Field label="Export preset" hint="Rendering uses FFmpeg on our servers — no AI credits.">
        <NativeSelect value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
          <option value="master">Master (timeline settings)</option>
          <option value="tiktok">TikTok 9:16 1080p</option>
          <option value="reels">Instagram Reels 9:16 1080p</option>
          <option value="shorts">YouTube Shorts 9:16 1080p</option>
          <option value="youtube">YouTube 16:9 1080p</option>
          <option value="feed">Feed 4:5 1080p</option>
        </NativeSelect>
      </Field>
      <Button onClick={start} loading={busy} disabled={!timeline.clips.length}>
        <Download /> Render MP4
      </Button>
      {job && (
        <Card className="p-3 text-sm">
          {job.status === 'completed' ? (
            <div className="text-fog-100">{job.phase}</div>
          ) : (
            <ProgressBar progress={job.progress} etaSec={job.etaSec} label={job.phase} />
          )}
          {job.status === 'completed' && job.outputUrl && (
            <a href={job.outputUrl} download className={cn(buttonVariants({ variant: 'white', size: 'sm' }), 'mt-3')}>
              <Download /> Download {job.isFixture ? '(contains test fixtures)' : ''}
            </a>
          )}
          {job.status === 'failed' && <p className="mt-2 text-signal-red">{job.error?.message}</p>}
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ page

export default function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { timeline, apply, undo, redo, load, selected, select, dirty, markSaved, past, future } = useEditor();
  const [playhead, setPlayhead] = useState(0);
  const playheadRef = useRef(0);
  playheadRef.current = playhead;
  const [saving, setSaving] = useState(false);
  const [libraryFor, setLibraryFor] = useState<null | { kind: 'clip' | 'replace' | 'audio' | 'logo' | 'overlay' | 'layer-image' | 'layer-video' }>(null);
  const [ttsOpen, setTtsOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>('story');
  const [shotClip, setShotClip] = useState<string | null>(null);
  const [compareInit, setCompareInit] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const layerPick = useRef<null | { kind: 'image' | 'video'; cb: (a: Asset) => void }>(null);
  const studioQ = useStudio(id);

  const tq = useQuery({ queryKey: ['timeline', id], queryFn: () => api<TimelineResponse>(`/api/projects/${id}/timeline`), staleTime: Infinity });
  const assetsQ = useQuery({ queryKey: ['assets', 'all'], queryFn: () => endpoints.assets('?limit=200'), refetchInterval: 15_000 });
  const assets = useMemo(() => new Map((assetsQ.data?.assets ?? []).map((a) => [a.id, a])), [assetsQ.data]);

  useEffect(() => {
    if (tq.data) load(tq.data.timeline);
  }, [tq.data, load]);

  const save = useCallback(
    async (autosave: boolean, label?: string) => {
      const t = useEditor.getState().timeline;
      if (!t) return;
      setSaving(true);
      try {
        await api(`/api/projects/${id}/timeline`, { method: 'PUT', body: { timeline: t, autosave, label } });
        markSaved();
        if (!autosave) toast.success('Saved');
      } catch (e) {
        if (!autosave) toast.error(e instanceof ApiError ? e.message : 'Save failed');
      } finally {
        setSaving(false);
      }
    },
    [id, markSaved],
  );

  // Autosave 3 s after the last change.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void save(true), 3000);
    return () => clearTimeout(t);
  }, [dirty, timeline, save]);

  // Keyboard shortcuts: Space play/pause, S split, Delete remove, Ctrl+D duplicate, ←/→ step,
  // Home/End, ? help, Ctrl/Cmd+Z undo, Shift+Ctrl/Cmd+Z redo, Ctrl/Cmd+S save.
  const [helpOpen, setHelpOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState('clip');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || el?.isContentEditable) return;
      const st = useEditor.getState();
      const t = st.timeline;
      if (!t) return;
      const starts0 = clipStarts(t);
      const ci = t.clips.findIndex((c) => c.id === st.selected);
      if (!(e.ctrlKey || e.metaKey)) {
        if (e.key === ' ') {
          e.preventDefault();
          window.dispatchEvent(new Event('fc-editor-toggle-play'));
        } else if (e.key === '?') setHelpOpen(true);
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const d = (e.shiftKey ? 1 : 1 / 30) * (e.key === 'ArrowRight' ? 1 : -1);
          setPlayhead((ph) => Math.max(0, Math.min(timelineDuration(t), ph + d)));
        } else if (e.key === 'Home') setPlayhead(0);
        else if (e.key === 'End') setPlayhead(Math.max(0, timelineDuration(t) - 0.05));
        else if (e.key.toLowerCase() === 's' && ci >= 0) {
          const c = t.clips[ci]!;
          st.apply((x) => splitClip(x, c.id, c.inSec + (playheadRef.current - (starts0[ci] ?? 0)) * (c.speed || 1)));
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && ci >= 0 && t.clips.length > 1) {
          e.preventDefault();
          st.apply((x) => ({ ...x, clips: x.clips.filter((c) => c.id !== st.selected) }));
        }
        return;
      }
      if (e.key.toLowerCase() === 'd' && ci >= 0) {
        e.preventDefault();
        st.apply((x) => {
          const c = x.clips[ci]!;
          x.clips.splice(ci + 1, 0, { ...c, id: newId('clip'), transition: undefined });
          return x;
        });
        return;
      }
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, save]);

  // Deep link from notifications: /app/editor/:id?shot=<shotId> opens that shot.
  const hasTimeline = Boolean(timeline);
  useEffect(() => {
    // Films and ads open on the story graph; single videos go straight to the timeline.
    if (!useEditor.getState().timeline?.clips.some((c) => c.shotId)) setWorkspace('edit');
    const shotId = new URLSearchParams(window.location.search).get('shot');
    const c = shotId && useEditor.getState().timeline?.clips.find((x) => x.shotId === shotId);
    if (c) {
      setShotClip(c.id);
      setWorkspace('shot');
    }
  }, [hasTimeline]);

  const openShot = useCallback(
    (clipId: string, compare: string | null = null) => {
      select(clipId);
      setShotClip(clipId);
      setCompareInit(compare);
      setWorkspace('shot');
    },
    [select],
  );
  const playFrom = useCallback(
    (clipId: string) => {
      const t = useEditor.getState().timeline;
      if (!t) return;
      select(clipId);
      setPlayhead((clipStarts(t)[t.clips.findIndex((c) => c.id === clipId)] ?? 0) + 0.01);
    },
    [select],
  );
  const refetchStudio = studioQ.refetch;
  const activateVersion = useCallback(
    async (_shotId: string, versionId: string) => {
      try {
        const r = await api<{ shotId: string; versionId: string; assetId: string; durationSec: number; previousDurationSec?: number }>(`/api/shot-versions/${versionId}/activate`, { body: {} });
        apply((t) => swapShotVersion(t, r.shotId, r));
        void refetchStudio();
        toast.success('Version switched — the other versions are kept');
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : 'Could not switch version');
      }
    },
    [apply, refetchStudio],
  );
  const compareFromGraph = useCallback(
    (shotId: string, versionId: string) => {
      const c = useEditor.getState().timeline?.clips.find((x) => x.shotId === shotId);
      if (c) openShot(c.id, versionId);
    },
    [openShot],
  );
  const saveLayout = useCallback((layout: { positions: Record<string, { x: number; y: number }>; collapsed: string[] }) => void api(`/api/projects/${id}/graph`, { method: 'PUT', body: layout }).catch(() => undefined), [id]);

  const audioUp = useUploader({ projectId: id, accept: 'audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg' });
  const videoUp = useUploader({ projectId: id, accept: 'video/mp4,video/quicktime,video/webm' });
  const logoUp = useUploader({ projectId: id });

  if (!timeline || tq.isLoading) return <Skeleton className="mx-auto h-[70dvh] max-w-6xl" />;
  const starts = clipStarts(timeline);
  const total = timelineDuration(timeline);
  const sel = timeline.clips.find((c) => c.id === selected);
  const selIndex = timeline.clips.findIndex((c) => c.id === selected);
  const selAsset = sel ? assets.get(sel.assetId) : undefined;
  const selMax = selAsset?.durationMs ? selAsset.durationMs / 1000 : sel?.outSec ?? 10;
  const videos = (assetsQ.data?.assets ?? []).filter((a) => a.mediaType === 'video');

  const addAssetAsClip = (a: Asset) =>
    apply((t) => {
      t.clips.push({ id: newId('clip'), assetId: a.id, inSec: 0, outSec: Math.max(0.5, (a.durationMs ?? 5000) / 1000), volume: 1, label: a.originalName ?? undefined, speed: 1, reverse: false, fadeInSec: 0, fadeOutSec: 0, opacity: 1 });
      return t;
    });

  const pickLibrary = (a: Asset) => {
    const kind = libraryFor?.kind;
    setLibraryFor(null);
    if (kind === 'clip') addAssetAsClip(a);
    else if (kind === 'replace' && sel)
      apply((t) => {
        const c = t.clips.find((x) => x.id === sel.id)!;
        c.assetId = a.id;
        c.inSec = 0;
        c.outSec = Math.max(0.5, (a.durationMs ?? 5000) / 1000);
        return t;
      });
    else if (kind === 'audio')
      apply((t) => {
        t.audio.push({ id: newId('aud'), assetId: a.id, kind: 'music', startSec: 0, inSec: 0, outSec: Math.max(1, (a.durationMs ?? total * 1000) / 1000), volume: 0.6, fadeInSec: 0, fadeOutSec: 1, muted: false, duck: true, denoise: false });
        return t;
      });
    else if ((kind === 'layer-image' || kind === 'layer-video') && layerPick.current) {
      layerPick.current.cb(a);
      layerPick.current = null;
    } else if (kind === 'overlay')
      apply((t) => {
        const len = a.mediaType === 'video' ? Math.min(10, (a.durationMs ?? 4000) / 1000) : 3;
        t.overlays.push({ id: newId('ov'), assetId: a.id, startSec: Math.round(playhead * 10) / 10, endSec: Math.round((playhead + len) * 10) / 10, x: 0.6, y: 0.06, w: 0.34, opacity: 1, inSec: 0 });
        return t;
      });
    else if (kind === 'logo')
      apply((t) => {
        t.logo = { assetId: a.id, position: 'top-right', scale: 0.12, opacity: 0.9 };
        return t;
      });
  };

  const previewCard = (
    <Card className="p-3 md:p-4">
            <Preview timeline={timeline} assets={assets} playhead={playhead} setPlayhead={setPlayhead} onLogoMove={(pos) => apply((t) => ({ ...t, logo: t.logo ? { ...t.logo, ...pos } : t.logo }))} selectedLayer={selectedLayer} onSelectLayer={setSelectedLayer} onLayerChange={(lid, patch) => apply((t) => ({ ...t, layers: t.layers.map((x) => (x.id === lid ? { ...x, ...patch } : x)) }))} />
          </Card>
  );
  const timelineCard = <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium text-white">Timeline · {seconds(total)}</div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => setLibraryFor({ kind: 'clip' })}><Plus /> Clip</Button>
                <Button size="sm" variant="ghost" onClick={async () => { const a = await videoUp.pick(); if (a) { addAssetAsClip(a); void assetsQ.refetch(); } }}><Upload /> Upload video</Button>
              </div>
            </div>
            {timeline.clips.length ? (
              <MultiTrack
                timeline={timeline}
                assets={assets}
                playhead={playhead}
                selected={selected}
                onSeek={setPlayhead}
                onSelectClip={(clipId, at) => {
                  select(clipId);
                  setPlayhead(at);
                }}
                selectedLayer={selectedLayer}
                onSelectLayer={setSelectedLayer}
                onLayerTiming={(lid, startSec, endSec) => apply((t) => ({ ...t, layers: t.layers.map((x) => (x.id === lid ? { ...x, startSec, endSec } : x)) }))}
                onMoveClip={(from, to) =>
                  apply((t) => {
                    const fi = t.clips.findIndex((x) => x.id === from);
                    if (fi < 0 || fi === to) return t;
                    const [m] = t.clips.splice(fi, 1);
                    t.clips.splice(to, 0, m!);
                    return t;
                  })
                }
              />
            ) : (
              <div className="w-full rounded-lg border border-dashed hairline py-5 text-center text-sm text-fog-400">No clips — add generated or uploaded videos.</div>
            )}
          </div>;
  const studio = studioQ.data;
  const reviewOps = (studio?.shots ?? []).flatMap((sh) => sh.operations.filter((o) => o.status === 'ready').map((o) => ({ shot: sh, op: o })));
  const shotEditorClip = shotClip && timeline.clips.some((c) => c.id === shotClip) ? shotClip : (sel?.id ?? timeline.clips[0]?.id ?? null);
  const shotEditorShot = studio?.shots.find((sh) => sh.id === timeline.clips.find((c) => c.id === shotEditorClip)?.shotId);
  const graphLayout = (tq.data!.project.settings as { graph?: { positions?: Record<string, { x: number; y: number }>; collapsed?: string[] } } | undefined)?.graph;

  return (
    <div className="mx-auto max-w-[1600px]">
      {audioUp.element}
      {videoUp.element}
      {logoUp.element}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href={tq.data!.project.kind === 'movie' ? `/app/movie/${id}` : tq.data!.project.kind === 'edit' ? '/app/edit' : `/app/projects/${id}`} className="text-[11px] text-fog-400 hover:text-white">
            ← Back
          </Link>
          <h1 className="max-w-[40ch] truncate text-base font-semibold text-white" title={tq.data!.project.title}>{tq.data!.project.title}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-1 rounded-xl border hairline bg-white/[0.02] p-1">
          {(
            [
              ['story', Network, 'Story graph'],
              ['edit', Film, 'Timeline edit'],
              ['shot', Crosshair, 'Shot editor'],
              ['review', CheckCheck, `Review${reviewOps.length ? ` · ${reviewOps.length}` : ''}`],
            ] as const
          ).map(([k, Icon, label]) => (
            <button key={k} type="button" onClick={() => setWorkspace(k)} className={cn('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs', workspace === k ? 'bg-iris-500 text-white' : 'text-fog-300 hover:bg-white/[0.06]')}>
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="mr-2 text-xs text-fog-400">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
          <Button size="icon" variant="ghost" aria-label="Undo" onClick={undo} disabled={!past.length}><Undo2 /></Button>
          <Button size="icon" variant="ghost" aria-label="Redo" onClick={redo} disabled={!future.length}><Redo2 /></Button>
          <Button size="icon" variant="ghost" aria-label="Versions" onClick={() => setVersionsOpen(true)}><History /></Button>
          <Button size="icon" variant="ghost" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}><Keyboard /></Button>
          <Button size="icon" variant="ghost" aria-label="Save a version" title="Save a version (Ctrl+S)" onClick={() => save(false, 'Manual save')}><Save /></Button>
          {(tq.data!.project.settings as { ad?: { campaignId?: string } } | undefined)?.ad?.campaignId && (
            <Link href={`/app/ads/footage/${(tq.data!.project.settings as { ad: { campaignId: string } }).ad.campaignId}`} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>Ad storyboard</Link>
          )}
          <Button size="sm" variant={assistantOpen ? 'primary' : 'outline'} onClick={() => setAssistantOpen((o) => !o)}><Bot /> Assistant</Button>
          <Button size="sm" onClick={() => { setWorkspace('edit'); setInspectorTab('export'); }}><Download /> Export</Button>
        </div>
      </div>

      {workspace === 'story' && (
        <div className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
            <div className="h-[62dvh] min-h-[440px]">
              <StoryGraph projectId={id} timeline={timeline} studio={studio} assets={assets} selectedClipId={selected} savedLayout={graphLayout} apply={apply} onSelectClip={playFrom} onPlayFrom={playFrom} onOpenShot={openShot} onUseVersion={activateVersion} onCompare={compareFromGraph} onSaveLayout={saveLayout} />
            </div>
            <div className="min-w-0 space-y-3">
              {previewCard}
              {sel && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => openShot(sel.id)}><Crosshair /> Edit this shot</Button>
                  <Button size="sm" variant="ghost" onClick={() => setWorkspace('edit')}><Film /> Clip settings</Button>
                </div>
              )}
            </div>
          </div>
          <Card className="p-3 md:p-4">{timelineCard}</Card>
        </div>
      )}

      {workspace === 'shot' && shotEditorClip && (
        <ShotEditor key={shotEditorClip} projectId={id} clipId={shotEditorClip} timeline={timeline} apply={apply} shot={shotEditorShot} assets={assets} onClose={() => setWorkspace('story')} initialCompare={compareInit} />
      )}

      {workspace === 'review' && (
        <div className="space-y-3">
          <p className="text-sm text-fog-300">AI edits waiting for your decision. Nothing in the movie changes until you accept.</p>
          {!reviewOps.length && <Card className="p-6 text-center text-sm text-fog-400">Nothing to review.</Card>}
          {reviewOps.map(({ shot, op }) => {
            const v = shot.versions.find((x) => x.id === op.resultVersionId);
            return (
              <Card key={op.id} className="flex flex-wrap items-center gap-3 p-3">
                {v?.media?.thumbnailUrl && <img src={v.media.thumbnailUrl} alt="" className="h-14 rounded-lg" />}
                <div className="min-w-0 flex-1 text-sm">
                  <div className="text-white">Shot {shot.number} · {op.mode.replaceAll('_', ' ')} · {seconds(op.startSec)}–{seconds(op.endSec)}</div>
                  <div className="truncate text-xs text-fog-400">{op.instruction}</div>
                </div>
                <Button size="sm" onClick={() => { const c = timeline.clips.find((x) => x.shotId === shot.id); if (c) openShot(c.id, op.resultVersionId); }}>Compare &amp; decide</Button>
              </Card>
            );
          })}
        </div>
      )}

      {assistantOpen && (
        <div className="fixed bottom-4 right-4 z-40 h-[min(560px,80dvh)] w-[min(420px,calc(100vw-2rem))] rounded-2xl border hairline bg-ink-900/95 p-3 shadow-2xl backdrop-blur">
          <Copilot projectId={id} timeline={timeline} apply={apply} onEditStarted={() => void refetchStudio()} />
        </div>
      )}

      {workspace === 'edit' && (
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[300px_minmax(0,1fr)_360px]">
        {/* Left: CapCut-style tools (media, audio, text, stickers, captions, filters, transitions) */}
        <div className="order-2 h-[360px] min-h-0 lg:hidden xl:order-none xl:block xl:h-[max(380px,calc(46dvh+5.5rem))]">
          <EditorToolbox
            projectId={id}
            timeline={timeline}
            apply={apply}
            assets={assets}
            playhead={playhead}
            selectedClipId={selected}
            onAddClip={(a) => { addAssetAsClip(a); toast.success('Added to the end of the timeline'); }}
            onAddMusic={(a) => apply((t) => { t.audio.push({ id: newId('aud'), assetId: a.id, kind: 'music', startSec: 0, inSec: 0, outSec: Math.max(1, Math.min((a.durationMs ?? total * 1000) / 1000, total || 600)), volume: 0.6, fadeInSec: 0, fadeOutSec: 1, muted: false, duck: true, denoise: false }); return t; })}
            onTts={() => setTtsOpen(true)}
            onUploaded={() => void assetsQ.refetch()}
            onSelectLayer={setSelectedLayer}
            transcribe={<TranscribeButton projectId={id} timeline={timeline} assets={assets} onCues={(cues) => apply((t) => ({ ...t, subtitles: cues.map((c) => ({ ...c, id: newId('sub') })) }))} />}
          />
        </div>
        <div className="order-1 min-w-0 xl:order-none">{previewCard}</div>

        {/* Right: inspector */}
        <Card className="order-3 p-3 md:p-4 lg:max-h-[max(380px,calc(46dvh+5.5rem))] lg:overflow-y-auto xl:order-none">
          <Tabs value={inspectorTab} onValueChange={setInspectorTab}>
            <TabsList className="mb-4">
              <TabsTrigger value="clip"><Scissors className="mr-1 inline size-3.5" />Clip</TabsTrigger>
              <TabsTrigger value="audio"><AudioLines className="mr-1 inline size-3.5" />Audio</TabsTrigger>
              <TabsTrigger value="text"><Type className="mr-1 inline size-3.5" />Text</TabsTrigger>
              <TabsTrigger value="subs"><Captions className="mr-1 inline size-3.5" />Subs</TabsTrigger>
              <TabsTrigger value="layers"><Layers className="mr-1 inline size-3.5" />Layers</TabsTrigger>
              <TabsTrigger value="overlay">PiP (V2)</TabsTrigger>
              <TabsTrigger value="export"><Download className="mr-1 inline size-3.5" />Export</TabsTrigger>
            </TabsList>

            <TabsContent value="clip" className="space-y-4">
              {sel ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-white">Clip {selIndex + 1}</span>
                    {selAsset?.isFixture && <Badge tone="amber">fixture</Badge>}
                  </div>
                  <Field label={`In point · ${seconds(sel.inSec)}`}>
                    <input type="range" className="w-full" min={0} max={selMax} step={0.05} value={sel.inSec} onChange={(e) => apply((t) => { const c = t.clips[selIndex]!; c.inSec = Math.min(Number(e.target.value), c.outSec - 0.2); return t; })} />
                  </Field>
                  <Field label={`Out point · ${seconds(sel.outSec)}`}>
                    <input type="range" className="w-full" min={0} max={selMax} step={0.05} value={sel.outSec} onChange={(e) => apply((t) => { const c = t.clips[selIndex]!; c.outSec = Math.max(Number(e.target.value), c.inSec + 0.2); return t; })} />
                  </Field>
                  <Field label="Transition into next clip">
                    <div className="grid grid-cols-[1fr_90px] gap-2">
                      <NativeSelect value={sel.transition?.type ?? 'cut'} onChange={(e) => apply((t) => { const c = t.clips[selIndex]!; c.transition = e.target.value === 'cut' ? undefined : { type: e.target.value as (typeof TRANSITIONS)[number], durationSec: c.transition?.durationSec ?? 0.5 }; return t; })}>
                        {TRANSITIONS.map((x) => <option key={x}>{x}</option>)}
                      </NativeSelect>
                      <Input type="number" step={0.1} min={0.1} max={3} aria-label="Transition seconds" value={sel.transition?.durationSec ?? 0.5} disabled={!sel.transition} onChange={(e) => apply((t) => { const c = t.clips[selIndex]!; if (c.transition) c.transition.durationSec = Number(e.target.value); return t; })} />
                    </div>
                  </Field>
                  <Field label={`Speed · ${sel.speed}×`} hint={sel.freezeSec ? 'Freeze frames hold one frame.' : `Lasts ${seconds(clipDuration(sel))} on the timeline.`}>
                    <input type="range" className="w-full" min={0.25} max={4} step={0.05} value={sel.speed} disabled={Boolean(sel.freezeSec)} onChange={(e) => apply((t) => { t.clips[selIndex]!.speed = Number(e.target.value); return t; })} />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={`Fade in · ${sel.fadeInSec}s`}><input type="range" className="w-full" min={0} max={3} step={0.1} value={sel.fadeInSec} onChange={(e) => apply((t) => { t.clips[selIndex]!.fadeInSec = Number(e.target.value); return t; })} /></Field>
                    <Field label={`Fade out · ${sel.fadeOutSec}s`}><input type="range" className="w-full" min={0} max={3} step={0.1} value={sel.fadeOutSec} onChange={(e) => apply((t) => { t.clips[selIndex]!.fadeOutSec = Number(e.target.value); return t; })} /></Field>
                  </div>
                  <Field label={`Opacity · ${Math.round(sel.opacity * 100)}%`} hint="Fades the picture towards black.">
                    <input type="range" className="w-full" min={0} max={1} step={0.05} value={sel.opacity} onChange={(e) => apply((t) => { t.clips[selIndex]!.opacity = Number(e.target.value); return t; })} />
                  </Field>
                  <label className="flex items-center justify-between text-sm text-fog-200">Reverse <Switch checked={sel.reverse} onCheckedChange={(v) => apply((t) => { t.clips[selIndex]!.reverse = v; return t; })} label="Reverse clip" /></label>
                  <Field label={`Clip volume · ${Math.round(sel.volume * 100)}%`}>
                    <input type="range" className="w-full" min={0} max={2} step={0.05} value={sel.volume} onChange={(e) => apply((t) => { t.clips[selIndex]!.volume = Number(e.target.value); return t; })} />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Button size="sm" variant="secondary" onClick={() => apply((t) => splitClip(t, sel.id, sel.inSec + (playhead - (starts[selIndex] ?? 0))))}><Scissors /> Split at playhead</Button>
                    <Button size="sm" variant="secondary" onClick={() => setLibraryFor({ kind: 'replace' })}><RotateCcw /> Replace</Button>
                    <Button size="sm" variant="secondary" onClick={() => apply((t) => { const c = t.clips[selIndex]!; const at = Math.min(c.outSec - 0.05, c.inSec + (playhead - (starts[selIndex] ?? 0)) * (c.speed || 1)); t.clips.splice(selIndex + 1, 0, { ...c, id: newId('clip'), inSec: Math.max(0, at), outSec: Math.max(at + 0.1, c.outSec), freezeSec: 2, transition: undefined, camera: undefined }); return t; })}><Pause /> Freeze frame</Button>
                    <Button size="sm" variant="secondary" onClick={() => apply((t) => { const c = t.clips[selIndex]!; t.clips.splice(selIndex + 1, 0, { ...c, id: newId('clip'), transition: undefined }); return t; })}><Copy /> Duplicate</Button>
                    <Button size="sm" variant="ghost" onClick={() => apply((t) => moveClip(t, sel.id, -1))} disabled={selIndex === 0}><ArrowLeft /> Earlier</Button>
                    <Button size="sm" variant="ghost" onClick={() => apply((t) => moveClip(t, sel.id, 1))} disabled={selIndex === timeline.clips.length - 1}>Later <ArrowRight /></Button>
                  </div>
                  <Button size="sm" className="w-full" onClick={() => openShot(sel.id)}><Crosshair /> Open in shot editor (AI fix, camera, colour)</Button>
                  {sel.shotId && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={async () => {
                        try {
                          await api(`/api/shots/${sel.shotId}/regenerate`, { body: { idempotencyKey: newKey() } });
                          toast.success('Shot regenerating — replace the clip when it’s ready.');
                        } catch (e) {
                          toast.error(e instanceof ApiError ? e.message : 'Could not regenerate');
                        }
                      }}
                    >
                      Regenerate this shot with AI
                    </Button>
                  )}
                  <Button size="sm" variant="danger" className="w-full" onClick={() => { apply((t) => { t.clips = t.clips.filter((c) => c.id !== sel.id); return t; }); select(null); }}><Trash2 /> Remove clip</Button>
                </>
              ) : (
                <p className="text-sm text-fog-400">Select a clip on the timeline.</p>
              )}
              <div className="space-y-3 border-t hairline pt-4">
                <Field label="Format">
                  <Segmented size="sm" value={timeline.aspectRatio} onChange={(v) => apply((t) => ({ ...t, aspectRatio: v }))} options={(['9:16', '16:9', '1:1', '4:5'] as const).map((v) => ({ value: v, label: v }))} />
                </Field>
                <Field label="Resolution">
                  <Segmented size="sm" value={timeline.resolution} onChange={(v) => apply((t) => ({ ...t, resolution: v }))} options={(['720p', '1080p'] as const).map((v) => ({ value: v, label: v }))} />
                </Field>
                <label className="flex items-center justify-between text-sm text-fog-200">Mute original clip audio <Switch checked={timeline.muteClipAudio} onCheckedChange={(v) => apply((t) => ({ ...t, muteClipAudio: v }))} label="Mute clip audio" /></label>
                <div className="flex items-center justify-between gap-2 text-sm text-fog-200">
                  <span>Brand logo</span>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="ghost" onClick={async () => { const a = await logoUp.pick(); if (a) { apply((t) => ({ ...t, logo: { assetId: a.id, position: 'top-right', scale: 0.12, opacity: 0.9 } })); void assetsQ.refetch(); } }}><ImagePlus /> Upload</Button>
                    {timeline.logo && <Button size="sm" variant="ghost" onClick={() => apply((t) => ({ ...t, logo: undefined }))}>Remove</Button>}
                  </div>
                </div>
                {timeline.logo && (
                  <div className="space-y-3 rounded-xl border hairline p-3">
                    <LogoStyle logo={timeline.logo} onChange={(patch) => { void assetsQ.refetch(); apply((t) => ({ ...t, logo: { ...t.logo!, ...patch } })); }} />
                    <p className="text-xs text-fog-400">Drag the logo in the preview to place it anywhere (arrow keys nudge, Shift for bigger steps).</p>
                    <div className="flex flex-wrap gap-1.5">
                      {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((p) => (
                        <Button key={p} size="sm" variant={timeline.logo!.x === undefined && timeline.logo!.position === p ? 'secondary' : 'ghost'} onClick={() => apply((t) => ({ ...t, logo: { ...t.logo!, position: p, x: undefined, y: undefined } }))}>
                          {p.replace('-', ' ')}
                        </Button>
                      ))}
                    </div>
                    <Field label={`Size · ${Math.round(timeline.logo.scale * 100)}% of width`}>
                      <input type="range" className="w-full" min={0.03} max={0.5} step={0.01} value={timeline.logo.scale} onChange={(e) => apply((t) => ({ ...t, logo: { ...t.logo!, scale: Number(e.target.value) } }))} />
                    </Field>
                    <Field label={`Opacity · ${Math.round(timeline.logo.opacity * 100)}%`}>
                      <input type="range" className="w-full" min={0.1} max={1} step={0.05} value={timeline.logo.opacity} onChange={(e) => apply((t) => ({ ...t, logo: { ...t.logo!, opacity: Number(e.target.value) } }))} />
                    </Field>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="audio" className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="secondary" onClick={async () => { const a = await audioUp.pick(); if (a) { pickLibrary(a); void assetsQ.refetch(); } }}><Music /> Upload music</Button>
                <Button size="sm" variant="secondary" onClick={() => setLibraryFor({ kind: 'audio' })}><AudioLines /> From library</Button>
                <Button size="sm" variant="outline" className="col-span-2" onClick={() => setTtsOpen(true)}><Mic /> Generate voice-over</Button>
              </div>
              {timeline.audio.map((a, i) => (
                <Card key={a.id} className="space-y-2 p-3">
                  <div className="flex items-center justify-between">
                    <NativeSelect className="h-8 w-28 text-xs" value={a.kind} onChange={(e) => apply((t) => { t.audio[i]!.kind = e.target.value as 'music'; return t; })}>
                      <option value="music">music</option>
                      <option value="voice">voice</option>
                      <option value="sfx">sfx</option>
                    </NativeSelect>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant={a.muted ? 'secondary' : 'ghost'} aria-pressed={a.muted} onClick={() => apply((t) => { t.audio[i]!.muted = !t.audio[i]!.muted; return t; })}>{a.muted ? 'Muted' : 'Mute'}</Button>
                      <Button size="sm" variant="ghost" title="Solo: mute every other track" onClick={() => apply((t) => { const solo = t.audio.every((x, j) => j === i || x.muted) && !t.audio[i]!.muted; t.audio.forEach((x, j) => (x.muted = solo ? false : j !== i)); return t; })}>Solo</Button>
                      <Button size="icon" variant="ghost" aria-label="Remove audio" onClick={() => apply((t) => { t.audio.splice(i, 1); return t; })}><Trash2 /></Button>
                    </div>
                  </div>
                  <Field label={`Starts at ${seconds(a.startSec)}`}>
                    <input type="range" className="w-full" min={0} max={Math.max(total, 1)} step={0.1} value={a.startSec} onChange={(e) => apply((t) => { t.audio[i]!.startSec = Number(e.target.value); return t; })} />
                  </Field>
                  <Field label={`Volume ${Math.round(a.volume * 100)}%`}>
                    <input type="range" className="w-full" min={0} max={2} step={0.05} value={a.volume} onChange={(e) => apply((t) => { t.audio[i]!.volume = Number(e.target.value); return t; })} />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Fade in (s)"><Input type="number" min={0} max={10} step={0.5} value={a.fadeInSec} onChange={(e) => apply((t) => { t.audio[i]!.fadeInSec = Number(e.target.value); return t; })} /></Field>
                    <Field label="Fade out (s)"><Input type="number" min={0} max={10} step={0.5} value={a.fadeOutSec} onChange={(e) => apply((t) => { t.audio[i]!.fadeOutSec = Number(e.target.value); return t; })} /></Field>
                  </div>
                </Card>
              ))}
              {!timeline.audio.length && <p className="text-sm text-fog-400">Add music or a voice-over. When a clip already has native AI audio, you don’t need to pay for a second voice track.</p>}
            </TabsContent>

            <TabsContent value="text" className="space-y-3">
              <Button size="sm" variant="secondary" onClick={() => apply((t) => { t.texts.push({ id: newId('txt'), text: 'Your headline', startSec: Math.round(playhead * 10) / 10, endSec: Math.round((playhead + 2.5) * 10) / 10, position: 'top', fontSize: 64, color: '#FFFFFF', background: true }); return t; })}>
                <Plus /> Add text at playhead
              </Button>
              {timeline.texts.map((x, i) => (
                <Card key={x.id} className="space-y-2 p-3">
                  <Input value={x.text} maxLength={300} onChange={(e) => apply((t) => { t.texts[i]!.text = e.target.value || ' '; return t; })} />
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Start (s)"><Input type="number" step={0.1} min={0} value={x.startSec} onChange={(e) => apply((t) => { t.texts[i]!.startSec = Number(e.target.value); return t; })} /></Field>
                    <Field label="End (s)"><Input type="number" step={0.1} min={0.1} value={x.endSec} onChange={(e) => apply((t) => { t.texts[i]!.endSec = Number(e.target.value); return t; })} /></Field>
                  </div>
                  <div className="flex items-center gap-2">
                    <Segmented size="sm" value={x.position} onChange={(v) => apply((t) => { t.texts[i]!.position = v; return t; })} options={[{ value: 'top', label: 'Top' }, { value: 'center', label: 'Mid' }, { value: 'bottom', label: 'Low' }]} />
                    <input type="color" aria-label="Text color" value={x.color} onChange={(e) => apply((t) => { t.texts[i]!.color = e.target.value.toUpperCase(); return t; })} className="h-8 w-10 rounded border-0 bg-transparent" />
                    <Button size="icon" variant="ghost" aria-label="Delete text" onClick={() => apply((t) => { t.texts.splice(i, 1); return t; })}><Trash2 /></Button>
                  </div>
                </Card>
              ))}
            </TabsContent>

            <TabsContent value="subs" className="space-y-3">
              <label className="flex items-center justify-between text-sm text-fog-200">Burn subtitles into video <Switch checked={timeline.burnSubtitles} onCheckedChange={(v) => apply((t) => ({ ...t, burnSubtitles: v }))} label="Burn subtitles" /></label>
              <TranscribeButton projectId={id} timeline={timeline} assets={assets} onCues={(cues) => apply((t) => ({ ...t, subtitles: cues.map((c) => ({ ...c, id: newId('sub') })) }))} />
              <Button size="sm" variant="secondary" onClick={() => apply((t) => { t.subtitles.push({ id: newId('sub'), startSec: Math.round(playhead * 10) / 10, endSec: Math.round((playhead + 2) * 10) / 10, text: 'Subtitle' }); t.subtitles.sort((a, b) => a.startSec - b.startSec); return t; })}>
                <Plus /> Add cue at playhead
              </Button>
              <div className="max-h-80 space-y-2 overflow-y-auto">
                {timeline.subtitles.map((s, i) => (
                  <div key={s.id} className="grid grid-cols-[64px_64px_1fr_32px] gap-1.5">
                    <Input className="h-9 px-2 text-xs" type="number" step={0.1} aria-label="Start" value={s.startSec} onChange={(e) => apply((t) => { t.subtitles[i]!.startSec = Number(e.target.value); return t; })} />
                    <Input className="h-9 px-2 text-xs" type="number" step={0.1} aria-label="End" value={s.endSec} onChange={(e) => apply((t) => { t.subtitles[i]!.endSec = Number(e.target.value); return t; })} />
                    <Input className="h-9 px-2 text-xs" aria-label="Text" value={s.text} onChange={(e) => apply((t) => { t.subtitles[i]!.text = e.target.value || ' '; return t; })} />
                    <Button size="icon" variant="ghost" aria-label="Delete cue" onClick={() => apply((t) => { t.subtitles.splice(i, 1); return t; })}><Trash2 /></Button>
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="layers">
              <LayersPanel timeline={timeline} apply={apply} playhead={playhead} selectedId={selectedLayer} setSelectedId={setSelectedLayer} logoAssetId={timeline.logo?.assetId} onPickAsset={(kind, cb) => { layerPick.current = { kind, cb }; setLibraryFor({ kind: kind === 'image' ? 'layer-image' : 'layer-video' }); }} />
            </TabsContent>

            <TabsContent value="overlay" className="space-y-3">
              <p className="text-xs text-fog-400">Images or videos above the main picture (track V2): picture-in-picture, stickers, product shots.</p>
              <Button size="sm" variant="secondary" onClick={() => setLibraryFor({ kind: 'overlay' })}><Plus /> Add overlay at playhead</Button>
              {timeline.overlays.map((o, i) => (
                <Card key={o.id} className="space-y-2 p-3">
                  <div className="flex items-center justify-between text-xs text-fog-200">
                    <span className="truncate">{assets.get(o.assetId)?.originalName ?? 'Overlay'} · {seconds(o.startSec)}–{seconds(o.endSec)}</span>
                    <Button size="icon" variant="ghost" aria-label="Remove overlay" onClick={() => apply((t) => { t.overlays.splice(i, 1); return t; })}><Trash2 /></Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Start (s)"><Input type="number" step={0.1} min={0} value={o.startSec} onChange={(e) => apply((t) => { t.overlays[i]!.startSec = Number(e.target.value); return t; })} /></Field>
                    <Field label="End (s)"><Input type="number" step={0.1} min={0.1} value={o.endSec} onChange={(e) => apply((t) => { t.overlays[i]!.endSec = Number(e.target.value); return t; })} /></Field>
                  </div>
                  {(['x', 'y', 'w', 'opacity'] as const).map((k) => (
                    <Field key={k} label={`${{ x: 'Left', y: 'Top', w: 'Width', opacity: 'Opacity' }[k]} · ${Math.round(o[k] * 100)}%`}>
                      <input type="range" className="w-full" min={k === 'w' ? 0.05 : k === 'opacity' ? 0.05 : 0} max={1} step={0.01} value={o[k]} onChange={(e) => apply((t) => { t.overlays[i]![k] = Number(e.target.value); return t; })} />
                    </Field>
                  ))}
                </Card>
              ))}
            </TabsContent>

            <TabsContent value="export">
              <ExportPanel projectId={id} timeline={timeline} />
            </TabsContent>
          </Tabs>
        </Card>
        {/* Bottom: the multi-track timeline across the full width */}
        <Card className="order-4 p-3 md:p-4 lg:col-span-2 xl:order-none xl:col-span-3">{timelineCard}</Card>
      </div>

      )}

      <Dialog open={helpOpen} onOpenChange={setHelpOpen} title="Keyboard shortcuts">
        <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          {[
            ['Space', 'Play / pause'],
            ['S', 'Split the selected clip at the playhead'],
            ['Delete', 'Remove the selected clip'],
            ['Ctrl + D', 'Duplicate the selected clip'],
            ['← / →', 'Step one frame (Shift: one second)'],
            ['Home / End', 'Go to the start / end'],
            ['Ctrl + Z / Ctrl + Shift + Z', 'Undo / redo'],
            ['Ctrl + S', 'Save a version'],
            ['?', 'This list'],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <kbd className="rounded-md border hairline bg-white/[0.04] px-2 py-0.5 text-xs text-fog-100">{k}</kbd>
              <span className="text-fog-300">{v}</span>
            </div>
          ))}
        </div>
      </Dialog>

      <Dialog open={Boolean(libraryFor)} onOpenChange={(o) => !o && setLibraryFor(null)} title={libraryFor?.kind === 'audio' ? 'Choose audio' : libraryFor?.kind === 'logo' ? 'Choose logo' : 'Choose a clip'} wide>
        <div className="grid grid-cols-3 gap-2 md:grid-cols-4">
          {(assetsQ.data?.assets ?? [])
            .filter((a) => (libraryFor?.kind === 'audio' ? a.mediaType === 'audio' : libraryFor?.kind === 'logo' ? a.mediaType === 'image' : libraryFor?.kind === 'overlay' ? a.mediaType === 'image' || a.mediaType === 'video' : libraryFor?.kind === 'layer-image' ? a.mediaType === 'image' : a.mediaType === 'video'))
            .map((a) => (
              <button key={a.id} type="button" onClick={() => pickLibrary(a)} className="surface overflow-hidden rounded-xl text-left hover:border-iris-500/50">
                <div className="aspect-video bg-ink-800">
                  {a.thumbnailUrl || a.mediaType === 'image' ? <img src={a.thumbnailUrl ?? a.url} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-fog-400"><AudioLines className="size-5" /></div>}
                </div>
                <div className="truncate px-2 py-1.5 text-[11px] text-fog-300">{a.originalName ?? `${a.kind} · ${seconds((a.durationMs ?? 0) / 1000)}`}{a.isFixture ? ' · fixture' : ''}</div>
              </button>
            ))}
        </div>
        {libraryFor?.kind !== 'audio' && !videos.length && <p className="text-sm text-fog-400">No videos yet.</p>}
      </Dialog>

      <TtsDialog open={ttsOpen} onOpenChange={setTtsOpen} projectId={id} onDone={(assetId, durationSec) => { void assetsQ.refetch(); apply((t) => { t.audio.push({ id: newId('aud'), assetId, kind: 'voice', startSec: Math.round(playhead * 10) / 10, inSec: 0, outSec: durationSec, volume: 1, fadeInSec: 0, fadeOutSec: 0, muted: false, duck: false, denoise: false }); return t; }); void qc.invalidateQueries({ queryKey: ['me'] }); }} />
      <VersionsDialog open={versionsOpen} onOpenChange={setVersionsOpen} projectId={id} onRestored={() => tq.refetch()} />
    </div>
  );
}

// ------------------------------------------------------------------ voice-over, transcription, versions

function TtsDialog({ open, onOpenChange, projectId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string; onDone: (assetId: string, durationSec: number) => void }) {
  const [text, setText] = useState('');
  const [language, setLanguage] = useState('en');
  const [voiceId, setVoice] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<{ credits: number; available: boolean } | null>(null);
  const voices = useQuery({ queryKey: ['voices'], queryFn: () => api<{ voices: { id: string; name: string }[]; configured: boolean }>('/api/audio/voices'), enabled: open });
  const { data } = useJob(jobId);
  const job = data?.job;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (job?.status === 'completed' && job.outputAssetId && handled.current !== job.id) {
      handled.current = job.id;
      void api<{ asset: Asset }>(`/api/assets/${job.outputAssetId}`).then((r) => {
        onDone(r.asset.id, (r.asset.durationMs ?? 3000) / 1000);
        setJobId(null);
        onOpenChange(false);
        toast.success('Voice-over added to the timeline');
      });
    }
  }, [job?.id, job?.status, job?.outputAssetId, onDone, onOpenChange]);
  const check = async () => setEstimate((await api<{ estimate: { credits: number; available: boolean } }>('/api/audio/estimate', { body: { kind: 'tts', text, language } })).estimate);
  const go = async () => {
    try {
      const r = await api<{ job: { id: string }; reused: boolean }>('/api/audio', { body: { kind: 'tts', text, language, voiceId: voiceId || undefined, projectId, idempotencyKey: newKey() } });
      if (r.reused) toast.message('Reused an identical narration you already generated — no charge.');
      setJobId(r.job.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not generate voice');
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Generate voice-over" description="ElevenLabs text-to-speech in English, Georgian or Russian." footer={<><Button variant="ghost" onClick={check} disabled={!text.trim()}>Estimate</Button><Button onClick={go} disabled={!text.trim() || Boolean(jobId) || voices.data?.configured === false} loading={Boolean(jobId)}>Generate</Button></>}>
      <div className="space-y-3">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} placeholder="Write the narration…" />
        <div className="grid grid-cols-2 gap-2">
          <NativeSelect value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</NativeSelect>
          <NativeSelect value={voiceId} onChange={(e) => setVoice(e.target.value)}>
            <option value="">Default voice</option>
            {voices.data?.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </NativeSelect>
        </div>
        {estimate && <p className="text-sm text-fog-300">≈ {estimate.credits} credits{estimate.available ? '' : ' — audio provider not configured'}</p>}
        {voices.data?.configured === false && <p className="text-sm text-signal-amber">Voice generation needs an ElevenLabs API key on the server. You can upload your own voice recording instead.</p>}
        {job && <p className="text-sm text-fog-300">{job.phase}</p>}
        <p className="text-xs text-fog-400">Voice cloning of real people requires their documented consent and is not offered by default.</p>
      </div>
    </Dialog>
  );
}

function TranscribeButton({ projectId, timeline, assets, onCues }: { projectId: string; timeline: Timeline; assets: Map<string, Asset>; onCues: (c: { startSec: number; endSec: number; text: string }[]) => void }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['transcript', jobId],
    queryFn: () => api<{ status: string; transcript: { cues: { startSec: number; endSec: number; text: string }[] } | null }>(`/api/audio/${jobId}/transcript`),
    enabled: Boolean(jobId),
    refetchInterval: (qq) => (qq.state.data?.status === 'completed' || qq.state.data?.status === 'failed' ? false : 3000),
  });
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (q.data?.status === 'completed' && q.data.transcript && handled.current !== jobId) {
      handled.current = jobId;
      onCues(q.data.transcript.cues);
      setJobId(null);
      toast.success('Subtitles created from speech');
    }
  }, [q.data, onCues, jobId]);
  const source = timeline.audio.find((a) => a.kind === 'voice')?.assetId ?? timeline.clips.find((c) => assets.get(c.assetId)?.source?.aiGenerated)?.assetId ?? timeline.clips[0]?.assetId;
  return (
    <Button
      size="sm"
      variant="outline"
      className="w-full"
      disabled={!source || Boolean(jobId)}
      loading={Boolean(jobId)}
      onClick={async () => {
        try {
          const r = await api<{ job: { id: string } }>('/api/audio', { body: { kind: 'transcribe', assetId: source, projectId, idempotencyKey: newKey() } });
          setJobId(r.job.id);
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : 'Transcription unavailable');
        }
      }}
    >
      <Captions /> Auto-subtitles from speech
    </Button>
  );
}

function VersionsDialog({ open, onOpenChange, projectId, onRestored }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string; onRestored: () => void }) {
  const { data, refetch } = useQuery({ queryKey: ['versions', projectId], queryFn: () => api<{ versions: { version: number; label: string | null; createdAt: string }[] }>(`/api/projects/${projectId}/versions`), enabled: open });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Version history">
      <div className="space-y-1">
        {data?.versions.map((v) => (
          <div key={v.version} className="flex items-center justify-between rounded-xl px-3 py-2 hover:bg-white/5">
            <div>
              <div className="text-sm text-white">v{v.version} {v.label && <span className="text-fog-400">· {v.label}</span>}</div>
              <div className="text-xs text-fog-400">{new Date(v.createdAt).toLocaleString()}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={async () => { await api(`/api/projects/${projectId}/versions/${v.version}/restore`, { body: {} }); toast.success(`Restored v${v.version}`); void refetch(); onRestored(); onOpenChange(false); }}>Restore</Button>
          </div>
        ))}
        {!data?.versions.length && <p className="py-4 text-center text-sm text-fog-400">No saved versions yet.</p>}
      </div>
    </Dialog>
  );
}
