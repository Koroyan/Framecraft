'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui';
import { VideoComposer } from '@/components/studio/composer';
import { JobView } from '@/components/studio/job-view';

export default function CinematicStudio() {
  const [job, setJob] = useState<{ id: string; aspect: string } | null>(null);
  const [k, setK] = useState(0);
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Cinematic Studio"
        title="Direct every frame"
        description="Camera moves, lenses, lighting, grade, first & last frames, references and manual model choice. Camera presets use a real camera-control API where the model has one, and become prompt direction otherwise."
      />
      {job ? (
        <JobView
          jobId={job.id}
          aspect={job.aspect}
          onJobChange={(id) => setJob({ ...job, id })}
          onNew={() => {
            setJob(null);
            setK((x) => x + 1);
          }}
        />
      ) : (
        <VideoComposer key={k} cinematic advancedDefault projectKind="cinematic" initial={{ aspectRatio: '16:9', durationSec: 8, quality: 'high', style: 'cinematic' }} onCreated={(id, _p, aspect) => setJob({ id, aspect })} />
      )}
    </div>
  );
}
