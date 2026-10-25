'use client';

import Link from 'next/link';
import { AD_STYLES } from '@framecraft/shared';
import { buttonVariants, Card } from '@/components/ui';

/** Brand templates: reusable creative styles. Each changes real cutting parameters, not just a filter. */
export default function TemplatesPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-white">Brand Templates</h1>
        <p className="mt-1 max-w-2xl text-sm text-fog-400">Reusable ad structures. A template sets the pacing, shot length, camera language, transitions, title animation, colour look, script tone and music — the concepts and storyboard are still written for your footage.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {AD_STYLES.map((s) => (
          <Card key={s.key} className="flex flex-col gap-2 p-4">
            <div className="text-sm font-medium text-white">{s.label}</div>
            <p className="text-xs text-fog-300">Hook: {s.hook}. Favours {s.favour}.</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-fog-400">
              <dt>Pacing</dt><dd className="text-fog-200">{s.pacing} · {s.shotSec[0]}–{s.shotSec[1]} s</dd>
              <dt>Camera</dt><dd className="text-fog-200">{s.camera ?? 'static'}</dd>
              <dt>Transitions</dt><dd className="text-fog-200">{s.transition}</dd>
              <dt>Look</dt><dd className="text-fog-200">{s.look}</dd>
              <dt>Tone</dt><dd className="text-fog-200">{s.tone}</dd>
              <dt>Music</dt><dd className="text-fog-200">{s.music}</dd>
            </dl>
            <Link href={`/app/ads/create?style=${s.key}`} className={buttonVariants({ size: 'sm', variant: 'secondary', className: 'mt-auto self-start' })}>Use this template</Link>
          </Card>
        ))}
      </div>
    </div>
  );
}
