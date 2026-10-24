'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Brush, Camera, Check, ChevronLeft, ChevronRight, Circle, Eraser, GitBranch, Image as ImageIcon, Lasso, MapPin, MessageSquare, MousePointer2, Palette, Pause, Play, Send, Sparkles, Square, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { AI_EDIT_MODES, clipDuration, maskIsEmpty, type AiEditMode, type ClipCamera, type EditMask, type Timeline } from '@framecraft/shared';
import { api, ApiError, type Asset } from '@/lib/api';
import { useJob } from '@/lib/hooks';
import { activeVersion, COMMENT_STATUS_LABEL, type EditEstimate, type EditOperation, type ShotComment, type StudioShot } from '@/lib/studio';
import { Badge, Button, Dialog, Field, Segmented, Spinner, Textarea } from '@/components/ui';
import { ProgressBar } from '@/components/studio/progress';
import { useUploader } from '@/components/studio/upload';
import { cn, newKey, seconds } from '@/lib/utils';
import { EMPTY_MASK, MaskCanvas, type MaskTool } from './mask-canvas';
import { CameraFrame, CameraPanel, ColorPanel } from './shot-tools';
import { cameraStyle, GradeFilter, Vignette } from './look';
import { Copilot } from './copilot';

type Tab = 'ai' | 'comments' | 'camera' | 'color' | 'versions';
type Guide = { assetId: string; url: string; atSec: number };
type Range = { start: number; end: number };

/**
 * Edit one shot without touching the others: AI fixes on a time range and area, review comments,
 * the 2D camera, colour, and the shot's versions with compare / accept.
 */
export function ShotEditor({ projectId, clipId, timeline, apply, shot, assets, onClose, initialCompare }: { projectId: string; clipId: string; timeline: Timeline; apply: (fn: (t: Timeline) => Timeline) => void; shot: StudioShot | undefined; assets: Map<string, Asset>; onClose: () => void; initialCompare?: string | null }) {
  const qc = useQueryClient();
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ['studio', projectId] }), [qc, projectId]);
  const clip = timeline.clips.find((c) => c.id === clipId);
  const shotClips = clip?.shotId ? timeline.clips.filter((c) => c.shotId === clip.shotId) : clip ? [clip] : [];
  const active = shot ? activeVersion(shot) : null;
  const [viewId, setViewId] = useState<string | null>(null);
  const viewing = shot?.versions.find((v) => v.id === viewId) ?? active;
  const url = viewing?.media?.url ?? (clip ? assets.get(clip.assetId)?.url : undefined);
  const duration = viewing?.media?.durationSec ?? (clip ? (assets.get(clip.assetId)?.durationMs ?? 5000) / 1000 : 5);
  const fps = timeline.fps || 30;

  const [tab, setTab] = useState<Tab>(shot ? 'ai' : 'camera');
  const video = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [range, setRange] = useState<Range | null>(null);
  const [mask, setMask] = useState<EditMask>(EMPTY_MASK);
  const [tool, setTool] = useState<MaskTool>('none');
  const [brush, setBrush] = useState(0.03);
  const [subtract, setSubtract] = useState(false);
  const [pin, setPin] = useState<{ x: number; y: number } | null>(null);
  const [liveCam, setLiveCam] = useState<{ x: number; y: number; scale: number; rotation: number } | null>(null);
  const [previewLook, setPreviewLook] = useState(true);
  const [compare, setCompare] = useState<{ a: string; b: string; op?: EditOperation } | null>(null);
  // AI form
  const [mode, setMode] = useState<AiEditMode>('fix');
  const [instruction, setInstruction] = useState('');
  const [commentId, setCommentId] = useState<string | null>(null);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [frameDialog, setFrameDialog] = useState(false);

  useEffect(() => {
    if (!initialCompare || !shot || !active) return;
    if (initialCompare !== active.id) setCompare({ a: active.id, b: initialCompare });
  }, [initialCompare, shot, active]);

  // Clip time for camera/colour (the clip may be trimmed or sped up).
  const clipT = clip ? Math.max(0, (t - clip.inSec) / (clip.speed || 1)) : t;
  const seek = (v: number) => {
    const x = Math.min(Math.max(0, v), duration);
    setT(x);
    if (video.current) video.current.currentTime = x;
  };
  const step = (n: number) => {
    setPlaying(false);
    seek(Math.round((t + n / fps) * fps) / fps);
  };
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (playing) void v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [playing, url]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -fps : -1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? fps : 1); }
      else if (e.key.toLowerCase() === 'i') setRange((r) => ({ start: t, end: Math.max(t + 0.2, r?.end ?? Math.min(duration, t + 1)) }));
      else if (e.key.toLowerCase() === 'o') setRange((r) => ({ start: Math.min(r?.start ?? Math.max(0, t - 1), t - 0.2), end: t }));
      else if (e.key === 'Escape') { if (compare) setCompare(null); else setTool('none'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const setClipField = (patch: { camera?: ClipCamera | undefined; adjust?: Timeline['clips'][number]['adjust'] }) =>
    apply((tl) => ({ ...tl, clips: tl.clips.map((c) => (shotClips.some((s) => s.id === c.id) ? { ...c, ...patch } : c)) }));

  const sendToAi = (c: ShotComment) => {
    setInstruction(c.text);
    setCommentId(c.id);
    if (c.startSec != null) setRange({ start: c.startSec, end: c.endSec ?? Math.min(duration, c.startSec + 1) });
    if (c.mask) setMask(c.mask);
    setMode('fix');
    setTab('ai');
  };

  const openOps = (shot?.operations ?? []).filter((o) => o.status !== 'accepted' || Date.now() - new Date(o.createdAt).getTime() < 3600_000);
  const pins = (shot?.comments ?? []).filter((c) => c.x != null && c.y != null && c.status !== 'resolved' && (c.startSec == null || (t >= c.startSec - 0.05 && t <= (c.endSec ?? c.startSec) + 0.05))).map((c) => ({ x: c.x!, y: c.y!, label: c.text }));
  if (pin) pins.push({ ...pin, label: 'New comment' });
  const [vw, vh] = timeline.aspectRatio.split(':').map(Number);
  const gradeId = `grade-${clipId}`;
  const [camResult, setCamResult] = useState(false);
  // AI / comments work on the raw version; camera and colour show the look as it will be exported.
  const showLook = tab === 'color' ? previewLook : tab === 'camera' ? camResult : false;

  if (!clip) return null;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}><ChevronLeft /> Back</Button>
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-iris-300">Shot editor{shot ? ` · Shot ${shot.number}` : ''}</div>
              <div className="truncate text-sm text-white">{shot?.description || clip.label || 'Clip'}</div>
            </div>
          </div>
          {shot && shot.versions.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-fog-400">Viewing</span>
              <select value={viewing?.id ?? ''} onChange={(e) => setViewId(e.target.value)} className="h-8 rounded-lg border hairline bg-ink-900 px-2 text-xs text-white">
                {shot.versions.map((v) => <option key={v.id} value={v.id}>V{v.number}{v.id === shot.activeVersionId ? ' (in movie)' : ''} · {v.label || v.source}</option>)}
              </select>
            </div>
          )}
        </div>

        {/* Player */}
        <div className="relative mx-auto max-h-[62dvh] overflow-hidden rounded-2xl border hairline bg-black" style={{ aspectRatio: `${vw}/${vh}` }}>
          <GradeFilter id={gradeId} adjust={clip.adjust} />
          <div className="absolute inset-0 overflow-hidden">
            <div className="size-full" style={showLook ? cameraStyle(liveCam ? { keyframes: [{ t: 0, ...liveCam }], easing: 'linear' } : clip.camera, clipT) : {}}>
              {url ? (
                <video ref={video} src={url} className="size-full object-cover" playsInline muted={false} preload="auto" style={showLook && clip.adjust ? { filter: `url(#${gradeId})` } : undefined} onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onEnded={() => setPlaying(false)} />
              ) : (
                <div className="grid size-full place-items-center text-sm text-fog-400">No media</div>
              )}
            </div>
            {showLook && <Vignette amount={clip.adjust?.vignette} />}
          </div>
          {tab === 'camera' && !camResult && <CameraFrame camera={clip.camera} t={clipT} duration={clipDuration(clip)} live={liveCam} onLive={setLiveCam} />}
          {(tab === 'ai' || tab === 'comments') && <MaskCanvas mask={mask} tool={tool} brush={brush} subtract={subtract} onChange={setMask} onPin={(x, y) => { setPin({ x, y }); setTool('none'); }} pins={pins} />}
          {viewing?.media?.isFixture && <span className="absolute left-2 top-2 rounded-full bg-signal-amber px-2 py-0.5 text-[10px] font-semibold text-black">TEST FIXTURE · NOT AI</span>}
        </div>

        {/* Transport + range */}
        <div className="flex items-center gap-2">
          <Button size="icon" variant="secondary" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((p) => !p)}>{playing ? <Pause /> : <Play />}</Button>
          <Button size="icon" variant="ghost" aria-label="Previous frame" onClick={() => step(-1)}><ChevronLeft /></Button>
          <Button size="icon" variant="ghost" aria-label="Next frame" onClick={() => step(1)}><ChevronRight /></Button>
          <RangeBar duration={duration} t={t} range={range} onSeek={(v) => { setPlaying(false); seek(v); }} onRange={setRange} marks={(shot?.comments ?? []).filter((c) => c.startSec != null && c.author === 'user').map((c) => ({ start: c.startSec!, end: c.endSec ?? c.startSec! }))} />
          <span className="w-28 text-right text-xs tabular-nums text-fog-300">{seconds(t)} · f{Math.round(t * fps)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-fog-300">
          <Button size="sm" variant="ghost" onClick={() => setRange((r) => ({ start: t, end: Math.max(t + 0.2, r?.end ?? Math.min(duration, t + 1)) }))}>Mark in (I)</Button>
          <Button size="sm" variant="ghost" onClick={() => setRange((r) => ({ start: Math.min(r?.start ?? Math.max(0, t - 1), t - 0.2), end: t }))}>Mark out (O)</Button>
          {range ? <span className="rounded-md bg-iris-500/20 px-2 py-1 text-iris-100">Selected {seconds(range.start)}–{seconds(range.end)} <button type="button" aria-label="Clear range" onClick={() => setRange(null)}><X className="inline size-3" /></button></span> : <span className="text-fog-400">Shift-drag on the bar to select seconds</span>}
          {tab !== 'camera' && tab !== 'versions' && (
            <span className="ml-auto flex items-center gap-1">
              {([['none', MousePointer2, 'Pointer'], ['rect', Square, 'Rectangle'], ['ellipse', Circle, 'Ellipse'], ['brush', Brush, 'Brush'], ['lasso', Lasso, 'Lasso'], ['erase', Eraser, 'Erase'], ['pin', MapPin, 'Comment pin']] as const).map(([k, Icon, label]) => (
                <button key={k} type="button" title={label} aria-label={label} aria-pressed={tool === k} onClick={() => setTool(k)} className={cn('grid size-7 place-items-center rounded-md', tool === k ? 'bg-iris-500 text-white' : 'text-fog-300 hover:bg-white/[0.06]')}><Icon className="size-3.5" /></button>
              ))}
              {tool === 'brush' || tool === 'erase' ? <input type="range" aria-label="Brush size" min={0.005} max={0.12} step={0.005} value={brush} onChange={(e) => setBrush(Number(e.target.value))} className="w-20" /> : null}
              <label className="ml-1 flex items-center gap-1"><input type="checkbox" checked={subtract} onChange={(e) => setSubtract(e.target.checked)} /> subtract</label>
              <button type="button" className="rounded-md px-1.5 py-1 hover:bg-white/[0.06]" onClick={() => setMask((m) => ({ ...m, invert: !m.invert }))}>{mask.invert ? 'Inverted' : 'Invert'}</button>
              {!maskIsEmpty(mask) && <button type="button" className="rounded-md px-1.5 py-1 text-signal-red hover:bg-white/[0.06]" onClick={() => setMask(EMPTY_MASK)}>Clear</button>}
            </span>
          )}
        </div>
        {(tab === 'ai' || tab === 'comments') && !maskIsEmpty(mask) && (
          <label className="flex items-center gap-2 text-xs text-fog-300">Soft edge <input type="range" min={0} max={0.06} step={0.0025} value={mask.feather} onChange={(e) => setMask((m) => ({ ...m, feather: Number(e.target.value) }))} className="w-40" /></label>
        )}
        {tab === 'color' && <label className="flex items-center gap-2 text-xs text-fog-300"><input type="checkbox" checked={previewLook} onChange={(e) => setPreviewLook(e.target.checked)} /> Show the grade (as exported)</label>}
        {tab === 'camera' && <Segmented size="sm" value={camResult ? 'result' : 'framing'} onChange={(v) => setCamResult(v === 'result')} options={[{ value: 'framing', label: 'Framing (drag the frame)' }, { value: 'result', label: 'Result (as exported)' }]} />}

        {compare && shot && <Compare shot={shot} a={compare.a} b={compare.b} op={compare.op} onClose={() => setCompare(null)} onDone={() => { setCompare(null); refresh(); }} apply={apply} />}
      </div>

      {/* Right panel */}
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap gap-1 rounded-xl border hairline bg-white/[0.02] p-1">
          {([
            ['ai', Sparkles, 'AI edit', Boolean(shot)],
            ['comments', MessageSquare, `Comments${shot?.comments.filter((c) => c.author === 'user' && c.status === 'open').length ? ` · ${shot.comments.filter((c) => c.author === 'user' && c.status === 'open').length}` : ''}`, Boolean(shot)],
            ['camera', Camera, 'Camera', true],
            ['color', Palette, 'Color', true],
            ['versions', GitBranch, `Versions${shot ? ` · ${shot.versions.length}` : ''}`, Boolean(shot)],
          ] as const).filter((x) => x[3]).map(([k, Icon, label]) => (
            <button key={k} type="button" onClick={() => { setTab(k); setTool('none'); }} className={cn('flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs', tab === k ? 'bg-iris-500 text-white' : 'text-fog-300 hover:bg-white/[0.06]')}><Icon className="size-3.5" />{label}</button>
          ))}
        </div>

        {tab === 'ai' && shot && viewing && (
          <AiPanel
            shot={shot}
            versionId={viewing.id}
            duration={duration}
            range={range}
            mask={mask}
            mode={mode}
            setMode={setMode}
            instruction={instruction}
            setInstruction={setInstruction}
            commentId={commentId}
            setCommentId={setCommentId}
            guide={guide}
            setGuide={setGuide}
            onEditFrame={() => setFrameDialog(true)}
            ops={openOps}
            onCompare={(op) => op.resultVersionId && setCompare({ a: op.sourceVersionId, b: op.resultVersionId, op })}
            refresh={refresh}
          />
        )}
        {tab === 'comments' && shot && <Comments shot={shot} t={t} range={range} mask={mask} pin={pin} clearPin={() => setPin(null)} onSendToAi={sendToAi} refresh={refresh} versionId={viewing?.id} />}
        {tab === 'camera' && (
          <CameraPanel
            camera={clip.camera}
            t={clipT}
            duration={clipDuration(clip)}
            live={liveCam}
            setLive={setLiveCam}
            onChange={(c) => setClipField({ camera: c })}
            onRemix={() => {
              setMode('camera_remix');
              setInstruction('Low-angle view of the same moment, keeping the same people and setting');
              setTab('ai');
            }}
          />
        )}
        {tab === 'color' && (
          <ColorPanel adjust={clip.adjust} onChange={(a) => setClipField({ adjust: a })} onCopyToAll={() => { apply((tl) => ({ ...tl, clips: tl.clips.map((c) => ({ ...c, adjust: clip.adjust ? { ...clip.adjust } : undefined })) })); toast.success('Colour applied to every clip'); }} />
        )}
        {tab === 'versions' && shot && <Versions shot={shot} onView={(id) => setViewId(id)} onCompare={(b) => active && setCompare({ a: active.id, b })} refresh={refresh} apply={apply} />}

        {shot && (
          <div className="h-[340px] rounded-2xl border hairline bg-white/[0.02] p-3">
            <Copilot projectId={projectId} timeline={timeline} apply={apply} shot={{ id: shot.id, number: shot.number, versionId: viewing?.id }} range={range} mask={maskIsEmpty(mask) ? null : mask} onEditStarted={refresh} />
          </div>
        )}
      </div>

      {frameDialog && viewing && <EditFrameDialog versionId={viewing.id} atSec={t} projectId={projectId} aspect={timeline.aspectRatio} onClose={() => setFrameDialog(false)} onDone={(g) => { setGuide(g); setFrameDialog(false); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ range bar

function RangeBar({ duration, t, range, onSeek, onRange, marks }: { duration: number; t: number; range: Range | null; onSeek: (t: number) => void; onRange: (r: Range | null) => void; marks: Range[] }) {
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'seek' | 'range' | 'start' | 'end'; from: number } | null>(null);
  const at = (x: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((x - r.left) / r.width) * duration));
  };
  const pct = (v: number) => `${(v / Math.max(0.01, duration)) * 100}%`;
  return (
    <div
      ref={bar}
      role="slider"
      aria-label="Shot time"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={t}
      tabIndex={0}
      className="relative h-9 flex-1 cursor-pointer touch-none rounded-lg bg-white/[0.05]"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const v = at(e.clientX);
        drag.current = { mode: e.shiftKey ? 'range' : 'seek', from: v };
        if (e.shiftKey) onRange({ start: v, end: Math.min(duration, v + 0.1) });
        else onSeek(v);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const v = at(e.clientX);
        if (d.mode === 'seek') onSeek(v);
        else if (d.mode === 'range') onRange({ start: Math.min(d.from, v), end: Math.max(d.from, v, Math.min(d.from, v) + 0.1) });
        else if (d.mode === 'start' && range) onRange({ start: Math.min(v, range.end - 0.1), end: range.end });
        else if (d.mode === 'end' && range) onRange({ start: range.start, end: Math.max(v, range.start + 0.1) });
      }}
      onPointerUp={() => (drag.current = null)}
    >
      {marks.map((m, i) => <span key={i} className="absolute bottom-0 h-1 rounded bg-signal-amber/70" style={{ left: pct(m.start), width: `max(3px, ${pct(m.end - m.start)})` }} />)}
      {range && (
        <span className="absolute inset-y-0 rounded-md border border-iris-400 bg-iris-500/25" style={{ left: pct(range.start), width: pct(range.end - range.start) }}>
          {(['start', 'end'] as const).map((side) => (
            <span key={side} className={cn('absolute inset-y-0 w-2 cursor-ew-resize bg-iris-400', side === 'start' ? '-left-1 rounded-l' : '-right-1 rounded-r')} onPointerDown={(e) => { e.stopPropagation(); bar.current!.setPointerCapture(e.pointerId); drag.current = { mode: side, from: 0 }; }} />
          ))}
        </span>
      )}
      <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-white" style={{ left: pct(t) }} />
    </div>
  );
}

// ------------------------------------------------------------------ AI edit panel

function AiPanel(p: {
  shot: StudioShot;
  versionId: string;
  duration: number;
  range: Range | null;
  mask: EditMask;
  mode: AiEditMode;
  setMode: (m: AiEditMode) => void;
  instruction: string;
  setInstruction: (s: string) => void;
  commentId: string | null;
  setCommentId: (s: string | null) => void;
  guide: Guide | null;
  setGuide: (g: Guide | null) => void;
  onEditFrame: () => void;
  ops: EditOperation[];
  onCompare: (op: EditOperation) => void;
  refresh: () => void;
}) {
  const [est, setEst] = useState<EditEstimate | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [aspect, setAspect] = useState<string>('16:9');
  const whole = AI_EDIT_MODES.find((m) => m.key === p.mode)!.scope === 'shot';
  const start = whole ? 0 : (p.range?.start ?? 0);
  const end = whole ? p.duration : (p.range?.end ?? Math.min(p.duration, start + 1));
  const body = useMemo(
    () => ({ shotId: p.shot.id, versionId: p.versionId, mode: p.mode, instruction: p.instruction.trim() || 'edit', startSec: start, endSec: end, mask: maskIsEmpty(p.mask) || whole ? null : p.mask, keyframe: p.guide ? { assetId: p.guide.assetId, atSec: p.guide.atSec } : undefined, referenceAssetIds: [], targetAspectRatio: p.mode === 'reframe' ? aspect : undefined }),
    [p.shot.id, p.versionId, p.mode, p.instruction, start, end, p.mask, whole, p.guide, aspect],
  );
  useEffect(() => {
    const id = setTimeout(() => {
      api<{ estimate: EditEstimate }>('/api/edits/estimate', { body: { ...body, instruction: body.instruction.length >= 3 ? body.instruction : 'edit this' } })
        .then((r) => { setEst(r.estimate); setEstErr(null); })
        .catch((e) => { setEst(null); setEstErr(e instanceof ApiError ? e.message : 'Could not estimate'); });
    }, 400);
    return () => clearTimeout(id);
  }, [body]);
  const go = async () => {
    setBusy(true);
    try {
      await api('/api/edits', { body: { ...body, commentId: p.commentId ?? undefined, idempotencyKey: newKey() } });
      toast.success('AI edit started. Nothing in your movie changes until you accept it.');
      p.setCommentId(null);
      p.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start the edit');
    } finally {
      setBusy(false);
    }
  };
  const canGo = p.instruction.trim().length >= 3 && est && (est.available || est.fixture) && (whole || p.range);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {AI_EDIT_MODES.map((m) => (
          <button key={m.key} type="button" title={m.hint} onClick={() => p.setMode(m.key)} className={cn('rounded-full border px-2.5 py-1 text-[11px]', p.mode === m.key ? 'border-iris-400 bg-iris-500/20 text-white' : 'hairline text-fog-300 hover:border-white/25')}>{m.label}</button>
        ))}
      </div>
      <p className="text-[11px] text-fog-400">{AI_EDIT_MODES.find((m) => m.key === p.mode)!.hint}</p>
      <Textarea value={p.instruction} onChange={(e) => p.setInstruction(e.target.value)} rows={3} maxLength={900} placeholder="e.g. Fix the hand anatomy — keep the face, clothes, camera and background exactly the same" />
      {p.commentId && <div className="text-[11px] text-iris-200">Linked to a comment — its status follows this edit.</div>}
      {p.mode === 'reframe' && (
        <Field label="New aspect ratio">
          <Segmented size="sm" value={aspect} onChange={setAspect} options={['16:9', '9:16', '1:1', '4:3', '21:9'].map((v) => ({ value: v, label: v }))} />
        </Field>
      )}
      {p.mode === 'camera_remix' && <p className="rounded-lg border border-signal-amber/30 bg-signal-amber/5 p-2 text-[11px] text-signal-amber">Generative: the model invents unseen parts of the scene; identity and geometry may change. You compare before using it.</p>}
      <div className="rounded-xl border hairline p-2.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-fog-300">Scope</span>
          <span className="text-white">{whole ? 'Whole shot' : p.range ? `${seconds(p.range.start)}–${seconds(p.range.end)}` : 'Select seconds on the bar'}{!whole && !maskIsEmpty(p.mask) ? ' · selected area' : ''}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-fog-300">Guide frame</span>
          {p.guide ? (
            <span className="flex items-center gap-2"><img src={p.guide.url} alt="" className="h-9 rounded" /><button type="button" className="text-fog-400 hover:text-white" onClick={() => p.setGuide(null)}>remove</button></span>
          ) : (
            <Button size="sm" variant="ghost" onClick={p.onEditFrame}><ImageIcon /> Edit frame → apply to video</Button>
          )}
        </div>
      </div>
      {est && (
        <div className="space-y-1 rounded-xl bg-white/[0.03] p-2.5 text-[11px] text-fog-300">
          <div className="text-xs text-white">{est.fixture && !est.available ? 'Test mode — no AI model is called (development fixture)' : `${est.model} · ${est.seconds} s sent · ≈ ${est.credits} credits`}</div>
          {est.notes.map((n) => <div key={n}>• {n}</div>)}
        </div>
      )}
      {estErr && <p className="text-xs text-signal-amber">{estErr}</p>}
      <Button className="w-full" onClick={go} loading={busy} disabled={!canGo}><Sparkles /> {est?.available ? `Fix with AI · ${est.credits} credits` : 'Run test edit'}</Button>

      {p.ops.length > 0 && (
        <div className="space-y-2 border-t hairline pt-3">
          <div className="text-xs font-medium text-white">Edits of this shot</div>
          {[...p.ops].reverse().map((op) => <OpRow key={op.id} op={op} onCompare={() => p.onCompare(op)} refresh={p.refresh} />)}
        </div>
      )}
    </div>
  );
}

function OpRow({ op, onCompare, refresh }: { op: EditOperation; onCompare: () => void; refresh: () => void }) {
  const running = op.status === 'processing' || op.status === 'queued';
  const { data } = useJob(running ? op.generationJobId : null);
  const job = data?.job;
  useEffect(() => {
    if (job && ['completed', 'failed'].includes(job.status)) refresh();
  }, [job, refresh]);
  const tone = { ready: 'amber', accepted: 'green', failed: 'red', rejected: 'neutral', processing: 'iris', queued: 'iris' } as const;
  return (
    <div className="rounded-xl border hairline p-2.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        <span className="text-fog-100"><b className="capitalize">{op.mode.replaceAll('_', ' ')}</b> · {seconds(op.startSec)}–{seconds(op.endSec)} — {op.instruction}</span>
        <Badge tone={tone[op.status] as never}>{op.status === 'ready' ? 'review' : op.status}</Badge>
      </div>
      {running && job && <div className="mt-2"><ProgressBar compact={false} progress={job.progress} etaSec={job.etaSec} label={job.phase} /></div>}
      {op.status === 'failed' && <p className="mt-1 text-signal-red">{op.error?.message}</p>}
      {(op.status === 'ready' || op.status === 'accepted' || op.status === 'rejected') && <Button size="sm" variant={op.status === 'ready' ? 'secondary' : 'ghost'} className="mt-2" onClick={onCompare}>Compare before / after</Button>}
    </div>
  );
}

// ------------------------------------------------------------------ compare & review

function Compare({ shot, a, b, op, onClose, onDone, apply }: { shot: StudioShot; a: string; b: string; op?: EditOperation; onClose: () => void; onDone: () => void; apply: (fn: (t: Timeline) => Timeline) => void }) {
  const va = shot.versions.find((v) => v.id === a);
  const vb = shot.versions.find((v) => v.id === b);
  const [view, setView] = useState<'side' | 'wipe'>('wipe');
  const [wipe, setWipe] = useState(0.5);
  const [playing, setPlaying] = useState(false);
  const A = useRef<HTMLVideoElement>(null);
  const B = useRef<HTMLVideoElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    for (const v of [A.current, B.current]) {
      if (!v) continue;
      if (playing) void v.play().catch(() => undefined);
      else v.pause();
    }
  }, [playing]);
  const sync = () => {
    if (A.current && B.current && Math.abs(A.current.currentTime - B.current.currentTime) > 0.08) B.current.currentTime = A.current.currentTime;
  };
  const decide = async (accept: boolean) => {
    setBusy(accept ? 'accept' : 'reject');
    try {
      if (op) {
        if (accept) {
          const r = await api<{ shotId: string; versionId: string; assetId: string; durationSec: number; previousDurationSec?: number }>(`/api/edits/${op.id}/accept`, { body: {} });
          const { swapShotVersion } = await import('@framecraft/shared');
          apply((tl) => swapShotVersion(tl, r.shotId, r));
        } else await api(`/api/edits/${op.id}/reject`, { body: {} });
      } else if (accept && vb) {
        const r = await api<{ shotId: string; versionId: string; assetId: string; durationSec: number; previousDurationSec?: number }>(`/api/shot-versions/${vb.id}/activate`, { body: {} });
        const { swapShotVersion } = await import('@framecraft/shared');
        apply((tl) => swapShotVersion(tl, r.shotId, r));
      }
      toast.success(accept ? `V${vb?.number} is now in the movie` : 'Kept the current version');
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not update');
    } finally {
      setBusy(null);
    }
  };
  if (!va?.media || !vb?.media) return null;
  return (
    <div className="space-y-2 rounded-2xl border border-iris-500/40 bg-ink-900 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-white">Compare <b>V{va.number}</b> ↔ <b>V{vb.number}</b>{op ? ` · ${op.instruction}` : ''}</div>
        <div className="flex items-center gap-1.5">
          <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'wipe', label: 'Wipe' }, { value: 'side', label: 'Side by side' }]} />
          <Button size="icon" variant="ghost" aria-label="Close compare" onClick={onClose}><X /></Button>
        </div>
      </div>
      {view === 'side' ? (
        <div className="grid grid-cols-2 gap-2">
          {[[A, va], [B, vb]].map(([ref, v], i) => (
            <figure key={i} className="relative overflow-hidden rounded-xl bg-black">
              <video ref={ref as React.RefObject<HTMLVideoElement>} src={(v as typeof va).media!.url} className="w-full" muted={i === 1} playsInline onTimeUpdate={i === 0 ? sync : undefined} />
              <figcaption className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">{i === 0 ? 'Before' : 'After'} · V{(v as typeof va).number}</figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-xl bg-black">
          <video ref={A} src={va.media.url} className="w-full" playsInline onTimeUpdate={sync} />
          <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 0 0 ${wipe * 100}%)` }}>
            <video ref={B} src={vb.media.url} className="w-full" muted playsInline />
          </div>
          <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white" style={{ left: `${wipe * 100}%` }} />
          <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">Before</span>
          <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">After</span>
          <input type="range" aria-label="Wipe position" min={0} max={1} step={0.005} value={wipe} onChange={(e) => setWipe(Number(e.target.value))} className="absolute inset-x-3 bottom-2" />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => setPlaying((x) => !x)}>{playing ? <Pause /> : <Play />} {playing ? 'Pause' : 'Play both'}</Button>
        <span className="flex-1" />
        {op?.status === 'ready' && <Button size="sm" variant="ghost" loading={busy === 'reject'} onClick={() => decide(false)}>Reject</Button>}
        {vb.id !== shot.activeVersionId && <Button size="sm" loading={busy === 'accept'} onClick={() => decide(true)}><Check /> {op ? 'Accept edit' : `Use V${vb.number}`}</Button>}
      </div>
    </div>
  );
}

function Versions({ shot, onView, onCompare, refresh, apply }: { shot: StudioShot; onView: (id: string) => void; onCompare: (id: string) => void; refresh: () => void; apply: (fn: (t: Timeline) => Timeline) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const use = async (id: string) => {
    try {
      const r = await api<{ shotId: string; versionId: string; assetId: string; durationSec: number; previousDurationSec?: number }>(`/api/shot-versions/${id}/activate`, { body: {} });
      const { swapShotVersion } = await import('@framecraft/shared');
      apply((tl) => swapShotVersion(tl, r.shotId, r));
      toast.success('Version in use — the others are kept');
      refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not switch');
    }
  };
  return (
    <div className="space-y-2">
      {[...shot.versions].reverse().map((v) => {
        const parent = shot.versions.find((x) => x.id === v.parentVersionId);
        const op = shot.operations.find((o) => o.id === v.operationId);
        return (
          <div key={v.id} className={cn('flex gap-2.5 rounded-xl border p-2', v.id === shot.activeVersionId ? 'border-signal-green/50 bg-signal-green/5' : 'hairline')}>
            <button type="button" onClick={() => onView(v.id)} className="relative w-24 shrink-0 overflow-hidden rounded-lg bg-ink-800">
              {v.media?.thumbnailUrl && <img src={v.media.thumbnailUrl} alt="" className="aspect-video w-full object-cover" />}
              <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-semibold text-white">V{v.number}</span>
            </button>
            <div className="min-w-0 flex-1 text-xs">
              {editing === v.id ? (
                <form className="flex gap-1" onSubmit={async (e) => { e.preventDefault(); await api(`/api/shot-versions/${v.id}`, { method: 'PATCH', body: { label } }); setEditing(null); refresh(); }}>
                  <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} className="h-7 min-w-0 flex-1 rounded border hairline bg-ink-900 px-1.5 text-white" autoFocus />
                  <Button size="sm" type="submit">Save</Button>
                </form>
              ) : (
                <button type="button" className="block max-w-full truncate text-left text-white hover:underline" title="Rename" onClick={() => { setEditing(v.id); setLabel(v.label); }}>{v.label || v.source}</button>
              )}
              <div className="mt-0.5 text-fog-400">{v.source === 'ai_edit' ? 'AI edit' : v.source}{parent ? ` of V${parent.number}` : ''} · {new Date(v.createdAt).toLocaleString()}{op?.status === 'rejected' ? ' · rejected' : ''}{v.media?.isFixture ? ' · test fixture' : ''}</div>
              {v.prompt && <div className="mt-0.5 line-clamp-2 text-fog-300" title={v.prompt}>“{v.prompt}”</div>}
              <div className="mt-1.5 flex gap-1.5">
                {v.id === shot.activeVersionId ? <Badge tone="green">In movie</Badge> : <Button size="sm" variant="secondary" onClick={() => use(v.id)}>Use in movie</Button>}
                {v.id !== shot.activeVersionId && <Button size="sm" variant="ghost" onClick={() => onCompare(v.id)}>Compare</Button>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ comments

function Comments({ shot, t, range, mask, pin, clearPin, onSendToAi, refresh, versionId }: { shot: StudioShot; t: number; range: Range | null; mask: EditMask; pin: { x: number; y: number } | null; clearPin: () => void; onSendToAi: (c: ShotComment) => void; refresh: () => void; versionId?: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await api(`/api/shots/${shot.id}/comments`, { body: { text, versionId, startSec: range?.start ?? t, endSec: range?.end ?? t, ...(pin ? { x: pin.x, y: pin.y } : {}), mask: maskIsEmpty(mask) ? null : mask, referenceAssetIds: [] } });
      setText('');
      clearPin();
      refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not add the comment');
    } finally {
      setBusy(false);
    }
  };
  const list = shot.comments.filter((c) => c.author === 'user' && !(c.status === 'resolved' && !c.operationId && c.startSec === null));
  return (
    <div className="space-y-3">
      <div className="rounded-xl border hairline p-2.5">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000} placeholder="Leave feedback on this moment — e.g. Remove the extra finger" />
        <div className="mt-2 flex items-center justify-between text-[11px] text-fog-400">
          <span>At {range ? `${seconds(range.start)}–${seconds(range.end)}` : seconds(t)}{pin ? ' · pinned' : ''}{!maskIsEmpty(mask) ? ' · with area' : ''}</span>
          <Button size="sm" onClick={add} loading={busy} disabled={!text.trim()}><MessageSquare /> Comment</Button>
        </div>
        <p className="mt-1 text-[11px] text-fog-500">Tip: use the pin tool to point at something, or draw an area.</p>
      </div>
      {list.length === 0 && <p className="text-xs text-fog-400">No comments on this shot yet.</p>}
      {[...list].reverse().map((c) => (
        <div key={c.id} className="rounded-xl border hairline p-2.5 text-xs">
          <div className="flex items-start justify-between gap-2">
            <span className="whitespace-pre-wrap text-fog-100">{c.text}</span>
            <Badge tone={c.status === 'accepted' || c.status === 'resolved' ? 'green' : c.status === 'failed' ? 'red' : c.status === 'ready_for_review' ? 'amber' : 'neutral'}>{COMMENT_STATUS_LABEL[c.status]}</Badge>
          </div>
          <div className="mt-1 text-fog-400">{c.startSec != null ? `${seconds(c.startSec)}${c.endSec != null && c.endSec !== c.startSec ? `–${seconds(c.endSec)}` : ''}` : ''}{c.mask ? ' · area' : ''}{c.x != null ? ' · pin' : ''}</div>
          <div className="mt-2 flex gap-1.5">
            {(c.status === 'open' || c.status === 'failed' || c.status === 'rejected') && <Button size="sm" variant="secondary" onClick={() => onSendToAi(c)}><Send /> Send to AI</Button>}
            {c.status !== 'resolved' && c.status !== 'processing' && <Button size="sm" variant="ghost" onClick={async () => { await api(`/api/comments/${c.id}`, { method: 'PATCH', body: { status: 'resolved' } }); refresh(); }}>Resolve</Button>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ frame edit → video

function EditFrameDialog({ versionId, atSec, projectId, aspect, onClose, onDone }: { versionId: string; atSec: number; projectId: string; aspect: string; onClose: () => void; onDone: (g: Guide) => void }) {
  const [frame, setFrame] = useState<{ id: string; url: string } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; url: string } | null>(null);
  const { data } = useJob(jobId);
  const up = useUploader({ projectId, kind: 'reference' });
  useEffect(() => {
    void api<{ asset: { id: string; url: string } }>(`/api/shot-versions/${versionId}/frame`, { body: { atSec } }).then((r) => setFrame(r.asset)).catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not grab the frame'));
  }, [versionId, atSec]);
  const job = data?.job;
  useEffect(() => {
    if (job?.status === 'completed' && job.outputAssetId && !result) void api<{ asset: Asset }>(`/api/assets/${job.outputAssetId}`).then((r) => setResult({ id: r.asset.id, url: r.asset.url }));
    if (job?.status === 'failed') toast.error(job.error?.message ?? 'The frame edit failed');
  }, [job, result]);
  const generate = async () => {
    try {
      const r = await api<{ job: { id: string } }>('/api/images', { body: { prompt: `${prompt.trim()}. Keep everything else in the image exactly the same: same people, faces, clothing, composition, lighting and colours.`, aspectRatio: ['9:16', '16:9', '1:1', '4:5'].includes(aspect) ? aspect : '16:9', purpose: 'frame', referenceAssetIds: [frame!.id], projectId, idempotencyKey: newKey() } });
      setJobId(r.job.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not edit the frame');
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Edit the frame at ${seconds(atSec)}`} description="Fix this still (AI image edit or your own retouched upload), then the video edit follows it." wide>
      {up.element}
      <div className="grid gap-3 md:grid-cols-2">
        <figure className="overflow-hidden rounded-xl bg-black">{frame ? <img src={frame.url} alt="Original frame" className="w-full" /> : <div className="grid aspect-video place-items-center"><Spinner /></div>}<figcaption className="p-1.5 text-[11px] text-fog-400">Original frame</figcaption></figure>
        <figure className="overflow-hidden rounded-xl bg-black">{result ? <img src={result.url} alt="Edited frame" className="w-full" /> : <div className="grid aspect-video place-items-center text-xs text-fog-400">{job && !['completed', 'failed'].includes(job.status) ? <ProgressBar progress={job.progress} etaSec={job.etaSec} label={job.phase} /> : 'Edited frame appears here'}</div>}<figcaption className="p-1.5 text-[11px] text-fog-400">Edited frame{job?.isFixture ? ' (placeholder — not AI)' : ''}</figcaption></figure>
      </div>
      <div className="mt-3 space-y-2">
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} maxLength={800} placeholder="What to change in this frame — e.g. make the jacket black" />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={generate} disabled={!frame || prompt.trim().length < 3 || Boolean(job && !['completed', 'failed'].includes(job.status))}><Sparkles /> Edit frame with AI (≈ 1–8 credits)</Button>
          <Button size="sm" variant="ghost" onClick={async () => { const a = await up.pick(); if (a) setResult({ id: a.id, url: a.url }); }}><Upload /> Upload my retouched frame</Button>
          <span className="flex-1" />
          <Button size="sm" variant="secondary" disabled={!result} onClick={() => result && onDone({ assetId: result.id, url: result.url, atSec })}><Check /> Use as guide for the video edit</Button>
        </div>
      </div>
    </Dialog>
  );
}
