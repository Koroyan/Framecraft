'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { useTemplates } from '@/lib/hooks';
import { Badge, PageHeader, Segmented, Skeleton } from '@/components/ui';

const CATS = [
  { value: '', label: 'All' },
  { value: 'commerce', label: 'Commerce' },
  { value: 'social', label: 'Social' },
  { value: 'brand', label: 'Brand' },
  { value: 'story', label: 'Story' },
  { value: 'education', label: 'Education' },
  { value: 'music', label: 'Music' },
];

export default function TemplatesPage() {
  const { data, isLoading } = useTemplates();
  const [cat, setCat] = useState('');
  const list = (data?.templates ?? []).filter((t) => !cat || t.category === cat);
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Templates" description="Each template is a guided workflow: fill a few details, get a shot plan, generate." />
      <Segmented className="mb-5" value={cat} onChange={setCat} options={CATS} size="sm" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {isLoading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40" />)}
        {list.map((t) => (
          <Link key={t.key} href={`/app/create?template=${t.key}`} className="surface group flex flex-col rounded-2xl p-5 transition hover:border-iris-500/40">
            <div className="mb-3 flex items-center justify-between">
              <div className="grid size-10 place-items-center rounded-xl bg-iris-500/12 text-iris-300">
                <LayoutTemplate className="size-4" />
              </div>
              {t.featured && <Badge tone="iris">Featured</Badge>}
            </div>
            <div className="font-medium text-white">{t.name}</div>
            <p className="mt-1 flex-1 text-sm text-fog-300">{t.description}</p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              <Badge>{t.defaults.aspectRatio}</Badge>
              <Badge>{t.defaults.durationSec}s</Badge>
              <Badge>{t.workflow === 'multi-shot' ? `${t.beats.length} shots` : t.workflow === 'movie' ? 'film' : '1 clip'}</Badge>
              {t.suggestImage && <Badge tone="amber">photo recommended</Badge>}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
