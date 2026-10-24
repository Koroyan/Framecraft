'use client';

import { useRef, useState } from 'react';
import { Plus, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { CAMERA_MOVES, cameraAt, cameraPreset, clampKeyframe, clipAdjustSchema, type CameraMove, type ClipAdjust, type ClipCamera } from '@framecraft/shared';
import { Button, Field, NativeSelect, Segmented } from '@/components/ui';
import { cn, seconds } from '@/lib/utils';

type Frame = { x: number; y: number; scale: number; rotation: number };

/**
 * Framing rectangle over the full frame: drag to pan, drag the corner to zoom. Shows the motion path
 * of the window centre, start/end positions and keyframes. Values are fractions of the frame.
 */
export function CameraFrame({ camera, t, duration, live, onLive }: { camera?: ClipCamera; t: number; duration: number; live: Frame | null; onLive: (f: Frame) => void }) {
  const cur = live ?? cameraAt(camera, t);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'move' | 'zoom'; x0: number; y0: number; f: Frame } | null>(null);
  const w = 1 / cur.scale;
  const path = camera?.keyframes.length ? Array.from({ length: 41 }, (_, i) => cameraAt(camera, (duration * i) / 40)) : [];
  const start = camera?.keyframes.length ? cameraAt(camera, 0) : null;
  const end = camera?.keyframes.length ? cameraAt(camera, duration) : null;
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const r = box.current?.getBoundingClientRect();
    if (!d || !r) return;
    const dx = (e.clientX - d.x0) / r.width;
    const dy = (e.clientY - d.y0) / r.height;
    if (d.mode === 'move') onLive({ ...d.f, ...clampKeyframe({ x: d.f.x + dx, y: d.f.y + dy, scale: d.f.scale }) });
    else {
      // Corner drag: the window grows/shrinks around its centre.
      const half = Math.max(0.125, Math.min(0.5, 0.5 / d.f.scale + Math.max(dx, dy)));
      const scale = Math.round(Math.min(4, Math.max(1, 0.5 / half)) * 100) / 100;
      onLive({ ...d.f, ...clampKeyframe({ x: d.f.x, y: d.f.y, scale }) });
    }
  };
  return (
    <div ref={box} className="absolute inset-0" onPointerMove={move} onPointerUp={() => (drag.current = null)}>
      <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {path.length > 1 && <polyline points={path.map((k) => `${k.x * 100},${k.y * 100}`).join(' ')} fill="none" stroke="#fbbf24" strokeWidth="0.6" strokeDasharray="1.5 1" vectorEffect="non-scaling-stroke" />}
        {start && <rect x={(start.x - 0.5 / start.scale) * 100} y={(start.y - 0.5 / start.scale) * 100} width={100 / start.scale} height={100 / start.scale} fill="none" stroke="#34d399" strokeWidth="1" strokeDasharray="2 1.5" vectorEffect="non-scaling-stroke" />}
        {end && <rect x={(end.x - 0.5 / end.scale) * 100} y={(end.y - 0.5 / end.scale) * 100} width={100 / end.scale} height={100 / end.scale} fill="none" stroke="#f87171" strokeWidth="1" strokeDasharray="2 1.5" vectorEffect="non-scaling-stroke" />}
        {camera?.keyframes.map((k, i) => (
          <circle key={i} cx={k.x * 100} cy={k.y * 100} r="0.9" fill="#fbbf24" />
        ))}
        {/* Rule of thirds and title-safe guides inside the live window. */}
        <g opacity="0.35">
          {[1, 2].map((j) => (
            <line key={`v${j}`} x1={(cur.x - w / 2 + (w * j) / 3) * 100} y1={(cur.y - w / 2) * 100} x2={(cur.x - w / 2 + (w * j) / 3) * 100} y2={(cur.y + w / 2) * 100} stroke="white" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
          ))}
          {[1, 2].map((j) => (
            <line key={`h${j}`} x1={(cur.x - w / 2) * 100} y1={(cur.y - w / 2 + (w * j) / 3) * 100} x2={(cur.x + w / 2) * 100} y2={(cur.y - w / 2 + (w * j) / 3) * 100} stroke="white" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      </svg>
      <div
        role="slider"
        aria-label="Camera framing — drag to pan"
        aria-valuenow={Math.round(cur.scale * 100)}
        tabIndex={0}
        className="absolute cursor-move touch-none rounded-sm border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
        style={{ left: `${(cur.x - w / 2) * 100}%`, top: `${(cur.y - w / 2) * 100}%`, width: `${w * 100}%`, height: `${w * 100}%`, transform: `rotate(${cur.rotation}deg)` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { mode: 'move', x0: e.clientX, y0: e.clientY, f: cur };
        }}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
        onWheel={(e) => onLive({ ...cur, ...clampKeyframe({ x: cur.x, y: cur.y, scale: Math.round(Math.min(4, Math.max(1, cur.scale * (e.deltaY < 0 ? 1.06 : 1 / 1.06))) * 100) / 100 }) })}
        onKeyDown={(e) => {
          const s = e.shiftKey ? 0.05 : 0.01;
          const d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key];
          if (!d) return;
          e.preventDefault();
          onLive({ ...cur, ...clampKeyframe({ x: cur.x + d[0]!, y: cur.y + d[1]!, scale: cur.scale }) });
        }}
      >
        <span className="absolute left-1 top-1 rounded bg-white px-1 text-[10px] font-semibold text-black">{Math.round(cur.scale * 100)}%</span>
        <span
          aria-label="Drag to zoom"
          className="absolute bottom-1 right-1 size-4 cursor-nwse-resize rounded-sm border-2 border-ink-900 bg-white shadow"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { mode: 'zoom', x0: e.clientX, y0: e.clientY, f: cur };
          }}
          onPointerMove={move}
          onPointerUp={() => (drag.current = null)}
        />
      </div>
    </div>
  );
}

/** Camera panel: presets, keyframes at the playhead, easing, and the generative remix hand-off. */
export function CameraPanel({ camera, t, duration, live, setLive, onChange, onRemix }: { camera?: ClipCamera; t: number; duration: number; live: Frame | null; setLive: (f: Frame | null) => void; onChange: (c: ClipCamera | undefined) => void; onRemix: () => void }) {
  const [preset, setPreset] = useState<CameraMove>('push_in');
  const [intensity, setIntensity] = useState(0.5);
  const cur = live ?? cameraAt(camera, t);
  const keys = [...(camera?.keyframes ?? [])].sort((a, b) => a.t - b.t);
  const setKey = () => {
    const k = { t: Math.round(t * 100) / 100, x: cur.x, y: cur.y, scale: cur.scale, rotation: cur.rotation };
    const rest = keys.filter((x) => Math.abs(x.t - k.t) > 0.04);
    onChange({ keyframes: [...rest, k].sort((a, b) => a.t - b.t).slice(0, 16), easing: camera?.easing ?? 'ease' });
    setLive(null);
  };
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-signal-green/25 bg-signal-green/5 p-2.5 text-[11px] text-fog-200">
        <b className="text-white">Precise 2D camera.</b> Pans, zooms and rotates the existing frames — exact, free, and identical in the export. Drag the white frame on the video; the corner zooms.
      </div>
      <Field label="Preset movement">
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <NativeSelect value={preset} onChange={(e) => setPreset(e.target.value as CameraMove)}>
            {CAMERA_MOVES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </NativeSelect>
          <Button size="sm" variant="secondary" onClick={() => { onChange(cameraPreset(preset, duration, intensity, { x: cur.x, y: cur.y })); setLive(null); }}><Wand2 /> Apply</Button>
        </div>
      </Field>
      <Field label={`Intensity · ${Math.round(intensity * 100)}%`} hint={preset === 'zoom_to' ? 'Zooms towards the centre of the white frame — place it on the face or product first.' : undefined}>
        <input type="range" className="w-full" min={0.05} max={1} step={0.05} value={intensity} onChange={(e) => setIntensity(Number(e.target.value))} />
      </Field>
      <Field label={`Zoom · ${Math.round(cur.scale * 100)}%`} hint="Or drag the frame’s corner / scroll over it.">
        <input type="range" className="w-full" min={1} max={4} step={0.01} value={cur.scale} onChange={(e) => setLive({ ...cur, ...clampKeyframe({ x: cur.x, y: cur.y, scale: Number(e.target.value) }) })} />
      </Field>
      <Field label={`Rotation · ${cur.rotation.toFixed(1)}°`}>
        <input type="range" className="w-full" min={-15} max={15} step={0.5} value={cur.rotation} onChange={(e) => setLive({ ...cur, rotation: Number(e.target.value) })} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={setKey}><Plus /> Keyframe at {seconds(t)}</Button>
        {live && <Button size="sm" variant="ghost" onClick={() => setLive(null)}>Discard drag</Button>}
        {camera && <Button size="sm" variant="ghost" onClick={() => { onChange(undefined); setLive(null); }}><RotateCcw /> Reset camera</Button>}
      </div>
      {keys.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-fog-300">
            Keyframes
            <Segmented size="sm" value={camera?.easing ?? 'ease'} onChange={(v) => camera && onChange({ ...camera, easing: v })} options={[{ value: 'ease', label: 'Ease' }, { value: 'linear', label: 'Linear' }]} />
          </div>
          {keys.map((k, i) => (
            <div key={`${k.t}-${i}`} className={cn('flex items-center justify-between rounded-lg px-2 py-1 text-xs', Math.abs(k.t - t) < 0.05 ? 'bg-iris-500/20 text-white' : 'bg-white/[0.03] text-fog-200')}>
              <span className="tabular-nums">{seconds(k.t)} · zoom {Math.round(k.scale * 100)}% · {k.x.toFixed(2)}, {k.y.toFixed(2)}{k.rotation ? ` · ${k.rotation.toFixed(1)}°` : ''}</span>
              <button type="button" aria-label="Delete keyframe" className="text-fog-400 hover:text-signal-red" onClick={() => onChange(keys.length > 1 ? { keyframes: keys.filter((_, j) => j !== i), easing: camera?.easing ?? 'ease' } : undefined)}><Trash2 className="size-3.5" /></button>
            </div>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-signal-amber/30 bg-signal-amber/5 p-2.5 text-[11px] text-fog-200">
        <b className="text-white">Generative camera remix</b> asks an AI model for a different viewpoint (low angle, orbit, other side). It re-renders the whole shot and can change faces or geometry — you review it as a new version before it’s used.
        <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onRemix}>Set up a camera remix…</Button>
      </div>
    </div>
  );
}

const ADJUST_FIELDS: { key: keyof ClipAdjust; label: string; min: number; max: number; step: number }[] = [
  { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.05 },
  { key: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.02 },
  { key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.02 },
  { key: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.02 },
  { key: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.02 },
  { key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.02 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.02 },
  { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.02 },
  { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1 },
  { key: 'blur', label: 'Blur', min: 0, max: 20, step: 0.5 },
  { key: 'sharpen', label: 'Sharpen', min: 0, max: 2, step: 0.05 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.02 },
];

export function ColorPanel({ adjust, onChange, onCopyToAll }: { adjust?: Partial<ClipAdjust>; onChange: (a: ClipAdjust | undefined) => void; onCopyToAll?: () => void }) {
  const a = clipAdjustSchema.parse(adjust ?? {});
  return (
    <div className="space-y-3">
      {ADJUST_FIELDS.map((f) => (
        <label key={f.key} className="block">
          <span className="flex justify-between text-xs text-fog-300">
            {f.label}
            <button type="button" className={cn('tabular-nums', a[f.key] ? 'text-iris-200 hover:text-white' : 'text-fog-500')} onClick={() => onChange({ ...a, [f.key]: 0 })} title="Reset">
              {a[f.key] > 0 && f.min < 0 ? '+' : ''}{f.step < 1 ? a[f.key].toFixed(2) : a[f.key]}
            </button>
          </span>
          <input type="range" className="w-full" min={f.min} max={f.max} step={f.step} value={a[f.key]} onChange={(e) => onChange({ ...a, [f.key]: Number(e.target.value) })} />
        </label>
      ))}
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}><RotateCcw /> Reset</Button>
        {onCopyToAll && <Button size="sm" variant="secondary" onClick={onCopyToAll}>Use on every shot</Button>}
      </div>
      <p className="text-[11px] text-fog-400">The preview uses the same colour maths as the export; blur, sharpen and vignette are close approximations.</p>
    </div>
  );
}
