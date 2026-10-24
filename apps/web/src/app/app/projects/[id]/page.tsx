'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Film, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { PublicJob } from '@framecraft/shared';
import { api, type Project } from '@/lib/api';
import { Button, Dialog, EmptyState, Input, PageHeader, Skeleton, buttonVariants } from '@/components/ui';
import { JobCard } from '@/components/studio/job-card';
import { JobView } from '@/components/studio/job-view';
import { VideoComposer } from '@/components/studio/composer';
import type { AspectRatio } from '@framecraft/shared';

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['project', id], queryFn: () => api<{ project: Project; jobs: PublicJob[] }>(`/api/projects/${id}`), refetchInterval: 6000 });
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');

  if (isLoading || !data) return <Skeleton className="mx-auto h-96 max-w-6xl" />;
  const p = data.project;
  const videos = data.jobs.filter((j) => j.kind === 'video' || j.kind === 'render');

  const duplicate = async () => {
    const r = await api<{ project: Project }>(`/api/projects/${id}/duplicate`, { body: {} });
    toast.success('Project duplicated');
    router.push(`/app/projects/${r.project.id}`);
  };
  const remove = async () => {
    await api(`/api/projects/${id}`, { method: 'DELETE' });
    toast.success('Project deleted');
    void qc.invalidateQueries({ queryKey: ['projects'] });
    router.push('/app/projects');
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={`${p.kind} project · ${p.aspectRatio}`}
        title={p.title}
        actions={
          <>
            <Link href={`/app/editor/${id}`} className={buttonVariants()}>
              <Film /> Open editor
            </Link>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              <Plus /> Add clip
            </Button>
            <Button variant="ghost" size="icon" aria-label="Rename" onClick={() => { setTitle(p.title); setRenaming(true); }}>
              <Pencil />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Duplicate" onClick={duplicate}>
              <Copy />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Delete project" onClick={remove}>
              <Trash2 />
            </Button>
          </>
        }
      />
      {videos.length ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {videos.map((j) => (
            <JobCard key={j.id} job={j} onClick={() => setOpen(j.id)} />
          ))}
        </div>
      ) : (
        <EmptyState icon={<Film />} title="No clips yet" action={<Button onClick={() => setAdding(true)}>Add a clip</Button>} />
      )}
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(null)} title="Clip" wide>
          <JobView jobId={open} aspect={p.aspectRatio} onJobChange={setOpen} />
        </Dialog>
      )}
      <Dialog open={adding} onOpenChange={setAdding} title="Add a clip to this project" wide>
        <VideoComposer
          projectId={id}
          initial={{ aspectRatio: p.aspectRatio as AspectRatio }}
          onCreated={(jobId) => {
            setAdding(false);
            setOpen(jobId);
            void qc.invalidateQueries({ queryKey: ['project', id] });
          }}
        />
      </Dialog>
      <Dialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename project"
        footer={
          <Button
            onClick={async () => {
              await api(`/api/projects/${id}`, { method: 'PATCH', body: { title } });
              setRenaming(false);
              void qc.invalidateQueries({ queryKey: ['project', id] });
            }}
          >
            Save
          </Button>
        }
      >
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </Dialog>
    </div>
  );
}
