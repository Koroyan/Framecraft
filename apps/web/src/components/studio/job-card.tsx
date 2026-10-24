'use client';

import { Film, Loader2 } from 'lucide-react';
import type { PublicJob } from '@framecraft/shared';
import { StatusBadge } from './job-view';
import { cn, timeAgo } from '@/lib/utils';
import { isActive } from '@/lib/hooks';
import { formatEta, ProgressBar } from './progress';

export function JobCard({ job, onClick, className }: { job: PublicJob; onClick?: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn('group surface block w-full overflow-hidden rounded-2xl text-left transition hover:border-white/15', className)}>
      <div className="relative aspect-[4/5] bg-ink-800">
        {job.thumbnailUrl ? (
          <img src={job.thumbnailUrl} alt="" className="size-full object-cover transition duration-500 group-hover:scale-[1.03]" loading="lazy" />
        ) : (
          <div className={cn('grid size-full place-items-center text-fog-400', isActive(job) && 'skeleton')}>{isActive(job) ? <Loader2 className="size-5 animate-spin" /> : <Film className="size-5" />}</div>
        )}
        <div className="absolute left-2 top-2">
          <StatusBadge job={job} />
        </div>
        {isActive(job) && (
          <div className="absolute inset-x-2 bottom-2 space-y-1 rounded-lg bg-black/60 p-1.5 backdrop-blur">
            <ProgressBar progress={job.progressSource === 'provider' ? job.progress : null} etaSec={job.etaSec} compact />
            <div className="text-[10px] text-fog-200">{formatEta(job.etaSec) ? `${formatEta(job.etaSec)} left` : 'Working…'}</div>
          </div>
        )}
      </div>
      <div className="p-3">
        <div className="line-clamp-2 text-[13px] text-fog-100">{job.prompt ?? (job.kind === 'render' ? 'Export' : job.kind)}</div>
        <div className="mt-1 text-[11px] text-fog-400">
          {timeAgo(job.createdAt)} · {job.kind}
        </div>
      </div>
    </button>
  );
}
