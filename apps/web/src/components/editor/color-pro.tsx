'use client';

import { useRef, useState } from 'react';
import { Crosshair, Pipette, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { curveFn, gradeSchema, HSL_BANDS, hslToRgb, LOOKS, maskIsEmpty, rgbToHex, rgbToHsl, type ColorReplace, type EditMask, type GradeSettings, type HslBand } from '@framecraft/shared';
import { lookActive, lookSwatch } from '@/lib/looks';
import { api, ApiError } from '@/lib/api';
import { Button, Field, NativeSelect, Segmented } from '@/components/ui';
import { cn } from '@/lib/utils';

type Tab = 'basic' | 'curves' | 'wheels' | 'hsl' | 'replace' | 'looks';
type Curves = NonNullable<GradeSettings['curves']>;

const BASIC: { key: keyof GradeSettings; label: string; min: number; max: number; step: number }[] = [
  { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.05 },
  { key: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.02 },
  { key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.02 },
  { key: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.02 },
  { key: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.02 },
  { key: 'whites', label: 'Whites', min: -1, max: 1, step: 0.02 },
  { key: 'blacks', label: 'Blacks', min: -1, max: 1, step: 0.02 },
  { key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.02 },
  { key: 'vibrance', label: 'Vibrance', min: -1, max: 1, step: 0.02 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.02 },
  { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.02 },
  { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1 },
  { key: 'fade', label: 'Fade', min: 0, max: 1, step: 0.02 },
  { key: 'sharpen', label: 'Sharpness', min: 0, max: 2, step: 0.05 },
  { key: 'blur', label: 'Blur', min: 0, max: 20, step: 0.5 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.02 },
  { key: 'grain', label: 'Film grain', min: 0, max: 1, step: 0.02 },
  { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.02 },
];

const PRESET_KEY = 'fc-color-presets';
const loadPresets = (): { name: string; grade: Partial<GradeSettings> }[] => {
  try {
    return JSON.parse(localStorage.getItem(PRESET_KEY) ?? '[]');
  } catch {
    return [];
  }
};

/**
 * Professional colour panel. Everything here is deterministic (no AI): basic tone, curves,
 * lift/gamma/gain wheels, HSL bands, colour replacement (optionally inside a tracked mask),
 * looks, custom .cube LUTs and saved presets. Preview and export share the same maths.
 */
export function ColorPro({
  adjust,
  onChange,
  onCopyToAll,
  mask,
  onPick,
  picked,
  onTrackMask,
  otherShots,
  onMatchFrom,
}: {
  adjust?: Partial<GradeSettings>;
  onChange: (a: GradeSettings | undefined) => void;
  onCopyToAll?: () => void;
  /** The selection drawn on the video (to limit a colour replacement to it). */
  mask?: EditMask | null;
  /** Start the eyedropper; the picked colour arrives in `picked`. */
  onPick?: (target: string) => void;
  picked?: { target: string; hex: string } | null;
  /** Track the current mask through the clip; resolves with the moving mask. */
  onTrackMask?: (m: EditMask) => Promise<EditMask | null>;
  otherShots?: { label: string; adjust?: Partial<GradeSettings> }[];
  onMatchFrom?: (a: Partial<GradeSettings> | undefined) => void;
}) {
  const [tab, setTab] = useState<Tab>('basic');
  const g = gradeSchema.parse(adjust ?? {});
  const set = (patch: Partial<GradeSettings>) => onChange(gradeSchema.parse({ ...g, ...patch }));
  const tabs: [Tab, string][] = [['basic', 'Basic'], ['curves', 'Curves'], ['wheels', 'Wheels'], ['hsl', 'HSL'], ['replace', 'Replace'], ['looks', 'Looks & LUT']];

  // Apply a picked colour to the replacement that asked for it.
  const lastPick = useRef<string | null>(null);
  if (picked && lastPick.current !== `${picked.target}:${picked.hex}`) {
    lastPick.current = `${picked.target}:${picked.hex}`;
    const [id, field] = picked.target.split(':');
    const reps = (g.replace ?? []).map((r) => (r.id === id ? { ...r, [field as 'from' | 'to']: picked.hex } : r));
    queueMicrotask(() => set({ replace: reps }));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {tabs.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cn('rounded-lg px-2.5 py-1 text-[11px]', tab === k ? 'bg-white/10 text-white' : 'text-fog-300 hover:bg-white/[0.05]')}>{l}</button>
        ))}
      </div>

      {tab === 'basic' && (
        <div className="space-y-2.5">
          {BASIC.map((f) => {
            const v = g[f.key] as number;
            return (
              <label key={f.key} className="block">
                <span className="flex justify-between text-xs text-fog-300">
                  {f.label}
                  <button type="button" className={cn('tabular-nums', v ? 'text-iris-200 hover:text-white' : 'text-fog-500')} onClick={() => set({ [f.key]: 0 })} title="Reset">{f.step < 1 ? v.toFixed(2) : v}</button>
                </span>
                <input type="range" className="w-full" min={f.min} max={f.max} step={f.step} value={v} onChange={(e) => set({ [f.key]: Number(e.target.value) })} />
              </label>
            );
          })}
        </div>
      )}

      {tab === 'curves' && <CurvesEditor curves={g.curves ?? {}} onChange={(c) => set({ curves: c })} />}

      {tab === 'wheels' && (
        <div className="grid grid-cols-3 gap-2">
          {(['lift', 'gamma', 'gain'] as const).map((k) => (
            <Wheel key={k} label={{ lift: 'Lift (shadows)', gamma: 'Gamma (mids)', gain: 'Gain (highlights)' }[k]} value={g[k] ?? { r: 0, g: 0, b: 0 }} onChange={(v) => set({ [k]: v })} />
          ))}
        </div>
      )}

      {tab === 'hsl' && (
        <div className="space-y-2">
          {HSL_BANDS.map((b) => {
            const cur = g.hsl?.[b.key] ?? { h: 0, s: 0, l: 0 };
            const upd = (patch: Partial<typeof cur>) => set({ hsl: { ...(g.hsl ?? {}), [b.key]: { ...cur, ...patch } } as Record<HslBand, typeof cur> });
            return (
              <div key={b.key} className="grid grid-cols-[64px_1fr_1fr_1fr] items-center gap-1.5 text-[10px] text-fog-300">
                <span className="flex items-center gap-1.5"><span className="size-3 rounded-full" style={{ background: rgbToHex(hslToRgb(b.hue, 0.8, 0.5)) }} />{b.label}</span>
                <input type="range" aria-label={`${b.label} hue`} title={`Hue ${cur.h}`} min={-60} max={60} step={1} value={cur.h} onChange={(e) => upd({ h: Number(e.target.value) })} />
                <input type="range" aria-label={`${b.label} saturation`} title={`Saturation ${cur.s}`} min={-1} max={1} step={0.05} value={cur.s} onChange={(e) => upd({ s: Number(e.target.value) })} />
                <input type="range" aria-label={`${b.label} lightness`} title={`Lightness ${cur.l}`} min={-1} max={1} step={0.05} value={cur.l} onChange={(e) => upd({ l: Number(e.target.value) })} />
              </div>
            );
          })}
          <div className="grid grid-cols-[64px_1fr_1fr_1fr] text-center text-[10px] text-fog-500"><span /><span>Hue</span><span>Saturation</span><span>Lightness</span></div>
        </div>
      )}

      {tab === 'replace' && <ReplaceEditor reps={g.replace ?? []} onChange={(r) => set({ replace: r })} mask={mask} onPick={onPick} onTrackMask={onTrackMask} />}

      {tab === 'looks' && (
        <Looks
          grade={g}
          onApply={(look) => onChange(gradeSchema.parse({ ...look, lut: g.lut, replace: g.replace }))}
          onLut={(lut) => set({ lut })}
          otherShots={otherShots}
          onMatchFrom={onMatchFrom}
        />
      )}

      <div className="flex flex-wrap gap-2 border-t hairline pt-3">
        <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}><RotateCcw /> Reset all</Button>
        {onCopyToAll && <Button size="sm" variant="secondary" onClick={onCopyToAll}>Use on every shot</Button>}
      </div>
      <p className="text-[11px] text-fog-400">Colour (tone, curves, wheels, HSL, replacements, LUTs) previews exactly as exported. Blur, grain, glow and vignette are close approximations in the preview.</p>
    </div>
  );
}

function CurvesEditor({ curves, onChange }: { curves: Curves; onChange: (c: Curves) => void }) {
  const [ch, setCh] = useState<'master' | 'r' | 'g' | 'b'>('master');
  const pts = curves[ch] ?? [[0, 0], [1, 1]];
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const S = 220;
  const color = { master: '#ffffff', r: '#f87171', g: '#4ade80', b: '#60a5fa' }[ch];
  const sorted = [...pts].sort((a, b) => a[0] - b[0]);
  const at = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))] as [number, number];
  };
  const write = (p: [number, number][]) => onChange({ ...curves, [ch]: [...p].sort((a, b) => a[0] - b[0]) });
  // Draw the curve by sampling the same monotone interpolation as the renderer.
  const curve = curveFn(sorted)!;
  const path = Array.from({ length: 81 }, (_, i) => `${(i / 80) * S},${(1 - Math.min(1, Math.max(0, curve(i / 80)))) * S}`).join(' ');
  return (
    <div className="space-y-2">
      <Segmented size="sm" value={ch} onChange={setCh} options={[{ value: 'master', label: 'RGB' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }]} />
      <svg
        ref={svg}
        viewBox={`0 0 ${S} ${S}`}
        className="aspect-square w-full touch-none rounded-xl border hairline bg-black/40"
        onPointerDown={(e) => {
          const p = at(e);
          const hit = sorted.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 0.05);
          if (hit >= 0) drag.current = hit;
          else {
            write([...sorted, p]);
            drag.current = [...sorted, p].sort((a, b) => a[0] - b[0]).findIndex((q) => q === p);
          }
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current == null) return;
          const p = at(e);
          const next = sorted.map((q, i) => (i === drag.current ? ([i === 0 ? 0 : i === sorted.length - 1 ? 1 : p[0], p[1]] as [number, number]) : q));
          write(next);
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={(e) => {
          const p = at(e as unknown as React.PointerEvent);
          const hit = sorted.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 0.05);
          if (hit > 0 && hit < sorted.length - 1) write(sorted.filter((_, i) => i !== hit));
        }}
      >
        {[0.25, 0.5, 0.75].map((v) => (
          <g key={v} stroke="rgba(255,255,255,0.08)">
            <line x1={v * S} y1={0} x2={v * S} y2={S} />
            <line x1={0} y1={v * S} x2={S} y2={v * S} />
          </g>
        ))}
        <line x1={0} y1={S} x2={S} y2={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
        <polyline points={path} fill="none" stroke={color} strokeWidth={2} />
        {sorted.map(([x, y], i) => <circle key={i} cx={x * S} cy={(1 - y) * S} r={5} fill={color} stroke="#000" />)}
      </svg>
      <div className="flex justify-between text-[11px] text-fog-400">
        <span>Click to add a point, drag to move, double-click to remove.</span>
        <button type="button" className="text-fog-300 hover:text-white" onClick={() => onChange({ ...curves, [ch]: undefined })}>Reset {ch === 'master' ? 'RGB' : ch.toUpperCase()}</button>
      </div>
    </div>
  );
}

/** Colour wheel: drag the dot towards a hue to push the shadows / mids / highlights that way. */
function Wheel({ label, value, onChange }: { label: string; value: { r: number; g: number; b: number }; onChange: (v: { r: number; g: number; b: number }) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const mean = (value.r + value.g + value.b) / 3;
  const off = { r: value.r - mean, g: value.g - mean, b: value.b - mean };
  // Position from the offset: hue angle and strength.
  const [h, s] = rgbToHsl(0.5 + off.r, 0.5 + off.g, 0.5 + off.b);
  const amount = Math.min(1, Math.hypot(off.r, off.g, off.b) * 3);
  const ang = (h * Math.PI) / 180;
  const dot = { x: 50 + Math.cos(ang) * amount * 45, y: 50 - Math.sin(ang) * amount * 45 };
  void s;
  const setFrom = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - 0.5;
    const dy = -((e.clientY - r.top) / r.height - 0.5);
    const amt = Math.min(1, Math.hypot(dx, dy) * 2);
    const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    const c = hslToRgb(hue, 1, 0.5);
    const cm = (c[0] + c[1] + c[2]) / 3;
    const k = amt / 3;
    onChange({ r: round(mean + (c[0] - cm) * k), g: round(mean + (c[1] - cm) * k), b: round(mean + (c[2] - cm) * k) });
  };
  return (
    <div className="space-y-1.5 text-center">
      <div
        ref={ref}
        role="slider"
        aria-label={label}
        aria-valuenow={Math.round(amount * 100)}
        tabIndex={0}
        className="relative mx-auto aspect-square w-full max-w-28 touch-none rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(128,128,128,1) 0%, rgba(128,128,128,0) 70%), conic-gradient(from 90deg, #f00, #f0f, #00f, #0ff, #0f0, #ff0, #f00)' }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setFrom(e);
        }}
        onPointerMove={(e) => e.buttons && setFrom(e)}
        onDoubleClick={() => onChange({ r: mean, g: mean, b: mean })}
      >
        <span className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-black bg-white" style={{ left: `${dot.x}%`, top: `${dot.y}%` }} />
      </div>
      <div className="text-[10px] text-fog-300">{label}</div>
      <input type="range" aria-label={`${label} level`} className="w-full" min={-0.5} max={0.5} step={0.01} value={mean} onChange={(e) => {
        const m = Number(e.target.value);
        onChange({ r: round(off.r + m), g: round(off.g + m), b: round(off.b + m) });
      }} />
    </div>
  );
}
const round = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 1000) / 1000;

function ReplaceEditor({ reps, onChange, mask, onPick, onTrackMask }: { reps: ColorReplace[]; onChange: (r: ColorReplace[]) => void; mask?: EditMask | null; onPick?: (target: string) => void; onTrackMask?: (m: EditMask) => Promise<EditMask | null> }) {
  const [tracking, setTracking] = useState<string | null>(null);
  const upd = (id: string, patch: Partial<ColorReplace>) => onChange(reps.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2.5">
      <p className="text-[11px] text-fog-400">Change one colour without touching the rest — e.g. a red jacket to blue. Pick the colour on the video, choose the new one, tune the range. To change only one object, draw it with the selection tools and limit the replacement to it; track it if it moves.</p>
      {reps.map((r) => (
        <div key={r.id} className="space-y-2 rounded-xl border hairline p-2.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="size-6 rounded-md border hairline" style={{ background: r.from }} />
            {onPick && <Button size="sm" variant="ghost" onClick={() => onPick(`${r.id}:from`)}><Pipette /> Pick</Button>}
            <span className="text-fog-400">→</span>
            <input type="color" aria-label="New colour" value={r.to} onChange={(e) => upd(r.id, { to: e.target.value.toUpperCase() })} className="h-7 w-9 rounded border-0 bg-transparent" />
            <span className="flex-1" />
            <button type="button" aria-label="Remove replacement" className="text-fog-400 hover:text-signal-red" onClick={() => onChange(reps.filter((x) => x.id !== r.id))}><Trash2 className="size-3.5" /></button>
          </div>
          {(['range', 'softness', 'strength'] as const).map((k) => (
            <label key={k} className="block text-fog-300">
              <span className="flex justify-between">{{ range: 'Colour range', softness: 'Edge softness', strength: 'Strength' }[k]}<span className="tabular-nums">{r[k].toFixed(2)}</span></span>
              <input type="range" className="w-full" min={k === 'range' ? 0.02 : 0} max={1} step={0.01} value={r[k]} onChange={(e) => upd(r.id, { [k]: Number(e.target.value) })} />
            </label>
          ))}
          <label className="flex items-center gap-2 text-fog-300"><input type="checkbox" checked={r.keepLightness} onChange={(e) => upd(r.id, { keepLightness: e.target.checked })} /> Keep the original shading</label>
          <div className="flex flex-wrap items-center gap-1.5">
            {r.mask ? (
              <>
                <span className="rounded-md bg-iris-500/20 px-2 py-0.5 text-iris-100">Only inside the selected area{r.mask.track ? ` · tracked (${r.mask.track.points.length} frames)` : ''}</span>
                <Button size="sm" variant="ghost" onClick={() => upd(r.id, { mask: undefined })}>Whole frame</Button>
                {onTrackMask && !r.mask.track && (
                  <Button size="sm" variant="secondary" loading={tracking === r.id} onClick={async () => {
                    setTracking(r.id);
                    try {
                      const m = await onTrackMask(r.mask!);
                      if (m) upd(r.id, { mask: m });
                    } finally {
                      setTracking(null);
                    }
                  }}><Crosshair /> Track the object</Button>
                )}
              </>
            ) : (
              <Button size="sm" variant="ghost" disabled={!mask || maskIsEmpty(mask)} title={!mask || maskIsEmpty(mask) ? 'Draw an area on the video first (AI edit / Comments selection tools)' : undefined} onClick={() => upd(r.id, { mask: mask! })}>Limit to the selected area</Button>
            )}
          </div>
        </div>
      ))}
      {reps.length < 4 && (
        <Button size="sm" variant="secondary" onClick={() => onChange([...reps, { id: `rep${Date.now().toString(36)}`, from: '#C82028', to: '#2050D0', range: 0.25, softness: 0.5, keepLightness: true, strength: 1 }])}><Plus /> Add colour replacement</Button>
      )}
    </div>
  );
}

function Looks({ grade, onApply, onLut, otherShots, onMatchFrom }: { grade: GradeSettings; onApply: (g: Partial<GradeSettings>) => void; onLut: (l: GradeSettings['lut']) => void; otherShots?: { label: string; adjust?: Partial<GradeSettings> }[]; onMatchFrom?: (a: Partial<GradeSettings> | undefined) => void }) {
  const [presets, setPresets] = useState(loadPresets);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const save = () => {
    const name = `My look ${presets.length + 1}`;
    const next = [...presets, { name, grade: { ...grade, replace: undefined, lut: undefined } }];
    setPresets(next);
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
    toast.success(`Saved “${name}” in this browser`);
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5">
        {LOOKS.map((l) => {
          const on = lookActive(l.grade, grade as unknown as Record<string, unknown>);
          return (
            <button key={l.key} type="button" aria-pressed={on} onClick={() => onApply(l.grade)} className={cn('flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-[11px] hover:border-white/25', on ? 'border-iris-400 bg-iris-500/15 text-white' : 'hairline text-fog-100')}>
              <span aria-hidden className="h-4 w-6 shrink-0 rounded" style={{ background: lookSwatch(l.grade) }} />
              <span className="truncate">{l.label}</span>
            </button>
          );
        })}
      </div>
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => <button key={p.name} type="button" onClick={() => onApply(p.grade)} className="rounded-full border border-iris-400/40 px-2.5 py-1 text-[11px] text-iris-100">{p.name}</button>)}
        </div>
      )}
      <Button size="sm" variant="ghost" onClick={save}><Plus /> Save current as a preset</Button>
      <Field label="Custom LUT (.cube)">
        <input
          ref={file}
          type="file"
          accept=".cube"
          className="hidden"
          onChange={async (e) => {
            const fl = e.target.files?.[0];
            e.target.value = '';
            if (!fl) return;
            setBusy(true);
            try {
              const r = await api<{ lut: { assetId: string; size: number } }>('/api/luts', { body: { name: fl.name, cube: await fl.text() } });
              onLut({ assetId: r.lut.assetId, strength: 1 });
              toast.success(`LUT imported (${r.lut.size}³)`);
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Could not read that LUT');
            } finally {
              setBusy(false);
            }
          }}
        />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" loading={busy} onClick={() => file.current?.click()}><Upload /> Import .cube</Button>
          {grade.lut && (
            <>
              <input type="range" aria-label="LUT strength" className="flex-1" min={0} max={1} step={0.05} value={grade.lut.strength} onChange={(e) => onLut({ ...grade.lut!, strength: Number(e.target.value) })} />
              <Button size="sm" variant="ghost" onClick={() => onLut(undefined)}>Remove</Button>
            </>
          )}
        </div>
      </Field>
      {otherShots && onMatchFrom && otherShots.length > 0 && (
        <Field label="Match colour to another shot">
          <NativeSelect defaultValue="" onChange={(e) => e.target.value !== '' && onMatchFrom(otherShots[Number(e.target.value)]?.adjust)}>
            <option value="">Choose a shot…</option>
            {otherShots.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
          </NativeSelect>
        </Field>
      )}
    </div>
  );
}
