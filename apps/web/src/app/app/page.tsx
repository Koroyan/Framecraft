'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, Clapperboard, Coins, FolderKanban, LayoutTemplate, Megaphone, Scissors, Smartphone, Sparkles, Wand2 } from 'lucide-react';
import { endpoints } from '@/lib/api';
import { KIND_LABEL, projectHref } from '@/lib/projects';
import { hrefFor } from '@/lib/create-flow';
import { guessIntent } from '@framecraft/shared';
import { useMe, useSystemStatus, useTemplates } from '@/lib/hooks';
import { Badge, Card, EmptyState, Skeleton, buttonVariants } from '@/components/ui';
import { JobCard } from '@/components/studio/job-card';
import { cn, formatCredits, timeAgo } from '@/lib/utils';


export default function Dashboard() {
  const { data: me } = useMe();
  const { data: status } = useSystemStatus();
  const { data: templates } = useTemplates();
  const router = useRouter();
  const [idea, setIdea] = useState('');
  const jobs = useQuery({ queryKey: ['jobs', 'recent'], queryFn: () => endpoints.jobs('?limit=8'), refetchInterval: 8000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => endpoints.projects() });
  const first = me?.user?.name.split(' ')[0];

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <section className="relative overflow-hidden rounded-3xl border hairline bg-gradient-to-br from-iris-600/20 via-ink-900 to-ink-900 p-6 md:p-10">
        <div className="pointer-events-none absolute -right-20 -top-24 size-80 rounded-full bg-iris-500/20 blur-3xl" />
        <h1 className="text-[28px] font-semibold tracking-tight text-white md:text-[40px]">
          {first ? `Hi ${first}, ` : ''}what are we <span className="font-display italic text-iris-300">making</span> today?
        </h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // Same suggestion as "New video": an ad goes to Ad Studio, a story to the film flow…
            const intent = guessIntent(idea);
            router.push(intent ? hrefFor(intent.flow, idea.trim(), intent) : '/app/new');
          }}
          className="mt-6 flex max-w-2xl items-center gap-2 rounded-2xl border hairline bg-black/30 p-2 pl-4 backdrop-blur focus-within:border-iris-500/50"
        >
          <input value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="Describe the video you want to create…" aria-label="Describe your video" className="h-11 flex-1 bg-transparent text-[15px] text-white placeholder:text-fog-400 focus:outline-none" />
          <button type="submit" aria-label="Create" className="grid size-11 place-items-center rounded-xl bg-iris-500 text-white hover:bg-iris-400">
            <ArrowUp className="size-5" />
          </button>
        </form>
        <div className="mt-6 grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
          {[
            { href: '/app/create', icon: Wand2, label: 'AI video', hint: 'From one sentence' },
            { href: '/app/create?mode=animate', icon: Sparkles, label: 'Animate an image', hint: 'A photo comes alive' },
            { href: '/app/edit', icon: Scissors, label: 'Edit a video', hint: 'Your own clips' },
            { href: '/app/ads', icon: Megaphone, label: 'Product ad', hint: 'For your brand' },
            { href: '/app/movie', icon: Clapperboard, label: 'AI short film', hint: 'With a story' },
            { href: '/app/social', icon: Smartphone, label: 'Social post', hint: 'TikTok · Reels' },
          ].map((a) => (
            <Link key={a.href} href={a.href} className="flex flex-col gap-1 rounded-2xl border hairline bg-white/[0.03] p-3 text-sm text-fog-100 transition hover:border-iris-400/40 hover:bg-white/[0.06]">
              <a.icon className="size-4 text-iris-300" />
              <span className="font-medium">{a.label}</span>
              <span className="text-[11px] text-fog-400">{a.hint}</span>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-sm text-fog-300">
            <Coins className="size-4 text-signal-amber" /> Available credits
          </div>
          <div className="mt-2 text-3xl font-semibold tabular-nums text-white">{formatCredits(me?.wallet?.available)}</div>
          <div className="mt-1 text-xs text-fog-400">{me?.plan?.name} plan</div>
          <Link href="/app/billing" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'mt-4')}>Get more credits</Link>
        </Card>
        {me?.user?.role === 'admin' ? (
        <Card className="p-5 md:col-span-2">
          <div className="text-sm text-fog-300">Studio status <span className="text-[11px] text-fog-500">(admins only)</span></div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge tone={status?.liveGenerationEnabled ? 'green' : 'amber'}>{status?.liveGenerationEnabled ? 'Live AI generation on' : 'Live generation off'}</Badge>
            <Badge tone={status?.aiDirector === 'llm' ? 'green' : 'neutral'}>AI Director: {status?.aiDirector === 'llm' ? 'Claude' : 'offline planner'}</Badge>
            <Badge tone={status?.audio ? 'green' : 'neutral'}>Voice & music {status?.audio ? 'ready' : 'not configured'}</Badge>
            {status?.configuredProviders.map((p) => (
              <Badge key={p} tone="iris">{p}</Badge>
            ))}
          </div>
          <p className="mt-3 text-xs text-fog-400">Providers activate automatically when their API keys are configured on the server.</p>
        </Card>
        ) : (
          <Card className="space-y-2 p-5 md:col-span-2">
            <div className="text-sm text-fog-300">Continue where you left off</div>
            {(projects.data?.projects ?? []).slice(0, 3).map((p) => (
              <Link key={p.id} href={projectHref(p)} className="flex items-center justify-between rounded-xl px-2 py-1.5 text-sm text-fog-100 hover:bg-white/[0.04]">
                <span className="truncate">{p.title}</span>
                <span className="shrink-0 text-[11px] text-fog-500">{KIND_LABEL[p.kind] ?? p.kind} · {timeAgo(p.updatedAt)}</span>
              </Link>
            ))}
            {!projects.data?.projects.length && <p className="text-xs text-fog-400">Your projects will appear here.</p>}
          </Card>
        )}
      </div>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Recent work</h2>
          <Link href="/app/history" className="text-sm text-fog-300 hover:text-white">View all</Link>
        </div>
        {jobs.isLoading ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="aspect-[4/5]" />)}</div>
        ) : jobs.data?.jobs.length ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {jobs.data.jobs.slice(0, 8).map((j) => (
              <JobCard key={j.id} job={j} onClick={() => router.push(`/app/history?job=${j.id}`)} />
            ))}
          </div>
        ) : (
          <EmptyState icon={<Wand2 />} title="No videos yet" description="Describe your first idea above — it takes a few seconds." />
        )}
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Projects</h2>
          <Link href="/app/projects" className="text-sm text-fog-300 hover:text-white">All projects</Link>
        </div>
        {projects.data?.projects.length ? (
          <div className="grid gap-3 md:grid-cols-3">
            {projects.data.projects.slice(0, 6).map((p) => (
              <Link key={p.id} href={projectHref(p)} className="surface flex items-center gap-3 rounded-2xl p-3 transition hover:border-white/15">
                <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-ink-700">
                  {p.thumbnailUrl ? <img src={p.thumbnailUrl} alt="" className="size-full object-cover" /> : <FolderKanban className="size-5 text-fog-400" />}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-white">{p.title}</div>
                  <div className="text-xs text-fog-400">
                    {KIND_LABEL[p.kind] ?? p.kind} · {timeAgo(p.updatedAt)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState icon={<FolderKanban />} title="No projects yet" description="Every video you create is saved as a project you can edit later." />
        )}
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Start from a template</h2>
          <Link href="/app/templates" className="text-sm text-fog-300 hover:text-white">
            <LayoutTemplate className="mr-1 inline size-4" /> All templates
          </Link>
        </div>
        <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:grid md:grid-cols-3 md:px-0">
          {templates?.templates.filter((t) => t.featured).map((t) => (
            <Link key={t.key} href={`/app/create?template=${t.key}`} className="surface w-60 shrink-0 rounded-2xl p-4 transition hover:border-iris-500/40 md:w-auto">
              <div className="text-sm font-medium text-white">{t.name}</div>
              <div className="mt-1 line-clamp-2 text-xs text-fog-400">{t.description}</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
