'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Crop, Download, Info, RefreshCw, Shuffle, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { AI_EDIT_MODES, CAMERA_MOVES, type AdConcept, type AdPlan, type AdScene, type DiversityReport } from '@framecraft/shared';
import { api, ApiError } from '@/lib/api';
import { useJob } from '@/lib/hooks';
import { Badge, Button, Card, Input, NativeSelect, Skeleton, Textarea, buttonVariants } from '@/components/ui';
import { ProgressBar } from '@/components/studio/progress';
import { cn, seconds } from '@/lib/utils';

type Segment = { id: string; assetId: string; index: number; startSec: number; endSec: number; frameUrl: string | null; sourceName: string | null; description: string; tags: string[]; scores: Record<string, number>; metrics: Record<string, number>; duplicateOf: string | null };
type Estimate = { voice: number; music: number; enhance: number; assembleTotal: number; voiceAvailable: boolean; musicAvailable: boolean; note: string; budget?: number | null; withinBudget?: boolean };
type Campaign = { id: string; title: string; status: string; phase: string | null; progress: number | null; error: string | null; concepts: AdConcept[] | null; review: { diversity?: DiversityReport } | null; brief: { mode: 'original' | 'enhanced'; language: string; aspectRatio: string; lengthSec: number; conceptKey?: string }; plan: (AdPlan & { estimate?: Estimate; renderJobId?: string; source?: string }) | null; projectId: string | null; variants: { projectId: string; label: string; aspectRatio: string; lengthSec: number; language: string; renderJobId?: string }[] };

const BUSY = ['analyzing', 'planning', 'assembling'];

export default function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useQuery({ queryKey: ['campaign', id], queryFn: () => api<{ campaign: Campaign; segments: Segment[] }>(`/api/ads/campaigns/${id}`), refetchInterval: (qq) => (qq.state.data && (BUSY.includes(qq.state.data.campaign.status) || qq.state.data.campaign.status === 'ready') ? 3000 : false) });
  const [plan, setPlan] = useState<AdPlan | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const c = q.data?.campaign;
  const segs = q.data?.segments ?? [];
  useEffect(() => {
    if (c?.plan && !dirty) setPlan(c.plan);
  }, [c?.plan, dirty]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      await q.refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };
  if (!c) return <Skeleton className="mx-auto h-[60dvh] max-w-5xl" />;
  const est = c.plan?.estimate;
  const seg = (sid: string) => segs.find((s) => s.id === sid);
  const editScene = (i: number, patch: Partial<AdScene>) => {
    setPlan((p) => (p ? { ...p, scenes: p.scenes.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : p));
    setDirty(true);
  };
  const moveScene = (i: number, d: -1 | 1) => {
    setPlan((p) => {
      if (!p) return p;
      const sc = [...p.scenes];
      const j = i + d;
      if (j < 0 || j >= sc.length) return p;
      [sc[i], sc[j]] = [sc[j]!, sc[i]!];
      return { ...p, scenes: sc };
    });
    setDirty(true);
  };
  const total = plan?.scenes.reduce((s, x) => s + x.durationSec, 0) ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/app/ads/campaigns" className="text-xs text-fog-400 hover:text-white">← Creative Studio</Link>
          <h1 className="mt-1 text-xl font-semibold text-white">{c.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fog-300">
            <Badge tone={c.status === 'ready' ? 'green' : c.status === 'failed' ? 'red' : 'iris'}>{c.status}</Badge>
            <span>{c.brief.mode === 'original' ? 'Original footage only' : 'AI-enhanced (reviewed)'} · {c.brief.aspectRatio} · {c.brief.lengthSec} s · {c.brief.language.toUpperCase()}</span>
          </div>
        </div>
        {c.projectId && (
          <Link href={`/app/editor/${c.projectId}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Open in editor</Link>
        )}
      </div>

      {BUSY.includes(c.status) && <Card className="p-4"><ProgressBar progress={c.progress} label={c.phase} /></Card>}
      {c.status === 'failed' && <Card className="border-signal-red/40 p-4 text-sm text-signal-red">{c.error ?? c.phase}</Card>}

      {/* Footage catalog */}
      {segs.length > 0 && (
        <Card className="p-4">
          <div className="mb-3 text-sm font-medium text-white">Footage analysis · {segs.length} moments</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {segs.map((s) => (
              <figure key={s.id} className={cn('overflow-hidden rounded-xl border hairline bg-ink-900', s.duplicateOf && 'opacity-60')} title={s.description}>
                {s.frameUrl ? <img src={s.frameUrl} alt="" className="aspect-video w-full object-cover" /> : <div className="aspect-video bg-ink-800" />}
                <figcaption className="space-y-0.5 p-1.5 text-[10px] text-fog-300">
                  <div className="truncate text-fog-100">{s.sourceName ?? 'file'} · {seconds(s.startSec)}–{seconds(s.endSec)}</div>
                  <div className="line-clamp-2">{s.description || 'No description'}</div>
                  <div className="flex items-center gap-1">
                    <span className="h-1 flex-1 rounded bg-white/10"><span className="block h-1 rounded bg-iris-400" style={{ width: `${(s.scores.overall ?? 0) * 100}%` }} /></span>
                    {s.duplicateOf && <span className="text-signal-amber">dup</span>}
                    {(s.metrics.shake ?? 0) > 0.5 && <span className="text-signal-amber">shaky</span>}
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        </Card>
      )}

      {/* Creative concepts */}
      {(c.concepts?.length ?? 0) > 0 && (
        <Card className="space-y-3 p-4">
          <div className="text-sm font-medium text-white">Creative concepts</div>
          <div className="grid gap-3 md:grid-cols-3">
            {c.concepts!.map((k) => {
              const chosen = (plan?.conceptKey || c.plan?.conceptKey) === k.key;
              return (
                <div key={k.key} className={cn('flex flex-col rounded-xl border p-3', chosen ? 'border-iris-400 bg-iris-500/10' : 'hairline')}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-white">{k.name}</div>
                    {k.recommended && <Badge tone="iris">recommended</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-fog-200">{k.logline}</p>
                  <p className="mt-2 line-clamp-4 text-[11px] text-fog-400">{k.treatment}</p>
                  <ol className="mt-2 space-y-0.5 text-[11px] text-fog-300">
                    {k.beats.map((b) => <li key={b.beat}><span className="mr-1 font-medium uppercase text-fog-500">{b.beat}</span>{b.idea}</li>)}
                  </ol>
                  <div className="mt-2 text-[10px] text-fog-500">{k.pacing} · {k.music}</div>
                  <div className="mt-auto pt-3">
                    {chosen ? <span className="flex items-center gap-1 text-xs text-signal-green"><CheckCircle2 className="size-3.5" /> Storyboard below</span> : <Button size="sm" variant="secondary" disabled={BUSY.includes(c.status)} loading={busy === `concept-${k.key}`} onClick={() => run(`concept-${k.key}`, () => api(`/api/ads/campaigns/${id}/concept`, { body: { key: k.key } }).then(() => setDirty(false)), 'Storyboarding this concept…')}>Use this concept</Button>}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {c.review?.diversity && plan && !dirty && <DiversityPanel r={c.review.diversity} busy={busy} onOption={(key) => run(`opt-${key}`, () => api(`/api/ads/campaigns/${id}/review-option`, { body: { key } }), key === 'shorter' ? 'Re-cutting a shorter ad…' : 'Keeping the length with detail crops')} />}

      {/* Storyboard */}
      {plan && (
        <Card className="space-y-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-2xl text-sm">
              <div className="font-medium text-white">Storyboard · {plan.scenes.length} shots · {seconds(total)}</div>
              <p className="mt-1 text-xs text-fog-300"><b className="text-fog-100">Hook:</b> {plan.hook} · <b className="text-fog-100">Story:</b> {plan.narrative}</p>
              {c.plan?.source === 'offline' && <p className="mt-1 text-xs text-signal-amber">Planned without the AI Director (not configured) — review the choices.</p>}
              {plan.notes.map((n) => <p key={n} className="text-xs text-fog-400">• {n}</p>)}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" loading={busy === 'replan'} onClick={() => run('replan', () => api(`/api/ads/campaigns/${id}/replan`, { body: { scope: 'all' } }).then(() => setDirty(false)), 'Re-planning…')}><RefreshCw /> Re-plan</Button>
              <Button size="sm" variant="secondary" disabled={!dirty} loading={busy === 'save'} onClick={() => run('save', async () => { await api(`/api/ads/campaigns/${id}/plan`, { method: 'PUT', body: { plan } }); setDirty(false); }, 'Plan saved')}>Save changes</Button>
            </div>
          </div>
          <div className="space-y-2">
            {plan.scenes.map((sc, i) => {
              const s = seg(sc.segmentId);
              return (
                <div key={sc.id} className="grid gap-2 rounded-xl border hairline p-2 md:grid-cols-[120px_1fr_1fr_auto]">
                  <div>
                    {s?.frameUrl && <img src={s.frameUrl} alt="" className="aspect-video w-full rounded-lg object-cover" />}
                    <div className="mt-1 text-[10px] text-fog-400">{i + 1} · {sc.role} · {seconds(plan.scenes.slice(0, i).reduce((t, x) => t + x.durationSec, 0))}</div>
                    {sc.purpose && <div className="line-clamp-2 text-[10px] text-fog-500">{sc.purpose}</div>}
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <NativeSelect value={sc.segmentId} onChange={(e) => editScene(i, { segmentId: e.target.value, inSec: 0 })}>
                      {segs.map((x) => <option key={x.id} value={x.id}>{x.sourceName ?? 'file'} {seconds(x.startSec)}–{seconds(x.endSec)} · {(x.description || '').slice(0, 40)}</option>)}
                    </NativeSelect>
                    <div className="grid grid-cols-2 gap-1.5">
                      <label className="text-fog-400">Start in clip <Input type="number" step={0.1} min={0} value={sc.inSec} onChange={(e) => editScene(i, { inSec: Number(e.target.value) })} /></label>
                      <label className="text-fog-400">Duration <Input type="number" step={0.1} min={0.5} max={12} value={sc.durationSec} onChange={(e) => editScene(i, { durationSec: Number(e.target.value) })} /></label>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <NativeSelect aria-label="Framing" value={sc.framing ?? ''} onChange={(e) => editScene(i, { framing: (e.target.value || null) as AdScene['framing'] })}><option value="">framing</option>{['wide', 'medium', 'close', 'macro', 'detail'].map((x) => <option key={x}>{x}</option>)}</NativeSelect>
                      <NativeSelect aria-label="Camera" value={sc.camera ?? ''} onChange={(e) => editScene(i, { camera: (e.target.value || null) as AdScene['camera'] })}><option value="">style camera</option>{CAMERA_MOVES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</NativeSelect>
                      <NativeSelect aria-label="Transition" value={sc.transition} onChange={(e) => editScene(i, { transition: e.target.value as AdScene['transition'] })}>{['cut', 'fade', 'dissolve', 'fadeblack'].map((x) => <option key={x}>{x}</option>)}</NativeSelect>
                    </div>
                    {(sc.lighting || sc.sound || sc.crop) && (
                      <div className="flex flex-wrap gap-x-3 text-[10px] text-fog-400">
                        {sc.lighting && <span>Light: {sc.lighting}</span>}
                        {sc.sound && <span>Sound: {sc.sound}</span>}
                        {sc.crop && <button type="button" className="flex items-center gap-1 text-iris-200 hover:text-white" title="Detail crop of the source — remove to show the full frame" onClick={() => editScene(i, { crop: null })}><Crop className="size-3" /> detail crop ×{sc.crop.scale.toFixed(1)}</button>}
                      </div>
                    )}
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex gap-1.5">
                      <NativeSelect className="w-32" value={sc.overlay?.kind ?? 'none'} onChange={(e) => editScene(i, { overlay: e.target.value === 'none' ? null : { text: sc.overlay?.text ?? 'Text', kind: e.target.value as NonNullable<AdScene['overlay']>['kind'] } })}>{['none', 'title', 'lower_third', 'caption', 'price', 'cta'].map((x) => <option key={x}>{x}</option>)}</NativeSelect>
                      {sc.overlay && <Input value={sc.overlay.text} maxLength={120} onChange={(e) => editScene(i, { overlay: { ...sc.overlay!, text: e.target.value || ' ' } })} />}
                    </div>
                    {c.brief.mode === 'enhanced' && (
                      <div className="rounded-lg bg-iris-500/5 p-1.5">
                        <NativeSelect value={sc.enhance?.mode ?? 'none'} onChange={(e) => editScene(i, { enhance: e.target.value === 'none' ? null : { mode: e.target.value as NonNullable<AdScene['enhance']>['mode'], instruction: sc.enhance?.instruction ?? 'Softer, warmer light on the background' } })}>
                          <option value="none">No AI change (real footage)</option>
                          {AI_EDIT_MODES.filter((m) => m.scope === 'range').map((m) => <option key={m.key} value={m.key}>AI {m.label}</option>)}
                        </NativeSelect>
                        {sc.enhance && <Textarea rows={2} className="mt-1" value={sc.enhance.instruction} maxLength={500} onChange={(e) => editScene(i, { enhance: { ...sc.enhance!, instruction: e.target.value } })} />}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1 md:flex-col">
                    <Button size="icon" variant="ghost" aria-label="Move up" onClick={() => moveScene(i, -1)}><ArrowUp /></Button>
                    <Button size="icon" variant="ghost" aria-label="Move down" onClick={() => moveScene(i, 1)}><ArrowDown /></Button>
                    <Button size="icon" variant="ghost" aria-label="Swap for other footage" title="Swap for the best unused footage" onClick={() => run('swap', async () => { await api(`/api/ads/campaigns/${id}/replan`, { body: { scope: 'scene', sceneIndex: i } }); setDirty(false); })}><Shuffle /></Button>
                    <Button size="icon" variant="ghost" aria-label="Remove shot" disabled={plan.scenes.length < 2} onClick={() => { setPlan({ ...plan, scenes: plan.scenes.filter((_, j) => j !== i), voiceover: plan.voiceover.map((v) => ({ ...v, sceneIndex: Math.min(Math.max(0, plan.scenes.length - 2), v.sceneIndex > i ? v.sceneIndex - 1 : v.sceneIndex) })) }); setDirty(true); }}><Trash2 /></Button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-fog-200">Voice-over ({c.brief.language.toUpperCase()})</div>
              {plan.voiceover.map((v, i) => (
                <div key={i} className="flex gap-1.5">
                  <NativeSelect className="w-20" value={v.sceneIndex} onChange={(e) => { setPlan({ ...plan, voiceover: plan.voiceover.map((x, j) => (j === i ? { ...x, sceneIndex: Number(e.target.value) } : x)) }); setDirty(true); }}>{plan.scenes.map((_, k) => <option key={k} value={k}>shot {k + 1}</option>)}</NativeSelect>
                  <Input value={v.text} maxLength={400} onChange={(e) => { setPlan({ ...plan, voiceover: plan.voiceover.map((x, j) => (j === i ? { ...x, text: e.target.value || ' ' } : x)) }); setDirty(true); }} />
                </div>
              ))}
              {!plan.voiceover.length && <p className="text-xs text-fog-400">No voice-over.</p>}
            </div>
            <div className="space-y-1.5 text-xs">
              <label className="block text-fog-200">Call to action <Input value={plan.cta} maxLength={120} onChange={(e) => { setPlan({ ...plan, cta: e.target.value }); setDirty(true); }} /></label>
              <label className="block text-fog-200">Music direction <Input value={plan.musicMood} maxLength={200} onChange={(e) => { setPlan({ ...plan, musicMood: e.target.value }); setDirty(true); }} /></label>
            </div>
          </div>
          {est && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/[0.03] p-3 text-xs text-fog-300">
              <div>
                <div className="text-sm text-white">Cost to assemble: {est.assembleTotal} credits</div>
                <div>Voice-over {est.voice} {est.voiceAvailable ? '' : '(provider not configured)'} · music {est.music} {est.musicAvailable ? '' : '(provider not configured)'}{c.brief.mode === 'enhanced' ? ` · AI enhancements later: ${est.enhance}` : ''}</div>
                <div className="text-fog-400">{est.note}</div>
                {est.budget != null && <div className={est.withinBudget ? 'text-signal-green' : 'text-signal-red'}>Budget for this ad: {est.budget} credits{est.withinBudget ? '' : ' — this exceeds it; raise the budget or remove voice/music'}</div>}
              </div>
              <Button disabled={dirty || BUSY.includes(c.status)} loading={busy === 'assemble'} onClick={() => run('assemble', () => api(`/api/ads/campaigns/${id}/assemble`, { body: { approvedCredits: est.assembleTotal } }), 'Assembling your ad…')}><Wand2 /> {c.projectId ? 'Re-assemble' : 'Assemble the ad'} · {est.assembleTotal} cr</Button>
            </div>
          )}
          {dirty && <p className="text-xs text-signal-amber">Save your changes before assembling.</p>}
        </Card>
      )}

      {c.projectId && c.status === 'ready' && (
        <Card className="space-y-4 p-4">
          <div className="text-sm font-medium text-white">Your ad</div>
          <p className="text-xs text-fog-300">{c.phase}</p>
          {c.plan?.renderJobId && <RenderResult jobId={c.plan.renderJobId} label="Main" />}
          <div className="flex flex-wrap gap-2">
            <Link href={`/app/editor/${c.projectId}`} className={buttonVariants({ size: 'sm' })}>Edit anything in the editor</Link>
            {c.brief.mode === 'enhanced' && est && est.enhance > 0 && (
              <Button size="sm" variant="secondary" loading={busy === 'enhance'} onClick={() => run('enhance', () => api(`/api/ads/campaigns/${id}/enhance`, { body: { approvedCredits: est.enhance } }), 'AI enhancements started — review them in the editor (Review)')}><Sparkles /> Run AI enhancements · {est.enhance} cr</Button>
            )}
          </div>
          <div>
            <div className="mb-2 text-xs font-medium text-fog-200">Variants (same footage and edits; only voice is re-recorded for another language)</div>
            <div className="flex flex-wrap gap-1.5">
              {[{ aspectRatio: '9:16' }, { aspectRatio: '1:1' }, { aspectRatio: '16:9' }, { aspectRatio: '4:5' }, { lengthSec: 10 }, { lengthSec: 15 }, { lengthSec: 30 }, { language: 'en' }, { language: 'ru' }, { language: 'ka' }].filter((v) => !('aspectRatio' in v) || v.aspectRatio !== c.brief.aspectRatio).filter((v) => !('language' in v) || v.language !== c.brief.language).map((v) => (
                <Button key={JSON.stringify(v)} size="sm" variant="ghost" loading={busy === JSON.stringify(v)} onClick={() => run(JSON.stringify(v), () => api(`/api/ads/campaigns/${id}/variants`, { body: v }), 'Making the variant…')}>
                  {'aspectRatio' in v ? v.aspectRatio : 'lengthSec' in v ? `${v.lengthSec} s cut` : (v.language ?? '').toUpperCase()}
                </Button>
              ))}
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {c.variants.map((v) => (
                <div key={v.projectId} className="rounded-xl border hairline p-2">
                  <div className="mb-1 flex items-center justify-between text-xs text-fog-200">{v.label}<Link className="text-iris-200 hover:text-white" href={`/app/editor/${v.projectId}`}>Edit</Link></div>
                  {v.renderJobId && <RenderResult jobId={v.renderJobId} label={v.label} />}
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function RenderResult({ jobId, label }: { jobId: string; label: string }) {
  const { data } = useJob(jobId);
  const job = data?.job;
  if (!job) return null;
  if (job.status !== 'completed') return job.status === 'failed' ? <p className="text-xs text-signal-red">{job.error?.message}</p> : <ProgressBar progress={job.progress} etaSec={job.etaSec} label={job.phase} />;
  return (
    <div className="space-y-2">
      {job.outputUrl && <video src={job.outputUrl} controls playsInline className="max-h-[60dvh] rounded-xl bg-black" />}
      {job.outputUrl && <a href={job.outputUrl} download className={cn(buttonVariants({ variant: 'white', size: 'sm' }))}><Download /> Download {label}</a>}
    </div>
  );
}

function DiversityPanel({ r, busy, onOption }: { r: DiversityReport; busy: string | null; onOption: (key: 'shorter' | 'crops') => void }) {
  const tone = r.score >= 80 ? 'text-signal-green' : r.score >= 55 ? 'text-signal-amber' : 'text-signal-red';
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-white">Shot diversity review</div>
        <div className={cn('text-sm font-semibold', tone)}>{r.score}/100</div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fog-400">
        <span>{r.stats.scenes} shots from {r.stats.uniqueSources} source file{r.stats.uniqueSources === 1 ? '' : 's'}</span>
        <span>{r.stats.uniqueSegments} distinct moments</span>
        <span>avg {r.stats.avgShotSec} s per shot</span>
        <span>{r.stats.productShots} product shots</span>
        <span>{r.stats.usableFootageSec} s distinct footage for {r.stats.targetSec} s</span>
        {r.stats.reusedSeconds > 0 && <span>{r.stats.reusedSeconds} s reused as detail crops</span>}
      </div>
      {r.issues.length === 0 && <p className="flex items-center gap-1.5 text-xs text-signal-green"><CheckCircle2 className="size-3.5" /> Varied shots, no repeated footage, clear progression.</p>}
      <ul className="space-y-1">
        {r.issues.map((x, i) => (
          <li key={i} className={cn('flex items-start gap-1.5 text-xs', x.severity === 'error' ? 'text-signal-red' : x.severity === 'warning' ? 'text-signal-amber' : 'text-fog-300')}>
            {x.severity === 'info' ? <Info className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
            {x.message}
          </li>
        ))}
      </ul>
      {r.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {r.options.map((o) =>
            o.key === 'more_footage' ? (
              <Link key={o.key} href="/app/ads/library" className={buttonVariants({ size: 'sm', variant: 'ghost' })}>{o.label}</Link>
            ) : (
              <Button key={o.key} size="sm" variant={o.key === 'shorter' ? 'secondary' : 'ghost'} loading={busy === `opt-${o.key}`} onClick={() => onOption(o.key as 'shorter' | 'crops')}>{o.label}</Button>
            ),
          )}
        </div>
      )}
    </Card>
  );
}
