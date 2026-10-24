'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { History as HistoryIcon } from 'lucide-react';
import { endpoints } from '@/lib/api';
import { Button, Dialog, EmptyState, PageHeader, Segmented, Skeleton } from '@/components/ui';
import { JobCard } from '@/components/studio/job-card';
import { JobView } from '@/components/studio/job-view';
import { useJob } from '@/lib/hooks';

function JobDialog({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: (id: string) => void }) {
  const { data } = useJob(id);
  const aspect = (data?.request?.aspectRatio as string) ?? '9:16';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Generation" description={data?.job.prompt ?? undefined} wide>
      <JobView jobId={id} aspect={aspect} onJobChange={onChange} />
    </Dialog>
  );
}

function HistoryInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState('');
  const open = params.get('job');
  const q = useInfiniteQuery({
    queryKey: ['jobs', 'history', status],
    queryFn: ({ pageParam }) => endpoints.jobs(`?limit=24${status ? `&status=${status}` : ''}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => (last.jobs.length === 24 ? last.jobs.at(-1)!.createdAt : undefined),
    refetchInterval: 10_000,
  });
  const jobs = q.data?.pages.flatMap((p) => p.jobs) ?? [];
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Generation history" description="Every generation, export and planning job — with its real status and the credits it used." />
      <Segmented
        className="mb-5"
        value={status}
        onChange={setStatus}
        options={[
          { value: '', label: 'All' },
          { value: 'completed', label: 'Completed' },
          { value: 'generating', label: 'Running' },
          { value: 'failed', label: 'Failed' },
        ]}
      />
      {q.isLoading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="aspect-[4/5]" />)}</div>
      ) : jobs.length ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
            {jobs.map((j) => (
              <JobCard key={j.id} job={j} onClick={() => router.push(`/app/history?job=${j.id}`, { scroll: false })} />
            ))}
          </div>
          {q.hasNextPage && (
            <div className="mt-6 text-center">
              <Button variant="secondary" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>Load more</Button>
            </div>
          )}
        </>
      ) : (
        <EmptyState icon={<HistoryIcon />} title="Nothing here yet" description="Your generations will appear here." />
      )}
      {open && <JobDialog id={open} onClose={() => router.push('/app/history', { scroll: false })} onChange={(id) => router.replace(`/app/history?job=${id}`, { scroll: false })} />}
    </div>
  );
}

export default function HistoryPage() {
  return (
    <Suspense>
      <HistoryInner />
    </Suspense>
  );
}
