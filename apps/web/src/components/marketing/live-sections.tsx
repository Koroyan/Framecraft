'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Check, Volume2, Camera, Images, Layers } from 'lucide-react';
import { api } from '@/lib/api';
import type { PublicModel } from '@framecraft/shared';
import { Badge, Skeleton, buttonVariants } from '@/components/ui';
import { cn, formatCredits } from '@/lib/utils';

type PlansResponse = {
  plans: { key: string; name: string; description: string; priceCents: number; monthlyCredits: number; features: string[] }[];
  packs: { key: string; name: string; credits: number; priceCents: number }[];
};

/** Real catalog data from the API — no invented benchmarks. */
export function ModelCatalogSection() {
  const { data, isLoading } = useQuery({ queryKey: ['models'], queryFn: () => api<{ models: PublicModel[] }>('/api/models') });
  const models = (data?.models ?? []).filter((m) => m.status === 'active');
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {isLoading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-36" />)}
      {models.slice(0, 12).map((m) => (
        <div key={m.key} className="surface rounded-2xl p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[15px] font-medium text-white">{m.displayName.replace(/ \(via .*\)/, '')}</div>
              <div className="text-xs text-fog-400">via {m.provider}</div>
            </div>
            <Badge tone="iris">from ${m.fromUsdPerSecond.toFixed(2)}/s</Badge>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge>{m.resolutions.at(-1)}</Badge>
            <Badge>
              {m.durations.min}–{m.durations.max}s
            </Badge>
            {m.nativeAudio && (
              <Badge tone="green">
                <Volume2 /> audio
              </Badge>
            )}
            {m.cameraControl && (
              <Badge tone="blue">
                <Camera /> camera API
              </Badge>
            )}
            {m.maxReferenceImages > 0 && (
              <Badge tone="amber">
                <Images /> {m.maxReferenceImages} refs
              </Badge>
            )}
            {m.firstLastFrame && (
              <Badge>
                <Layers /> first/last
              </Badge>
            )}
          </div>
        </div>
      ))}
      {!isLoading && !models.length && <p className="text-sm text-fog-400">The model catalog loads from the API server.</p>}
    </div>
  );
}

export function PricingSection() {
  const { data, isLoading } = useQuery({ queryKey: ['plans'], queryFn: () => api<PlansResponse>('/api/billing/plans') });
  return (
    <div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {isLoading && Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-96" />)}
        {data?.plans.map((p) => {
          const featured = p.key === 'pro';
          return (
            <div key={p.key} className={cn('relative flex flex-col rounded-3xl p-6', featured ? 'border border-iris-500/50 bg-gradient-to-b from-iris-500/12 to-transparent shadow-glow' : 'surface')}>
              {featured && <span className="absolute -top-3 left-6 rounded-full bg-iris-500 px-3 py-1 text-[11px] font-semibold text-white">Most popular</span>}
              <div className="text-lg font-semibold text-white">{p.name}</div>
              <p className="mt-1 min-h-10 text-sm text-fog-300">{p.description}</p>
              <div className="mt-5 flex items-baseline gap-1">
                <span className="text-4xl font-semibold tracking-tight text-white">${(p.priceCents / 100).toFixed(0)}</span>
                <span className="text-sm text-fog-400">{p.priceCents ? '/ month' : ''}</span>
              </div>
              <div className="mt-1 text-sm text-iris-300">{p.monthlyCredits ? `${formatCredits(p.monthlyCredits)} credits monthly` : 'Trial credits on sign-up'}</div>
              <ul className="mt-6 flex-1 space-y-2.5">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2 text-sm text-fog-200">
                    <Check className="mt-0.5 size-4 shrink-0 text-iris-400" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/register" className={cn(buttonVariants({ variant: featured ? 'primary' : 'secondary', size: 'lg' }), 'mt-8 w-full')}>
                {p.priceCents ? `Choose ${p.name}` : 'Start free'}
              </Link>
            </div>
          );
        })}
      </div>
      {data && (
        <p className="mt-6 text-center text-sm text-fog-400">
          Extra credit packs from ${(data.packs[0]!.priceCents / 100).toFixed(0)}. Credits are charged per clip based on the real model cost — you always see the price before generating.
        </p>
      )}
    </div>
  );
}
