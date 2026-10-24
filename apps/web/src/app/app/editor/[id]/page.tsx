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
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { LANGUAGES, timelineDuration, type Timeline } from '@framecraft/shared';
import { api, ApiError, endpoints, type Asset, type Project } from '@/lib/api';
import { useJob } from '@/lib/hooks';
import { clipStarts, moveClip, newId, splitClip, useEditor } from '@/lib/editor-store';
import { Badge, Button, Card, Dialog, Field, Input, NativeSelect, Segmented, Skeleton, Spinner, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, buttonVariants } from '@/components/ui';
import { useUploader } from '@/components/studio/upload';
import { ProgressBar } from '@/components/studio/progress';
import { MultiTrack } from '@/components/editor/multitrack';
import { cn, newKey, seconds } from '@/lib/utils';

const TRANSITIONS = ['cut', 'fade', 'dissolve', 'fadeblack', 'wipeleft', 'wiperight', 'slideup', 'circleopen'] as const;
const POS_CLASS = { top: 'top-[10%]', center: 'top-1/2 -translate-y-1/2', bottom: 'bottom-[22%]' } as const;

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

function Preview({ timeline, assets, playhead, setPlayhead, onLogoMove }: { timeline: Timeline; assets: Map<string, Asset>; playhead: number; setPlayhead: (t: number) => void; onLogoMove: (pos: { x: number; y: number }) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const starts = useMemo(() => clipStarts(timeline), [timeline]);
  const total = timelineDuration(timeline);
  const index = Math.max(0, starts.findLastIndex((s) => s <= playhead + 0.001));
  const clip = timeline.clips[index];
  const asset = clip ? assets.get(clip.assetId) : undefined;
  const localTime = clip ? clip.inSec + (playhead - (starts[index] ?? 0)) : 0;

  // Keep the <video> element in sync with the playhead (seek when paused or when switching clips).
  useEffect(() => {
    const v = video.current;
    if (!v || !asset) return;
    if (Math.abs(v.currentTime - localTime) > 0.35) v.currentTime = Math.max(0, localTime);
  }, [asset, localTime]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (playing) void v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [playing, asset?.id]);

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
    if (!v || !clip || !playing) return;
    if (v.currentTime >= clip.outSec - 0.04) {
      const next = (starts[index + 1] ?? total) + 0.001;
      if (index + 1 >= timeline.clips.length) {
        setPlaying(false);
        setPlayhead(0);
      } else setPlayhead(next);
      return;
    }
    setPlayhead((starts[index] ?? 0) + (v.currentTime - clip.inSec));
  };

  const [w, h] = timeline.aspectRatio.split(':').map(Number);
  const texts = timeline.texts.filter((t) => playhead >= t.startSec && playhead <= t.endSec);
  const subs = timeline.burnSubtitles ? timeline.subtitles.filter((s) => playhead >= s.startSec && playhead <= s.endSec) : [];
  const logo = timeline.logo ? assets.get(timeline.logo.assetId) : undefined;

  return (
    <div className="space-y-3">
      <div className="relative mx-auto max-h-[56dvh] overflow-hidden rounded-2xl border hairline bg-black" style={{ aspectRatio: `${w}/${h}` }}>
        {asset ? (
          <video ref={video} src={asset.url} playsInline muted={timeline.muteClipAudio || clipVolume === 0} onTimeUpdate={onTime} className="size-full object-cover" preload="auto" />
        ) : (
          <div className="grid size-full place-items-center text-sm text-fog-400">Add clips to start</div>
        )}
        {texts.map((t) => (
          <div key={t.id} className={cn('pointer-events-none absolute inset-x-4 text-center font-semibold', POS_CLASS[t.position])} style={{ color: t.color, fontSize: `clamp(12px, ${t.fontSize / 18}vw, ${t.fontSize / 2.2}px)` }}>
            <span className={cn(t.background && 'rounded-md bg-black/50 px-2 py-0.5')}>{t.text}</span>
          </div>
        ))}
        {subs.map((s) => (
          <div key={s.id} className="pointer-events-none absolute inset-x-4 bottom-[14%] text-center text-sm font-semibold text-white [text-shadow:0_0_4px_#000,0_0_2px_#000] md:text-base">{s.text}</div>
        ))}
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
      </div>
      <p className="text-[11px] text-fog-400">Preview plays clips, voice-over and music in sequence with text and subtitles. Transitions and the final audio mix are rendered exactly in the exported MP4 — export to get one file with everything.</p>
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
  const [saving, setSaving] = useState(false);
  const [libraryFor, setLibraryFor] = useState<null | { kind: 'clip' | 'replace' | 'audio' | 'logo' }>(null);
  const [ttsOpen, setTtsOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

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

  // Keyboard shortcuts: Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z, Ctrl/Cmd+S.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
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
        t.audio.push({ id: newId('aud'), assetId: a.id, kind: 'music', startSec: 0, inSec: 0, outSec: Math.max(1, (a.durationMs ?? total * 1000) / 1000), volume: 0.6, fadeInSec: 0, fadeOutSec: 1, muted: false });
        return t;
      });
    else if (kind === 'logo')
      apply((t) => {
        t.logo = { assetId: a.id, position: 'top-right', scale: 0.12, opacity: 0.9 };
        return t;
      });
  };

  return (
    <div className="mx-auto max-w-7xl">
      {audioUp.element}
      {videoUp.element}
      {logoUp.element}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href={tq.data!.project.kind === 'movie' ? `/app/movie/${id}` : `/app/projects/${id}`} className="text-xs text-fog-400 hover:text-white">
            ← {tq.data!.project.title}
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-white">Editor</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="mr-2 text-xs text-fog-400">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
          <Button size="icon" variant="ghost" aria-label="Undo" onClick={undo} disabled={!past.length}><Undo2 /></Button>
          <Button size="icon" variant="ghost" aria-label="Redo" onClick={redo} disabled={!future.length}><Redo2 /></Button>
          <Button size="icon" variant="ghost" aria-label="Versions" onClick={() => setVersionsOpen(true)}><History /></Button>
          <Button size="sm" variant="secondary" onClick={() => save(false, 'Manual save')}><Save /> Save version</Button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          <Card className="p-3 md:p-4">
            <Preview timeline={timeline} assets={assets} playhead={playhead} setPlayhead={setPlayhead} onLogoMove={(pos) => apply((t) => ({ ...t, logo: t.logo ? { ...t.logo, ...pos } : t.logo }))} />
          </Card>

          {/* Timeline strip */}
          <Card className="p-3 md:p-4">
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
          </Card>
        </div>

        {/* Inspector */}
        <Card className="p-3 md:p-4">
          <Tabs defaultValue="clip">
            <TabsList className="mb-4">
              <TabsTrigger value="clip"><Scissors className="mr-1 inline size-3.5" />Clip</TabsTrigger>
              <TabsTrigger value="audio"><AudioLines className="mr-1 inline size-3.5" />Audio</TabsTrigger>
              <TabsTrigger value="text"><Type className="mr-1 inline size-3.5" />Text</TabsTrigger>
              <TabsTrigger value="subs"><Captions className="mr-1 inline size-3.5" />Subs</TabsTrigger>
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
                  <Field label={`Clip volume · ${Math.round(sel.volume * 100)}%`}>
                    <input type="range" className="w-full" min={0} max={2} step={0.05} value={sel.volume} onChange={(e) => apply((t) => { t.clips[selIndex]!.volume = Number(e.target.value); return t; })} />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Button size="sm" variant="secondary" onClick={() => apply((t) => splitClip(t, sel.id, sel.inSec + (playhead - (starts[selIndex] ?? 0))))}><Scissors /> Split at playhead</Button>
                    <Button size="sm" variant="secondary" onClick={() => setLibraryFor({ kind: 'replace' })}><RotateCcw /> Replace</Button>
                    <Button size="sm" variant="ghost" onClick={() => apply((t) => moveClip(t, sel.id, -1))} disabled={selIndex === 0}><ArrowLeft /> Earlier</Button>
                    <Button size="sm" variant="ghost" onClick={() => apply((t) => moveClip(t, sel.id, 1))} disabled={selIndex === timeline.clips.length - 1}>Later <ArrowRight /></Button>
                  </div>
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
                    <Button size="icon" variant="ghost" aria-label="Remove audio" onClick={() => apply((t) => { t.audio.splice(i, 1); return t; })}><Trash2 /></Button>
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

            <TabsContent value="export">
              <ExportPanel projectId={id} timeline={timeline} />
            </TabsContent>
          </Tabs>
        </Card>
      </div>

      <Dialog open={Boolean(libraryFor)} onOpenChange={(o) => !o && setLibraryFor(null)} title={libraryFor?.kind === 'audio' ? 'Choose audio' : libraryFor?.kind === 'logo' ? 'Choose logo' : 'Choose a clip'} wide>
        <div className="grid grid-cols-3 gap-2 md:grid-cols-4">
          {(assetsQ.data?.assets ?? [])
            .filter((a) => (libraryFor?.kind === 'audio' ? a.mediaType === 'audio' : libraryFor?.kind === 'logo' ? a.mediaType === 'image' : a.mediaType === 'video'))
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

      <TtsDialog open={ttsOpen} onOpenChange={setTtsOpen} projectId={id} onDone={(assetId, durationSec) => { void assetsQ.refetch(); apply((t) => { t.audio.push({ id: newId('aud'), assetId, kind: 'voice', startSec: Math.round(playhead * 10) / 10, inSec: 0, outSec: durationSec, volume: 1, fadeInSec: 0, fadeOutSec: 0, muted: false }); return t; }); void qc.invalidateQueries({ queryKey: ['me'] }); }} />
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
