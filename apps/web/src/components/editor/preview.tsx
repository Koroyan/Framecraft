'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, MousePointerClick, Pause, Play } from 'lucide-react';
import { clipDuration, coverPosition, reframeAt, timelineDuration, type Timeline } from '@framecraft/shared';
import type { Asset } from '@/lib/api';
import { clipStarts } from '@/lib/editor-store';
import { cameraStyle, Vignette } from '@/components/editor/look';
import { GradeCanvas, Grain } from '@/components/editor/grade-canvas';
import { LayerStage } from '@/components/editor/layers';
import { cn } from '@/lib/utils';

const POS_CLASS = { top: 'top-[10%]', center: 'top-1/2 -translate-y-1/2', bottom: 'bottom-[22%]' } as const;

type Logo = NonNullable<Timeline['logo']>;

/**
 * Time as minutes:seconds with hundredths (00:03.40 = 3.4 s), the same units as the rest of the
 * editor; it still changes on every one-frame step.
 */
export function timecode(t: number) {
  const cs = Math.floor(Math.max(0, t) * 100 + 1e-6);
  const m = Math.floor(cs / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/**
 * Brand logo that can be dragged anywhere in the preview (mouse, touch or arrow keys).
 * The position is stored as fractions of the frame, so the exported MP4 matches exactly.
 */
function DraggableLogo({ url, logo, onMove }: { url: string; logo: Logo; onMove: (pos: { x: number; y: number }) => void }) {
  const ref = useRef<HTMLImageElement>(null);
  const drag = useRef<{ dx: number; dy: number; frame: DOMRect; w: number; h: number; pos: { x: number; y: number } | null; raf: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const placed = logo.x !== undefined && logo.y !== undefined ? { x: logo.x, y: logo.y } : null;
  const measure = () => {
    const img = ref.current!;
    const frame = img.parentElement!.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    return { frame, r, x: (r.left - frame.left) / frame.width, y: (r.top - frame.top) / frame.height };
  };
  const clampPos = (x: number, y: number) => {
    const { frame, r } = measure();
    return { x: Math.min(Math.max(0, x), Math.max(0, 1 - r.width / frame.width)), y: Math.min(Math.max(0, y), Math.max(0, 1 - r.height / frame.height)) };
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
        e.stopPropagation();
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
        d.pos = {
          x: Math.min(Math.max(0, (e.clientX - d.dx - d.frame.left) / d.frame.width), Math.max(0, 1 - d.w / d.frame.width)),
          y: Math.min(Math.max(0, (e.clientY - d.dy - d.frame.top) / d.frame.height), Math.max(0, 1 - d.h / d.frame.height)),
        };
        if (!d.raf)
          d.raf = requestAnimationFrame(() => {
            d.raf = 0;
            const img = ref.current;
            if (!img || !d.pos) return;
            img.style.left = `${d.pos.x * 100}%`;
            img.style.top = `${d.pos.y * 100}%`;
            img.style.right = 'auto';
            img.style.bottom = 'auto';
          });
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        setDragging(false);
        if (d?.raf) cancelAnimationFrame(d.raf);
        if (d?.pos) onMove(d.pos);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
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
        const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        const cur = measure();
        onMove(clampPos(cur.x + d[0]!, cur.y + d[1]!));
      }}
    />
  );
}

/** What the preview is showing right now (for overlays such as the object selector). */
export type PreviewFrame = {
  clipIndex: number;
  clip: Timeline['clips'][number] | undefined;
  asset: Asset | undefined;
  /** Source second shown. */
  srcTime: number;
  video: React.RefObject<HTMLVideoElement | null>;
  frame: React.RefObject<HTMLDivElement | null>;
  playing: boolean;
  /** CSS object-position of the picture (auto re-frame), for mapping clicks to the source. */
  objectPosition?: string;
  /** Frame size on screen (CSS px). */
  size: { w: number; h: number };
  /** Contextual toolbars go in a column beside a portrait frame (no height taken from the picture). */
  vertical?: boolean;
  /** With `vertical`: where panels open right of the picture, so they never cover it (px from the toolbar's left). */
  panel?: { left: number; width: number };
};

export type PreviewProps = {
  timeline: Timeline;
  assets: Map<string, Asset>;
  playhead: number;
  setPlayhead: (t: number) => void;
  onLogoMove: (pos: { x: number; y: number }) => void;
  selectedLayer: string | null;
  onSelectLayer: (id: string | null) => void;
  onLayerChange: (id: string, patch: Partial<Timeline['layers'][number]>) => void;
  /** Object-select mode: clicks on the picture go to the overlay instead of the layers. */
  selecting?: boolean;
  onToggleSelecting?: () => void;
  overlay?: (f: PreviewFrame) => React.ReactNode;
  /** Draws object outlines / catches object clicks inside the picture (moves with the 2D camera). */
  objectsLayer?: (f: PreviewFrame) => React.ReactNode;
  /** Contextual toolbar shown above the picture (e.g. for the selected object). */
  toolbar?: (f: PreviewFrame) => React.ReactNode;
  onBackgroundClick?: () => void;
  /** Simple editor: only play, time and full screen under the picture. */
  minimal?: boolean;
  /** false = no control row (the simple editor puts play / time in its toolbar). */
  controls?: boolean;
  onPlayingChange?: (playing: boolean) => void;
};

export function Preview({ timeline, assets, playhead, setPlayhead, onLogoMove, selectedLayer, onSelectLayer, onLayerChange, selecting, onToggleSelecting, overlay, objectsLayer, toolbar, onBackgroundClick, minimal, controls = true, onPlayingChange }: PreviewProps) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [boxW, setBoxW] = useState(800);
  const [safe, setSafe] = useState<'off' | 'tiktok' | 'reels'>('off');
  const [playing, setPlaying] = useState(false);
  const [, setVideoMeta] = useState(0); // re-render once the intrinsic size is known (reframe)
  const fps = timeline.fps || 30;

  // Space (editor shortcut) and outside controls toggle playback; full screen on request.
  useEffect(() => {
    const toggle = () => setPlaying((v) => !v);
    const pause = () => setPlaying(false);
    const full = () => void frame.current?.requestFullscreen?.();
    window.addEventListener('fc-editor-toggle-play', toggle);
    window.addEventListener('fc-editor-pause', pause);
    window.addEventListener('fc-editor-fullscreen', full);
    return () => {
      window.removeEventListener('fc-editor-toggle-play', toggle);
      window.removeEventListener('fc-editor-pause', pause);
      window.removeEventListener('fc-editor-fullscreen', full);
    };
  }, []);
  useEffect(() => onPlayingChange?.(playing), [playing, onPlayingChange]);

  // Fit the frame (timeline aspect) into the space the panel gives us.
  const [aw, ah] = timeline.aspectRatio.split(':').map(Number) as [number, number];
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      setBoxW(W);
      const k = Math.min(W / aw, H / ah);
      setSize({ w: Math.max(80, Math.floor(aw * k)), h: Math.max(80, Math.floor(ah * k)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [aw, ah]);

  const starts = useMemo(() => clipStarts(timeline), [timeline]);
  const total = timelineDuration(timeline);
  const index = Math.max(0, starts.findLastIndex((s) => s <= playhead + 0.001));
  const clip = timeline.clips[index];
  const asset = clip ? assets.get(clip.assetId) : undefined;
  const clipT = playhead - (starts[index] ?? 0);
  const speed = clip?.freezeSec ? 1 : (clip?.speed ?? 1);
  const localTime = clip ? (clip.freezeSec ? clip.inSec : clip.inSec + clipT * speed) : 0;
  const clipLenNow = clip ? clipDuration(clip) : 0;

  // Paused: show exactly the frame at the playhead (frame stepping, selecting objects). Playing: only
  // correct real drift, so the video is not re-seeked on every playhead tick.
  useEffect(() => {
    const v = video.current;
    if (!v || !asset) return;
    if (Math.abs(v.currentTime - localTime) > (playing ? 0.35 : 0.004)) v.currentTime = Math.max(0, localTime);
  }, [asset, localTime, playing]);

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

  const clipVolume = clip?.volume ?? 1;
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.muted = timeline.muteClipAudio || clipVolume === 0;
    v.volume = Math.min(1, Math.max(0, clipVolume));
  }, [clipVolume, timeline.muteClipAudio, asset?.id]);

  // Audio tracks play in sync with the playhead, like the export.
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  useEffect(() => {
    const els = audioEls.current;
    for (const a of timeline.audio) {
      const src = assets.get(a.assetId)?.url;
      if (!src) continue;
      const key = `${a.id}:${a.assetId}`;
      let el = els.get(key);
      if (!el) {
        el = new Audio(src);
        el.preload = 'auto';
        els.set(key, el);
      }
      el.volume = a.muted ? 0 : Math.min(1, Math.max(0, a.volume));
      const len = a.outSec - a.inSec;
      const local = playhead - a.startSec;
      if (playing && local >= 0 && local < len) {
        const want = el.paused && local < 0.5 ? a.inSec : a.inSec + local;
        if (el.paused || Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
        if (el.paused) void el.play().catch(() => undefined);
      } else if (!el.paused) el.pause();
    }
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
  const step = (n: number) => {
    setPlaying(false);
    setPlayhead(Math.max(0, Math.min(total, Math.round((playhead + n / fps) * fps) / fps)));
  };

  const fade = clip ? Math.min(1, clip.fadeInSec ? clipT / clip.fadeInSec : 1, clip.fadeOutSec ? (clipLenNow - clipT) / clip.fadeOutSec : 1) * (clip.opacity ?? 1) : 1;

  // Transitions, as in the export: during the blend the previous clip is drawn over this one. It is
  // mounted a moment early (hidden) so it is loaded and in step when the blend starts.
  const prevClip = index > 0 ? timeline.clips[index - 1] : undefined;
  const blendDur = prevClip?.transition && prevClip.transition.type !== 'cut' ? prevClip.transition.durationSec : 0;
  const blending = Boolean(blendDur && clipT >= 0 && clipT < blendDur);
  const nextStart = starts[index + 1];
  const outIndex = blending ? index - 1 : clip?.transition && clip.transition.type !== 'cut' && nextStart !== undefined && playhead >= nextStart - 1.5 ? index : -1;
  const outClip = outIndex >= 0 ? timeline.clips[outIndex] : undefined;
  const outAsset = outClip ? assets.get(outClip.assetId) : undefined;
  const outTime = outClip ? (outClip.freezeSec ? outClip.inSec : outClip.inSec + (playhead - (starts[outIndex] ?? 0)) * (outClip.speed || 1)) : 0;
  const blendP = blending ? Math.min(1, Math.max(0, clipT / blendDur)) : 0;
  const outVideo = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const ov = outVideo.current;
    if (!ov || !outClip) return;
    ov.playbackRate = outClip.freezeSec ? 1 : outClip.speed || 1;
    if (Math.abs(ov.currentTime - outTime) > (playing ? 0.25 : 0.004)) ov.currentTime = Math.max(0, outTime);
    if (playing && !outClip.freezeSec) void ov.play().catch(() => undefined);
    else ov.pause();
  }, [outClip, outTime, playing]);
  const outStyle = ((): React.CSSProperties => {
    if (!blending) return { opacity: 0 };
    const type = prevClip?.transition?.type;
    if (type === 'fadeblack') return { opacity: blendP < 0.5 ? 1 : 0 };
    if (type === 'wipeleft') return { clipPath: `inset(0 ${blendP * 100}% 0 0)` };
    if (type === 'wiperight') return { clipPath: `inset(0 0 0 ${blendP * 100}%)` };
    if (type === 'slideup') return { transform: `translateY(${-blendP * 100}%)` };
    if (type === 'circleopen') {
      const r = (blendP * Math.hypot(size.w, size.h)) / 2;
      const m = `radial-gradient(circle at 50% 50%, transparent ${r}px, black ${r + 1}px)`;
      return { maskImage: m, WebkitMaskImage: m };
    }
    return { opacity: 1 - blendP }; // fade, dissolve
  })();
  const blackOver = blending && prevClip?.transition?.type === 'fadeblack' ? (blendP < 0.5 ? blendP * 2 : (1 - blendP) * 2) : 0;
  const overlays = timeline.overlays.filter((o) => playhead >= o.startSec && playhead <= o.endSec);
  const texts = timeline.texts.filter((t) => playhead >= t.startSec && playhead <= t.endSec);
  const subs = timeline.burnSubtitles ? timeline.subtitles.filter((s) => playhead >= s.startSec && playhead <= s.endSec) : [];
  const logo = timeline.logo ? assets.get(timeline.logo.assetId) : undefined;
  const v = video.current;
  const objectPosition = clip?.reframe && v?.videoWidth ? (() => { const pos = coverPosition({ w: v.videoWidth, h: v.videoHeight }, { w: aw, h: ah }, reframeAt(clip.reframe!.points, localTime)); return `${pos.x}% ${pos.y}%`; })() : undefined;
  const pf: PreviewFrame = { clipIndex: index, clip, asset, srcTime: localTime, video, frame, playing, objectPosition, size };

  // Portrait frame with room beside it: toolbars become a side column instead of a row above.
  const [vertical, setVertical] = useState(false);
  const side = (boxW - size.w) / 2;
  useEffect(() => {
    const want = aw < ah && side >= (vertical ? 150 : 172);
    if (want !== vertical) setVertical(want);
  }, [side, aw, ah, vertical]);
  // Panels open in the free space right of a portrait picture when it is wide enough.
  const panel = vertical && side - 12 >= 196 ? { left: Math.round(side + size.w + 8), width: Math.round(Math.min(300, side - 12)) } : undefined;
  const tb = toolbar?.({ ...pf, vertical, panel });
  const compact = boxW < 520;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {tb && !vertical && <div className="relative z-20 flex shrink-0 justify-center px-1 pb-2">{tb}</div>}
      <div ref={box} className="relative min-h-0 flex-1">
        {tb && vertical && <div className="absolute inset-y-0 left-0 z-20 flex flex-col">{tb}</div>}
        <div
          ref={frame}
          data-testid="preview-frame"
          className={cn('absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg bg-black shadow-[0_0_0_1px_rgba(255,255,255,0.06)]', selecting && 'cursor-crosshair')}
          style={{ width: size.w, height: size.h }}
          onPointerDown={() => {
            onSelectLayer(null);
            onBackgroundClick?.();
          }}
        >
          {asset ? (
            <div className="absolute inset-0 overflow-hidden" style={{ opacity: Math.max(0, fade) }}>
              <div className="size-full" style={cameraStyle(clip?.camera, clipT)}>
                <video ref={video} src={asset.url} playsInline crossOrigin="anonymous" muted={timeline.muteClipAudio || clipVolume === 0} onTimeUpdate={onTime} onLoadedMetadata={() => setVideoMeta((x) => x + 1)} className="size-full object-cover" preload="auto" style={objectPosition ? { objectPosition } : undefined} />
                <GradeCanvas video={video} adjust={clip?.adjust} lutUrl={clip?.adjust?.lut ? (assets.get(clip.adjust.lut.assetId)?.url ?? null) : null} objectPosition={objectPosition} objects={clip?.objects} srcTime={() => localTime} />
                {objectsLayer?.(pf)}
              </div>
              <Vignette amount={clip?.adjust?.vignette} />
              <Grain amount={clip?.adjust?.grain} />
            </div>
          ) : (
            <div className="grid size-full place-items-center px-2 text-center text-[11px] leading-snug text-fog-400">Add a video to start</div>
          )}
          {outClip && outAsset && (
            <video key={outClip.id} ref={outVideo} src={outAsset.url} crossOrigin="anonymous" muted playsInline preload="auto" aria-hidden className="pointer-events-none absolute inset-0 size-full object-cover" style={outStyle} />
          )}
          {blackOver > 0 && <div className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: blackOver }} />}
          {overlays.map((o) => {
            const a = assets.get(o.assetId);
            if (!a) return null;
            const style = { left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, opacity: o.opacity } as const;
            return a.mediaType === 'video' ? <video key={o.id} src={a.url} muted autoPlay={playing} loop playsInline className="pointer-events-none absolute" style={style} /> : <img key={o.id} src={a.url} alt="" className="pointer-events-none absolute" style={style} />;
          })}
          {clip?.reverse && <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-white">Plays reversed in the export</span>}
          {clip?.freezeSec && <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-white">Freeze frame</span>}
          {texts.map((t) => (
            <div key={t.id} className={cn('pointer-events-none absolute inset-x-4 text-center font-semibold', POS_CLASS[t.position])} style={{ color: t.color, fontSize: `${(t.fontSize / 1080) * size.h}px` }}>
              <span className={cn(t.background && 'rounded-md bg-black/50 px-2 py-0.5')}>{t.text}</span>
            </div>
          ))}
          {subs.map((s) => (
            <div key={s.id} className="pointer-events-none absolute inset-x-4 bottom-[14%] text-center font-semibold text-white [text-shadow:0_0_4px_#000,0_0_2px_#000]" style={{ fontSize: Math.max(11, size.h * 0.03) }}>{s.text}</div>
          ))}
          {!selecting && <LayerStage timeline={timeline} t={playhead} playing={playing} assets={assets} selectedId={selectedLayer} onSelect={onSelectLayer} onChange={onLayerChange} frame={frame} frameH={Math.max(240, Math.min(2160, Math.round(size.h * (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))))} />}
          {safe !== 'off' && (
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute inset-x-0 bottom-0 h-[20%] bg-signal-red/20" />
              <div className="absolute bottom-[20%] right-0 top-[38%] w-[16%] bg-signal-red/20" />
              <div className="absolute inset-x-0 top-0 h-[9%] bg-signal-red/15" />
              <span className="absolute bottom-1 left-2 text-[9px] text-white/80">{safe === 'tiktok' ? 'TikTok' : 'Reels'} UI area — keep text out</span>
            </div>
          )}
          {!selecting && logo && timeline.logo && <DraggableLogo url={logo.url} logo={timeline.logo} onMove={onLogoMove} />}
          {asset?.isFixture && <span className="absolute left-2 top-2 rounded-full bg-signal-amber px-2 py-0.5 text-[10px] font-semibold text-black">TEST FIXTURE · NOT AI</span>}
          {overlay?.(pf)}
        </div>
      </div>
      {controls && (
      <div className="flex h-11 shrink-0 items-center gap-1.5 px-1">
        {onToggleSelecting && (
          <button type="button" onClick={onToggleSelecting} aria-pressed={selecting} aria-label="Select object" title="Click an object in the picture to select it (V)" className={cn('flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition', selecting ? 'bg-iris-500 text-white' : 'border hairline text-fog-200 hover:border-white/25 hover:text-white')}>
            <MousePointerClick className="size-3.5" /> {compact ? null : selecting ? 'Selecting…' : 'Select object'}
          </button>
        )}
        <span className="flex-1" />
        <button type="button" aria-label="Previous frame" title="Previous frame (←)" onClick={() => step(-1)} className="grid size-8 place-items-center rounded-lg text-fog-300 hover:bg-white/[0.06] hover:text-white"><ChevronLeft className="size-4" /></button>
        <button type="button" aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (Space)" onClick={() => setPlaying((p) => !p)} disabled={!timeline.clips.length} className="grid size-9 place-items-center rounded-full bg-white text-ink-950 transition hover:bg-fog-100 disabled:opacity-40">
          {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
        </button>
        <button type="button" aria-label="Next frame" title="Next frame (→)" onClick={() => step(1)} className="grid size-8 place-items-center rounded-lg text-fog-300 hover:bg-white/[0.06] hover:text-white"><ChevronRight className="size-4" /></button>
        <span className={cn('shrink-0 text-center font-mono text-[11px] tabular-nums text-fog-300', compact ? 'w-[4.5rem]' : 'w-[8.5rem]')} aria-label="Time">
          <span className="text-white">{timecode(playhead)}</span>{compact ? null : <> / {timecode(total)}</>}
        </span>
        <span className="flex-1" />
        <select aria-label="Safe zones" className={cn('h-8 rounded-lg border hairline bg-ink-900 px-1.5 text-[11px] text-fog-200', (compact || minimal) && 'hidden')} value={safe} onChange={(e) => setSafe(e.target.value as typeof safe)}>
          <option value="off">Safe zones</option>
          <option value="tiktok">TikTok</option>
          <option value="reels">Reels</option>
        </select>
        <button type="button" aria-label="Full screen" title="Full screen preview" onClick={() => void frame.current?.requestFullscreen?.()} className="grid size-8 place-items-center rounded-lg text-fog-300 hover:bg-white/[0.06] hover:text-white"><Maximize2 className="size-3.5" /></button>
      </div>
      )}
    </div>
  );
}
