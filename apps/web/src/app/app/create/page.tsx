'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getTemplate, type AspectRatio } from '@framecraft/shared';
import { PageHeader } from '@/components/ui';
import { VideoComposer } from '@/components/studio/composer';
import { JobView } from '@/components/studio/job-view';
import { TemplateRunner } from '@/components/studio/template-runner';

function CreateInner() {
  const params = useSearchParams();
  const router = useRouter();
  const template = params.get('template') ? getTemplate(params.get('template')!) : undefined;
  const [job, setJob] = useState<{ id: string; aspect: string } | null>(params.get('job') ? { id: params.get('job')!, aspect: (params.get('aspect') as AspectRatio) ?? '9:16' } : null);
  const [composerKey, setComposerKey] = useState(0);

  const onCreated = (jobId: string, _projectId: string, aspect: string) => {
    setJob({ id: jobId, aspect });
    router.replace(`/app/create?job=${jobId}&aspect=${encodeURIComponent(aspect)}`, { scroll: false });
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow={template ? 'Template' : 'Quick Create'} title={template ? template.name : 'What do you want to create?'} description={template?.description ?? 'Describe it in your own words. We’ll write the prompt, pick the best-value model and show the price first.'} />
      {job ? (
        <JobView
          jobId={job.id}
          aspect={job.aspect}
          onJobChange={(id) => setJob({ ...job, id })}
          onNew={() => {
            setJob(null);
            setComposerKey((k) => k + 1);
            router.replace('/app/create', { scroll: false });
          }}
        />
      ) : template ? (
        <TemplateRunner template={template} onDone={onCreated} />
      ) : (
        <VideoComposer key={composerKey} initial={{ prompt: params.get('prompt') ?? '' }} onCreated={onCreated} />
      )}
    </div>
  );
}

export default function CreatePage() {
  return (
    <Suspense>
      <CreateInner />
    </Suspense>
  );
}
