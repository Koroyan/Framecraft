'use client';

import Link from 'next/link';
import { Clapperboard } from 'lucide-react';
import { Badge, buttonVariants, Card, EmptyState, Skeleton } from '@/components/ui';
import { useCampaigns } from '@/lib/ads';

const LABEL: Record<string, string> = { analyzing: 'Analysing footage', planning: 'Writing concepts', planned: 'Storyboard ready', assembling: 'Producing', ready: 'Ready', failed: 'Failed' };

/** Creative Studio: every campaign with its concepts, storyboard, production and variations. */
export default function CampaignsPage() {
  const q = useCampaigns();
  const list = q.data?.campaigns ?? [];
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-white">Creative Studio</h1>
        <p className="mt-1 text-sm text-fog-400">Concepts, storyboards and variations of your ads. Open one to change the concept, edit shots, produce it or make variations.</p>
      </div>
      {q.isLoading && <Skeleton className="h-40" />}
      {!q.isLoading && !list.length && <EmptyState icon={<Clapperboard />} title="No ads yet" description="Create your first ad from your videos, photos or website." action={<Link href="/app/ads/create" className={buttonVariants()}>Create an ad</Link>} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((c) => (
          <Card key={c.id} className="flex flex-col gap-2 p-3">
            <Link href={`/app/ads/footage/${c.id}`} className="line-clamp-2 text-sm font-medium text-white hover:text-iris-200">{c.title}</Link>
            <div className="flex items-center gap-2 text-[11px] text-fog-400">
              <Badge tone={c.status === 'ready' ? 'green' : c.status === 'failed' ? 'red' : c.status === 'planned' ? 'blue' : 'iris'}>{LABEL[c.status] ?? c.status}</Badge>
              {new Date(c.updatedAt).toLocaleString()}
            </div>
            <div className="mt-auto flex gap-2 pt-1">
              <Link href={`/app/ads/footage/${c.id}`} className={buttonVariants({ size: 'sm', variant: 'secondary' })}>Open</Link>
              {c.projectId && <Link href={`/app/editor/${c.projectId}`} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>Ad Editor</Link>}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
