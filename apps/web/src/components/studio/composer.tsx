'use client';

import { useEffect, useMemo, useState } from 'react';
import { CastPicker } from '@/components/studio/cast-picker';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Coins, Info, Settings2, Sparkles, Volume2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  ASPECT_RATIOS,
  CAMERA_PRESETS,
  COLOR_GRADES,
  LENSES,
  LIGHTING_PRESETS,
  MOODS,
  QUALITY_MODE_INFO,
  QUALITY_MODES,
  SHOT_TYPES,
  STYLE_PRESETS,
  type AspectRatio,
  type QualityMode,
  type VideoSpecInput,
} from '@framecraft/shared';
import { api, endpoints, ApiError, type Asset, type GenerationEstimate } from '@/lib/api';
import { useMe, useModels } from '@/lib/hooks';
import { Badge, Button, Card, Dialog, Field, Input, NativeSelect, Segmented, Switch, Textarea } from '@/components/ui';
import { ImageSlot } from './upload';
import { cn, formatCredits, newKey } from '@/lib/utils';

export type ComposerInitial = Partial<VideoSpecInput> & { prompt?: string };

const DURATIONS = [5, 8, 10, 15, 20];
const ASPECT_LABEL: Record<AspectRatio, string> = { '9:16': '9:16 Vertical', '16:9': '16:9 Wide', '1:1': '1:1 Square', '4:5': '4:5 Feed' };

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function EstimatePanel({ estimate, loading }: { estimate?: GenerationEstimate; loading: boolean }) {
  if (!estimate) return <div className="skeleton h-24 rounded-2xl" />;
  const seg = estimate.segments[0];
  return (
    <div className={cn('rounded-2xl border p-4 transition-opacity', estimate.ok ? 'hairline bg-white/[0.02]' : 'border-signal-red/30 bg-signal-red/[0.05]', loading && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-fog-400">Estimate</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums text-white">{formatCredits(estimate.credits)}</span>
            <span className="text-sm text-fog-300">credits</span>
          </div>
        </div>
        {seg && (
          <div className="text-right">
            <div className="text-sm font-medium text-white">{seg.modelName.replace(/ \(via .*\)/, '')}</div>
            <div className="text-xs text-fog-400">
              {seg.resolution} · {estimate.segments.length > 1 ? `${estimate.segments.length} clips` : `${seg.billedDurationSec}s`}
              {seg.nativeAudio ? ' · audio' : ''}
            </div>
          </div>
        )}
      </div>
      {!!estimate.blockers?.length && (
        <div className="mt-3 space-y-1.5">
          {estimate.blockers.map((b) => (
            <div key={b} className="flex gap-2 text-sm text-signal-red">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {b}
            </div>
          ))}
        </div>
      )}
      {estimate.ok && !estimate.liveGenerationAvailable && (
        <div className="mt-3 flex gap-2 rounded-xl bg-signal-amber/10 p-2.5 text-xs text-signal-amber">
          <Info className="mt-0.5 size-3.5 shrink-0" /> Live generation is not configured, so this will run as a free, labelled test fixture. The estimate shows what the real generation would cost.
        </div>
      )}
      <details className="mt-3 text-xs text-fog-300">
        <summary className="cursor-pointer select-none text-fog-400 hover:text-fog-200">Why this model?</summary>
        <ul className="mt-2 space-y-1">
          {estimate.explanation.map((e) => (
            <li key={e}>• {e}</li>
          ))}
          {estimate.warnings.map((w) => (
            <li key={w} className="text-signal-amber/90">• {w}</li>
          ))}
        </ul>
        {estimate.alternatives.length > 0 && (
          <div className="mt-2">
            <div className="text-fog-400">Alternatives</div>
            {estimate.alternatives.map((a) => (
              <div key={a.modelKey} className="flex justify-between gap-2">
                <span>{a.modelName.replace(/ \(via .*\)/, '')} — {a.reason}</span>
                <span className="tabular-nums">{formatCredits(a.credits)}</span>
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}

export function VideoComposer({
  initial,
  projectKind = 'quick',
  templateKey,
  projectId: fixedProjectId,
  advancedDefault = false,
  cinematic = false,
  title,
  onCreated,
}: {
  initial?: ComposerInitial;
  projectKind?: 'quick' | 'social' | 'cinematic';
  templateKey?: string;
  projectId?: string;
  advancedDefault?: boolean;
  cinematic?: boolean;
  title?: string;
  onCreated: (jobId: string, projectId: string, aspect: AspectRatio) => void;
}) {
  const { data: me } = useMe();
  const { data: modelData } = useModels();
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [aspectRatio, setAspect] = useState<AspectRatio>((initial?.aspectRatio as AspectRatio) ?? '9:16');
  const [durationSec, setDuration] = useState(initial?.durationSec ?? 10);
  const [quality, setQuality] = useState<QualityMode>(initial?.quality ?? 'balanced');
  const [style, setStyle] = useState(initial?.style ?? 'auto');
  const [camera, setCamera] = useState(initial?.camera ?? '');
  const [lighting, setLighting] = useState('');
  const [lens, setLens] = useState('');
  const [colorGrade, setGrade] = useState('');
  const [mood, setMood] = useState('');
  const [shotType, setShotType] = useState('');
  // Social videos are expected to have sound, so it is on unless a template/studio says otherwise.
  const [nativeAudio, setAudio] = useState(initial?.nativeAudio ?? true);
  const [enhancePrompt, setEnhance] = useState(true);
  const [modelKey, setModelKey] = useState('');
  const [resolution, setResolution] = useState('');
  const [negativePrompt, setNegative] = useState('');
  const [renderPass, setPass] = useState<'final' | 'draft'>('final');
  const [image, setImage] = useState<Asset | null>(null);
  const [endImage, setEndImage] = useState<Asset | null>(null);
  const [refs, setRefs] = useState<(Asset | null)[]>([null, null, null]);
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(advancedDefault);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const spec: VideoSpecInput = useMemo(
    () => ({
      prompt: prompt.trim() || 'A beautiful cinematic scene',
      aspectRatio,
      durationSec,
      quality,
      style: style === 'auto' ? undefined : style,
      camera: camera || undefined,
      lighting: lighting || undefined,
      lens: lens || undefined,
      colorGrade: colorGrade || undefined,
      mood: mood || undefined,
      shotType: shotType || undefined,
      nativeAudio,
      enhancePrompt,
      modelKey: modelKey || undefined,
      resolution: (resolution || undefined) as VideoSpecInput['resolution'],
      negativePrompt: negativePrompt || undefined,
      renderPass,
      imageAssetId: image?.id,
      endImageAssetId: image && endImage ? endImage.id : undefined,
      referenceAssetIds: refs.filter(Boolean).map((r) => r!.id),
      characterIds,
      locationIds,
    }),
    [prompt, aspectRatio, durationSec, quality, style, camera, lighting, lens, colorGrade, mood, shotType, nativeAudio, enhancePrompt, modelKey, resolution, negativePrompt, renderPass, image, endImage, refs, characterIds, locationIds],
  );
  const debounced = useDebounced(spec, 450);
  const est = useQuery({ queryKey: ['estimate', debounced], queryFn: () => endpoints.estimate(debounced), placeholderData: (p) => p, retry: false });
  const estimate = est.data?.estimate;
  const allowedQuality = me?.plan?.limits.qualityModes ?? QUALITY_MODES;
  const routableModels = (modelData?.models ?? []).filter((m) => m.routable);

  // Start within the plan: clamp a template/studio default the plan does not include.
  useEffect(() => {
    if (me?.plan && !me.plan.limits.qualityModes.includes(quality)) {
      const best = [...QUALITY_MODES].reverse().find((q) => me.plan!.limits.qualityModes.includes(q));
      if (best) setQuality(best);
    }
    if (me?.plan && durationSec > me.plan.limits.maxClipSeconds) setDuration(me.plan.limits.maxClipSeconds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.plan?.key]);

  const submit = async () => {
    if (prompt.trim().length < 3) {
      toast.error('Describe the video you want to create');
      return;
    }
    setBusy(true);
    try {
      let projectId = fixedProjectId;
      if (!projectId) {
        const p = await api<{ project: { id: string } }>('/api/projects', { body: { title: title ?? prompt.trim().slice(0, 70), kind: projectKind, aspectRatio, templateKey } });
        projectId = p.project.id;
      }
      const { job } = await endpoints.generate({ spec, projectId, templateKey, idempotencyKey: newKey(), confirmEstimate: true });
      await qc.invalidateQueries({ queryKey: ['me'] });
      onCreated(job.id, projectId, aspectRatio);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start generation');
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const onGenerate = () => {
    if (estimate?.liveGenerationAvailable && estimate.credits >= 500) setConfirmOpen(true);
    else void submit();
  };

  const canGenerate = Boolean(estimate?.ok) && prompt.trim().length >= 3;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-5">
        <Card className="p-3 md:p-4">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the video you want to create…"
            aria-label="Video description"
            className="min-h-32 border-0 bg-transparent px-2 text-[16px] focus:bg-transparent md:text-[17px]"
            maxLength={4000}
          />
          <div className="flex flex-wrap items-center gap-2 border-t hairline px-1 pt-3">
            <div className="w-16">
              <ImageSlot label="Start image" asset={image} onChange={setImage} projectId={fixedProjectId} />
            </div>
            {cinematic && image && (
              <div className="w-16">
                <ImageSlot label="End frame" asset={endImage} onChange={setEndImage} projectId={fixedProjectId} />
              </div>
            )}
            <div className="ml-auto flex items-center gap-2 text-xs text-fog-300">
              <Sparkles className="size-3.5 text-iris-300" /> Enhance prompt
              <Switch checked={enhancePrompt} onCheckedChange={setEnhance} label="Enhance prompt" />
            </div>
          </div>
        </Card>

        <Card className="p-3 md:p-4">
          <CastPicker characterIds={characterIds} locationIds={locationIds} onCharacters={setCharacterIds} onLocations={setLocationIds} />
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Format">
            <Segmented value={aspectRatio} onChange={setAspect} options={ASPECT_RATIOS.map((a) => ({ value: a, label: ASPECT_LABEL[a] }))} size="sm" />
          </Field>
          <Field label="Duration">
            <Segmented value={durationSec} onChange={setDuration} options={DURATIONS.filter((d) => d <= (me?.plan?.limits.maxClipSeconds ?? 60)).map((d) => ({ value: d, label: `${d}s` }))} size="sm" />
          </Field>
        </div>

        <div className="rounded-xl border hairline p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm text-fog-100">
              <Volume2 className="size-4 text-iris-300" /> Sound
              <span className="text-xs text-fog-400">{nativeAudio ? 'AI-generated sound, effects & speech' : 'Silent video (cheaper) — add music or voice-over in the editor'}</span>
            </span>
            <Switch checked={nativeAudio} onCheckedChange={setAudio} label="Generate sound" />
          </div>
          {/[Ⴀ-ჿЀ-ӿ]/.test(prompt) && (
            <p className="mt-2 text-xs text-signal-amber">
              AI video models speak only English or Chinese. For Georgian or Russian speech, generate the video, then use <span className="font-medium">Edit → Audio → Generate voice-over</span> (ElevenLabs supports Georgian) and export.
            </p>
          )}
        </div>

        <Field label="Quality">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {QUALITY_MODES.map((q) => {
              const locked = !allowedQuality.includes(q);
              return (
                <button
                  key={q}
                  type="button"
                  disabled={locked}
                  onClick={() => setQuality(q)}
                  className={cn('rounded-xl border p-3 text-left transition disabled:opacity-40', quality === q ? 'border-iris-500/60 bg-iris-500/10' : 'hairline hover:bg-white/[0.03]')}
                >
                  <div className="flex items-center justify-between text-sm font-medium text-white">
                    {QUALITY_MODE_INFO[q].label}
                    {q === 'balanced' && <Badge tone="iris">Default</Badge>}
                  </div>
                  <div className="mt-1 text-[11.5px] leading-snug text-fog-400">{locked ? 'Upgrade to unlock' : QUALITY_MODE_INFO[q].blurb}</div>
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Style">
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {STYLE_PRESETS.map((s) => (
              <button key={s.key} type="button" onClick={() => setStyle(s.key)} className={cn('shrink-0 rounded-full border px-3.5 py-1.5 text-[13px] transition', style === s.key ? 'border-iris-500/60 bg-iris-500/15 text-white' : 'hairline text-fog-300 hover:text-white')}>
                {s.label}
              </button>
            ))}
          </div>
        </Field>

        <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-2 text-sm text-fog-300 hover:text-white" aria-expanded={advanced}>
          <Settings2 className="size-4" /> {cinematic ? 'Camera, lens & model controls' : 'Advanced settings'}
          <ChevronDown className={cn('size-4 transition', advanced && 'rotate-180')} />
        </button>

        {advanced && (
          <Card className="grid gap-4 p-4 md:grid-cols-2 md:p-5">
            <Field label="Camera move" hint="Uses a real camera-control API when the model has one; otherwise added to the prompt.">
              <NativeSelect value={camera} onChange={(e) => setCamera(e.target.value)}>
                <option value="">Automatic</option>
                {CAMERA_PRESETS.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Shot type">
              <NativeSelect value={shotType} onChange={(e) => setShotType(e.target.value)}>
                <option value="">Automatic</option>
                {SHOT_TYPES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Lighting">
              <NativeSelect value={lighting} onChange={(e) => setLighting(e.target.value)}>
                <option value="">Automatic</option>
                {LIGHTING_PRESETS.map((l) => (
                  <option key={l.key} value={l.key}>{l.label}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Lens">
              <NativeSelect value={lens} onChange={(e) => setLens(e.target.value)}>
                <option value="">Automatic</option>
                {LENSES.map((l) => (
                  <option key={l.key} value={l.key}>{l.label}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Color grade">
              <NativeSelect value={colorGrade} onChange={(e) => setGrade(e.target.value)}>
                {COLOR_GRADES.map((g) => (
                  <option key={g.key} value={g.key === 'none' ? '' : g.key}>{g.label}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Mood">
              <NativeSelect value={mood} onChange={(e) => setMood(e.target.value)}>
                <option value="">Automatic</option>
                {MOODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Model" hint="Automatic picks the cheapest model that meets your quality target.">
              <NativeSelect value={modelKey} onChange={(e) => setModelKey(e.target.value)} disabled={me?.plan?.key === 'free'}>
                <option value="">Automatic (recommended)</option>
                {routableModels.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.displayName} — from ${m.fromUsdPerSecond.toFixed(2)}/s
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Minimum resolution" hint="Never downgraded below this.">
              <NativeSelect value={resolution} onChange={(e) => setResolution(e.target.value)}>
                <option value="">Mode default</option>
                {['720p', '1080p', '1440p', '4k'].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Render pass" hint="Draft = cheap low-res preview to check composition first.">
              <Segmented value={renderPass} onChange={setPass} options={[{ value: 'final', label: 'Final' }, { value: 'draft', label: 'Cheap draft' }]} size="sm" />
            </Field>
            <Field label="Avoid (negative prompt)">
              <Input value={negativePrompt} onChange={(e) => setNegative(e.target.value)} placeholder="blur, distorted hands, text" />
            </Field>
            <Field label="Reference images" hint="Used by reference-capable models for consistency.">
              <div className="grid grid-cols-3 gap-2">
                {refs.map((r, i) => (
                  <ImageSlot key={i} label={`Ref ${i + 1}`} asset={r} onChange={(a) => setRefs((prev) => prev.map((x, j) => (j === i ? a : x)))} />
                ))}
              </div>
            </Field>
          </Card>
        )}
      </div>

      <div className="xl:sticky xl:top-20 xl:self-start">
        <div className="space-y-3">
          <EstimatePanel estimate={estimate} loading={est.isFetching} />
          {est.error && <p className="text-sm text-signal-red">{(est.error as Error).message}</p>}
          <Button size="xl" className="w-full" onClick={onGenerate} disabled={!canGenerate} loading={busy}>
            <Wand2 /> Generate{estimate?.liveGenerationAvailable ? ` · ${formatCredits(estimate.credits)} credits` : ' test fixture'}
          </Button>
          <p className="flex items-center justify-center gap-1.5 text-center text-xs text-fog-400">
            <Coins className="size-3.5" /> Credits are reserved now and settled at the real cost. Failed jobs are refunded.
          </p>
        </div>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Confirm generation"
        description={`This will use about ${formatCredits(estimate?.credits)} credits.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy}>Generate</Button>
          </>
        }
      >
        <p className="text-sm text-fog-300">You approve spending up to {formatCredits(estimate?.credits)} credits for this video. If the provider’s real cost is lower, you’ll be charged less.</p>
      </Dialog>
    </div>
  );
}
