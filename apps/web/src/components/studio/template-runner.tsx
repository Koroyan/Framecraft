'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Clapperboard, Film, Lightbulb, Pencil, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { fillTemplate, scaleBeats, type TemplateDefinition, type VideoSpecInput } from '@framecraft/shared';
import { api, endpoints, ApiError, type Asset } from '@/lib/api';
import { Badge, Button, Card, Field, Input, NativeSelect, Textarea, buttonVariants } from '@/components/ui';
import { ImageSlot } from './upload';
import { VideoComposer } from './composer';
import { StatusBadge } from './job-view';
import { isActive, useJob } from '@/lib/hooks';
import { ProgressBar } from './progress';
import { cn, formatCredits, newKey } from '@/lib/utils';

type Concept = { title: string; logline: string; hook: string; visualStyle: string; shots: { description: string; durationSec: number; camera: string }[]; whyItWorks: string };

function BeatJob({ id, label }: { id: string; label: string }) {
  const { data } = useJob(id);
  return (
    <div className="space-y-2 rounded-xl border hairline px-3 py-2.5 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-fog-100">{label}</span>
        {data ? <StatusBadge job={data.job} /> : <span className="skeleton h-5 w-20" />}
      </div>
      {data && isActive(data.job) && <ProgressBar progress={data.job.progressSource === 'provider' ? data.job.progress : null} etaSec={data.job.etaSec} label={data.job.phase} />}
    </div>
  );
}

export function TemplateRunner({ template, onDone }: { template: TemplateDefinition; onDone: (jobId: string, projectId: string, aspect: string) => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [image, setImage] = useState<Asset | null>(null);
  const [stage, setStage] = useState<'fields' | 'plan' | 'running'>('fields');
  const [beats, setBeats] = useState<{ label: string; seconds: number; prompt: string }[]>([]);
  const [concepts, setConcepts] = useState<{ items: Concept[]; source: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<{ id: string; label: string }[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const d = template.defaults;

  const ready = template.fields.filter((f) => f.required).every((f) => values[f.key]?.trim());
  const basePrompt = fillTemplate(template.promptPattern, values);

  const buildBeats = (fromConcept?: Concept) => {
    if (fromConcept) return fromConcept.shots.map((s, i) => ({ label: `Shot ${i + 1}`, seconds: s.durationSec, prompt: `${s.description}. ${fromConcept.visualStyle}.` }));
    return scaleBeats(template.beats, d.durationSec).map((b) => ({ label: b.label, seconds: b.seconds, prompt: `${fillTemplate(b.guidance, values)}. ${basePrompt}` }));
  };

  const estimates = useQueries({
    queries: beats.map((b) => ({
      queryKey: ['beat-estimate', b.prompt, b.seconds, d.aspectRatio, d.quality, image?.id],
      queryFn: () => endpoints.estimate(beatSpec(b, 0)),
      enabled: stage === 'plan',
    })),
  });
  const total = estimates.reduce((s, e) => s + (e.data?.estimate.credits ?? 0), 0);
  const allOk = estimates.length > 0 && estimates.every((e) => e.data?.estimate.ok);

  function beatSpec(b: { prompt: string; seconds: number }, i: number): VideoSpecInput {
    return { prompt: b.prompt, aspectRatio: d.aspectRatio, durationSec: Math.max(3, b.seconds), quality: d.quality, style: d.style, camera: d.camera, nativeAudio: d.nativeAudio, imageAssetId: i === 0 ? image?.id : undefined };
  }

  const getConcepts = async () => {
    setBusy(true);
    try {
      const r = await api<{ concepts: Concept[]; source: string; notice?: string }>('/api/director/concepts', { body: { idea: basePrompt, durationSec: d.durationSec, templateKey: template.key, platform: template.platforms[0] } });
      setConcepts({ items: r.concepts, source: r.source });
      if (r.notice) toast.message(r.notice);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not create concepts');
    } finally {
      setBusy(false);
    }
  };

  const generateAll = async () => {
    setBusy(true);
    try {
      const p = await api<{ project: { id: string } }>('/api/projects', { body: { title: `${template.name}: ${Object.values(values)[0] ?? ''}`.slice(0, 100), kind: 'social', aspectRatio: d.aspectRatio, templateKey: template.key } });
      setProjectId(p.project.id);
      const created: { id: string; label: string }[] = [];
      for (const [i, b] of beats.entries()) {
        const r = await endpoints.generate({ spec: beatSpec(b, i), projectId: p.project.id, templateKey: template.key, idempotencyKey: newKey(), confirmEstimate: true });
        created.push({ id: r.job.id, label: b.label });
      }
      setJobs(created);
      setStage('running');
      void qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start generation');
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------ fields
  if (stage === 'fields') {
    if (template.workflow === 'single-clip' && ready) {
      return (
        <div className="space-y-5">
          <Button variant="ghost" size="sm" onClick={() => setValues({})}>
            <Pencil /> Change details
          </Button>
          <VideoComposer initial={{ prompt: basePrompt, aspectRatio: d.aspectRatio, durationSec: d.durationSec, quality: d.quality, style: d.style, camera: d.camera, nativeAudio: d.nativeAudio }} projectKind="social" templateKey={template.key} title={template.name} onCreated={onDone} />
        </div>
      );
    }
    return (
      <Card className="max-w-2xl space-y-4 p-5">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="iris">{template.workflow === 'multi-shot' ? `${template.beats.length} shots` : template.workflow === 'movie' ? 'Movie workflow' : 'Single clip'}</Badge>
          <Badge>{d.aspectRatio}</Badge>
          <Badge>{d.durationSec}s</Badge>
          <Badge>{d.quality}</Badge>
        </div>
        {template.fields.map((f) =>
          f.type === 'image' ? (
            <Field key={f.key} label={f.label}>
              <div className="w-28">
                <ImageSlot label="Add image" asset={image} onChange={setImage} />
              </div>
            </Field>
          ) : f.type === 'select' ? (
            <Field key={f.key} label={f.label}>
              <NativeSelect value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                <option value="">Choose…</option>
                {f.options?.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </NativeSelect>
            </Field>
          ) : f.type === 'textarea' ? (
            <Field key={f.key} label={f.label + (f.required ? '' : ' (optional)')}>
              <Textarea value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            </Field>
          ) : (
            <Field key={f.key} label={f.label + (f.required ? '' : ' (optional)')}>
              <Input value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            </Field>
          ),
        )}
        {template.workflow === 'movie' ? (
          <Button disabled={!ready} onClick={() => router.push(`/app/movie?idea=${encodeURIComponent(basePrompt)}&length=${d.durationSec}&aspect=${encodeURIComponent(d.aspectRatio)}`)}>
            <Clapperboard /> Plan this film
          </Button>
        ) : template.workflow === 'multi-shot' ? (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!ready}
              onClick={() => {
                setBeats(buildBeats());
                setStage('plan');
              }}
            >
              Plan shots <ArrowRight />
            </Button>
            <Button variant="secondary" disabled={!ready} loading={busy} onClick={getConcepts}>
              <Lightbulb /> Generate 3 creative concepts
            </Button>
          </div>
        ) : (
          <p className="text-sm text-fog-400">Fill in the required fields to continue.</p>
        )}
        {concepts && (
          <div className="space-y-3 pt-2">
            <div className="text-sm text-fog-300">Pick a direction {concepts.source === 'offline' && <Badge tone="amber">offline planner</Badge>}</div>
            <div className="grid gap-3 md:grid-cols-3">
              {concepts.items.map((c) => (
                <button
                  key={c.title}
                  type="button"
                  onClick={() => {
                    setBeats(buildBeats(c));
                    setStage('plan');
                  }}
                  className="surface rounded-2xl p-4 text-left transition hover:border-iris-500/50"
                >
                  <div className="font-medium text-white">{c.title}</div>
                  <div className="mt-1 text-xs text-iris-300">{c.hook}</div>
                  <p className="mt-2 line-clamp-3 text-xs text-fog-300">{c.visualStyle}</p>
                  <div className="mt-2 text-[11px] text-fog-400">{c.shots.length} shots</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>
    );
  }

  // ------------------------------------------------------------ plan
  if (stage === 'plan') {
    return (
      <div className="max-w-3xl space-y-4">
        {beats.map((b, i) => (
          <Card key={i} className="p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="grid size-6 place-items-center rounded-lg bg-white/[0.06] text-xs text-fog-200">{i + 1}</span>
                <span className="text-sm font-medium text-white">{b.label}</span>
                <Badge>{b.seconds}s</Badge>
              </div>
              <span className="text-xs tabular-nums text-fog-300">{estimates[i]?.data ? `${formatCredits(estimates[i]!.data!.estimate.credits)} cr · ${estimates[i]!.data!.estimate.segments[0]?.modelName.replace(/ \(via .*\)/, '') ?? ''}` : '…'}</span>
            </div>
            <Textarea value={b.prompt} onChange={(e) => setBeats(beats.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)))} className="min-h-20 text-sm" />
            {estimates[i]?.data?.estimate.blockers?.[0] && <p className="mt-2 text-xs text-signal-red">{estimates[i]!.data!.estimate.blockers![0]}</p>}
          </Card>
        ))}
        <div className="surface flex flex-col gap-3 rounded-2xl p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm text-fog-300">Total estimate</div>
            <div className="text-xl font-semibold tabular-nums text-white">{formatCredits(total)} credits</div>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStage('fields')}>Back</Button>
            <Button onClick={generateAll} disabled={!allOk} loading={busy}>
              <Wand2 /> Generate {beats.length} shots
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------ running
  return (
    <Card className="max-w-2xl space-y-3 p-5">
      <div className="text-sm text-fog-300">Generating your shots. They’ll be assembled in the editor in this order.</div>
      {jobs.map((j) => (
        <BeatJob key={j.id} id={j.id} label={j.label} />
      ))}
      {projectId && (
        <div className="flex flex-wrap gap-2 pt-2">
          <Link href={`/app/editor/${projectId}`} className={cn(buttonVariants())}>
            <Film /> Open in editor
          </Link>
          <Link href={`/app/projects/${projectId}`} className={buttonVariants({ variant: 'secondary' })}>
            View project
          </Link>
        </div>
      )}
    </Card>
  );
}
