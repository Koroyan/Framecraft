'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, Pencil, RotateCcw, Square, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { JOB_STATUS_LABEL, type JobStatus, type PublicJob, type SocialPlatform } from '@framecraft/shared';
import { endpoints, ApiError } from '@/lib/api';
import { useJob, isActive } from '@/lib/hooks';
import { Badge, Button, Card, Segmented, buttonVariants } from '@/components/ui';
import { VideoPlayer } from './video-player';
import { ProgressBar } from './progress';
import { cn, formatCredits, newKey } from '@/lib/utils';

const STEPS: JobStatus[] = ['queued', 'preparing', 'generating', 'processing', 'completed'];

export function StatusBadge({ job }: { job: Pick<PublicJob, 'status' | 'isFixture'> }) {
  const tone = job.status === 'completed' ? 'green' : job.status === 'failed' ? 'red' : job.status === 'cancelled' ? 'neutral' : 'iris';
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={tone}>{JOB_STATUS_LABEL[job.status]}</Badge>
      {job.isFixture && <Badge tone="amber">fixture · not AI</Badge>}
    </span>
  );
}

function Phases({ job }: { job: PublicJob }) {
  const idx = Math.max(0, STEPS.indexOf(job.status === 'rendering' ? 'processing' : job.status));
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className={cn('h-1.5 flex-1 rounded-full transition-all duration-700', i < idx ? 'bg-iris-400' : i === idx ? 'animate-pulse bg-iris-400/60' : 'bg-white/10')} />
        ))}
      </div>
      {/* Percentages only come from real provider progress; otherwise an animated bar + history-based estimate. */}
      <ProgressBar progress={job.progressSource === 'provider' ? job.progress : null} etaSec={job.etaSec} label={job.phase ?? JOB_STATUS_LABEL[job.status]} />
      <p className="text-xs text-fog-400">You can leave this page — the job keeps running and you’ll get a notification.</p>
    </div>
  );
}

export function JobView({ jobId, aspect, onNew, onJobChange }: { jobId: string; aspect: string; onNew?: () => void; onJobChange?: (id: string) => void }) {
  const { data } = useJob(jobId);
  const qc = useQueryClient();
  const [overlay, setOverlay] = useState<SocialPlatform | 'none'>('none');
  const [busy, setBusy] = useState(false);
  const job = data?.job;
  if (!job) return <Card className="skeleton h-80" />;

  const cancel = async () => {
    setBusy(true);
    try {
      await endpoints.cancel(job.id);
      await qc.invalidateQueries({ queryKey: ['job', job.id] });
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    try {
      const r = await endpoints.retry(job.id, newKey());
      toast.success('Retrying with a fresh estimate');
      await qc.invalidateQueries({ queryKey: ['me'] });
      onJobChange?.(r.job.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Retry failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4 md:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <StatusBadge job={job} />
        <span className="text-xs text-fog-400">{job.chargedCredits !== null ? `${formatCredits(job.chargedCredits)} credits charged` : `${formatCredits(job.estimatedCredits)} credits reserved`}</span>
      </div>

      {job.status === 'completed' && job.outputUrl ? (
        <div className="grid gap-5 md:grid-cols-[minmax(0,340px)_1fr]">
          <VideoPlayer src={job.outputUrl} poster={job.thumbnailUrl} aspect={aspect} isFixture={job.isFixture} overlay={overlay === 'none' ? null : overlay} className="mx-auto w-full max-w-[340px]" />
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-signal-green">
              <CheckCircle2 className="size-5" />
              <span className="font-medium">{job.isFixture ? 'Pipeline test complete' : 'Your video is ready'}</span>
            </div>
            {job.isFixture && (
              <p className="rounded-xl bg-signal-amber/10 p-3 text-xs leading-relaxed text-signal-amber">
                This is a development test pattern rendered locally with FFmpeg, not an AI-generated video. Configure a provider API key and enable live generation to create real videos.
              </p>
            )}
            {aspect === '9:16' && (
              <div>
                <div className="mb-1.5 text-xs text-fog-400">Preview platform safe area</div>
                <Segmented size="sm" value={overlay} onChange={setOverlay} options={[{ value: 'none', label: 'Off' }, { value: 'tiktok', label: 'TikTok' }, { value: 'reels', label: 'Reels' }, { value: 'shorts', label: 'Shorts' }]} />
              </div>
            )}
            {job.enhancedPrompt && (
              <details className="rounded-xl border hairline p-3 text-sm">
                <summary className="cursor-pointer text-fog-200">Prompt sent to the model</summary>
                <p className="mt-2 text-fog-300">{job.enhancedPrompt}</p>
              </details>
            )}
            <div className="flex flex-wrap gap-2">
              <a href={job.outputUrl.replace(/(\?.*)$/, '$1')} download className={buttonVariants({ variant: 'white' })}>
                <Download /> Download MP4
              </a>
              {job.projectId && (
                <Link href={`/app/editor/${job.projectId}`} className={buttonVariants({ variant: 'secondary' })}>
                  <Pencil /> Edit
                </Link>
              )}
              {onNew && (
                <Button variant="ghost" onClick={onNew}>
                  <Wand2 /> Create another
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : job.status === 'failed' || job.status === 'cancelled' ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-xl bg-signal-red/10 p-4 text-sm text-signal-red">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <div className="font-medium">{job.status === 'cancelled' ? 'Generation cancelled' : 'Generation failed'}</div>
              {job.error && <div className="mt-1 text-signal-red/80">{job.error.message}</div>}
              <div className="mt-1 text-signal-red/80">{job.chargedCredits ? `${formatCredits(job.chargedCredits)} credits were charged.` : 'Your reserved credits were returned.'}</div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={retry} loading={busy}>
              <RotateCcw /> Try again
            </Button>
            {onNew && (
              <Button variant="ghost" onClick={onNew}>
                Edit request
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="relative mx-auto aspect-[9/16] max-h-[380px] w-auto overflow-hidden rounded-2xl border hairline" style={{ aspectRatio: aspect.replace(':', '/') }}>
            <div className="skeleton absolute inset-0" />
            <div className="absolute inset-0 grid place-items-center text-sm text-fog-300">{JOB_STATUS_LABEL[job.status]}…</div>
          </div>
          <Phases job={job} />
          {isActive(job) && (
            <Button variant="ghost" size="sm" onClick={cancel} loading={busy}>
              <Square /> Cancel
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
