'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clapperboard, FolderKanban, Plus } from 'lucide-react';
import { endpoints } from '@/lib/api';
import { Badge, EmptyState, PageHeader, Segmented, Skeleton, buttonVariants } from '@/components/ui';
import { timeAgo } from '@/lib/utils';

export default function ProjectsPage() {
  const [kind, setKind] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['projects', kind], queryFn: () => endpoints.projects(kind ? `?kind=${kind}` : '') });
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Projects"
        description="Everything you’ve made, saved automatically."
        actions={
          <Link href="/app/create" className={buttonVariants()}>
            <Plus /> New video
          </Link>
        }
      />
      <Segmented
        className="mb-5"
        value={kind}
        onChange={setKind}
        options={[
          { value: '', label: 'All' },
          { value: 'quick', label: 'Quick' },
          { value: 'social', label: 'Social' },
          { value: 'cinematic', label: 'Cinematic' },
          { value: 'movie', label: 'Films' },
        ]}
      />
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-56" />)}</div>
      ) : data?.projects.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.projects.map((p) => (
            <Link key={p.id} href={p.kind === 'movie' ? `/app/movie/${p.id}` : `/app/projects/${p.id}`} className="surface group overflow-hidden rounded-2xl transition hover:border-white/15">
              <div className="aspect-video bg-ink-800">
                {p.thumbnailUrl ? <img src={p.thumbnailUrl} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-fog-400">{p.kind === 'movie' ? <Clapperboard /> : <FolderKanban />}</div>}
              </div>
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="line-clamp-1 font-medium text-white">{p.title}</div>
                  <Badge>{p.kind}</Badge>
                </div>
                <div className="mt-1 text-xs text-fog-400">
                  {p.aspectRatio} · {p.generations ?? 0} generations · updated {timeAgo(p.updatedAt)}
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState icon={<FolderKanban />} title="No projects" description="Create a video to start your first project." />
      )}
    </div>
  );
}
