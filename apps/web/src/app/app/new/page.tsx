'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronRight, Clapperboard, ImagePlay, Megaphone, Scissors, Smile, Sparkles, Wand2 } from 'lucide-react';
import { guessIntent, type CreateFlow } from '@framecraft/shared';
import { api, type Project } from '@/lib/api';
import { FLOW_LABEL as LABEL, hrefFor } from '@/lib/create-flow';
import { Button } from '@/components/ui';
import { cn, timeAgo } from '@/lib/utils';

const FLOWS: { key: CreateFlow; icon: typeof Wand2; title: string; text: string; cost: string }[] = [
  { key: 'ai', icon: Wand2, title: 'Text to video', text: 'Describe an idea — get a video.', cost: 'Price shown first' },
  { key: 'animate', icon: ImagePlay, title: 'Image to video', text: 'Bring a photo to life with motion.', cost: 'Price shown first' },
  { key: 'cartoon', icon: Smile, title: 'Cartoon', text: 'Characters, story and animation from one sentence.', cost: 'Planning free' },
  { key: 'film', icon: Clapperboard, title: 'AI movie', text: 'Story, characters, scenes and shots.', cost: 'Planning free' },
  { key: 'ad', icon: Megaphone, title: 'Brand ad', text: 'Your product, your footage, a real ad.', cost: 'Paid parts priced first' },
  { key: 'edit', icon: Scissors, title: 'Edit my video', text: 'Trim, text, music, colour, objects.', cost: 'Free editing' },
];

const PLACEHOLDER: Record<CreateFlow, string> = {
  ai: 'A slow cinematic push toward a tiny glass greenhouse glowing in a snowy forest at blue hour',
  animate: 'Make my photo come alive: the candles flicker and the camera slowly moves in',
  cartoon: 'A funny 45-second cartoon about a small robot who wants to become a chef',
  film: 'A 60-second short film about two friends who find an old map in their grandmother’s attic',
  ad: 'A 20-second vertical ad for my handmade candles — warm, premium, ends with “Order today”',
  edit: 'Edit my vacation clips into a 30-second reel with music and captions',
};

/** New video: pick a mode (or just describe it — we suggest the right one), then continue. Nothing is generated or charged here. */
export default function NewVideoPage() {
  const router = useRouter();
  const [idea, setIdea] = useState('');
  const [mode, setMode] = useState<CreateFlow | null>(null);
  const intent = useMemo(() => guessIntent(idea), [idea]);
  const flow = mode ?? intent?.flow ?? 'ai';
  const recent = useQuery({ queryKey: ['projects', 'recent-new'], queryFn: () => api<{ projects: Project[] }>('/api/projects'), staleTime: 30_000 });
  const go = () => router.push(hrefFor(flow, idea.trim(), intent ? { ...intent, flow } : null));
  const kindLabel = (k: Project['kind']) => ({ quick: 'AI video', social: 'Social', cinematic: 'Cinematic', movie: 'Film', edit: 'Edit', ad: 'Ad' })[k];

  return (
    <div className="mx-auto grid max-w-[1400px] gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-iris-400"><Sparkles className="size-3.5" /> Create</div>
        <h1 className="mt-3 max-w-xl text-3xl font-semibold leading-tight text-white md:text-[42px]">Start with what you want to make.</h1>
        <p className="mt-2 text-sm text-fog-300">Choose a mode, or just describe it in Georgian, English or Russian — we suggest the right start. Nothing is generated or charged here.</p>

        <div className="mt-6 grid grid-cols-3 gap-2 sm:grid-cols-6" role="radiogroup" aria-label="Creation mode">
          {FLOWS.map((f) => {
            const on = flow === f.key;
            return (
              <button key={f.key} type="button" role="radio" aria-checked={on} title={f.text} onClick={() => setMode(f.key)} className={cn('flex flex-col items-center gap-2 rounded-2xl border px-2 py-4 text-center transition', on ? 'border-iris-400 bg-iris-500/10 text-white shadow-glow' : 'hairline bg-ink-900 text-fog-300 hover:border-white/20 hover:text-white')}>
                <f.icon className={cn('size-5', on ? 'text-iris-400' : '')} />
                <span className="text-[12px] font-medium leading-tight">{f.title}</span>
              </button>
            );
          })}
        </div>

        <form
          className="mt-3 rounded-2xl border hairline bg-ink-900 p-4 focus-within:border-iris-400/60"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            rows={4}
            maxLength={1000}
            aria-label="Describe your video"
            placeholder={PLACEHOLDER[flow]}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                go();
              }
            }}
            className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-fog-100 placeholder:text-fog-500 focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t hairline pt-3">
            {intent ? (
              <div className="min-w-0 flex-1 text-xs" data-testid="intent-suggestion">
                <span className="text-white">
                  {mode && mode !== intent.flow ? <>You chose <b>{LABEL[flow]}</b> · we would suggest {LABEL[intent.flow]}</> : <>Suggested: <b>{LABEL[intent.flow]}</b></>}
                </span>
                <span className="text-fog-400"> · {intent.reasons.slice(1).join(' · ')}</span>
              </div>
            ) : (
              <div className="text-xs text-fog-500">{FLOWS.find((f) => f.key === flow)?.text} · {FLOWS.find((f) => f.key === flow)?.cost}</div>
            )}
            <Button type="submit" size="sm">Continue <ArrowRight /></Button>
          </div>
        </form>
      </section>

      <aside className="rounded-2xl border hairline bg-ink-900 p-4 lg:sticky lg:top-4 lg:self-start">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fog-400">Continue where you left off</div>
        <div className="mt-3 space-y-1">
          {(recent.data?.projects ?? []).slice(0, 6).map((p) => (
            <Link key={p.id} href={p.kind === 'movie' ? `/app/movie/${p.id}` : p.kind === 'ad' ? `/app/editor/${p.id}` : p.kind === 'edit' ? `/app/editor/${p.id}` : `/app/projects/${p.id}`} className="flex items-center gap-3 rounded-xl p-2 transition hover:bg-white/[0.04]">
              <span className="relative aspect-video w-20 shrink-0 overflow-hidden rounded-lg bg-ink-700">
                {p.thumbnailUrl ? <img src={p.thumbnailUrl} alt="" className="size-full object-cover" /> : <span className="grid size-full place-items-center bg-gradient-to-br from-iris-500/30 to-ink-800 text-[10px] text-fog-300">{kindLabel(p.kind)}</span>}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-white">{p.title}</span>
                <span className="block text-[11px] text-fog-500">{kindLabel(p.kind)} · {p.aspectRatio} · {timeAgo(p.updatedAt)}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-fog-500" />
            </Link>
          ))}
          {recent.data && !recent.data.projects.length && <p className="py-6 text-center text-xs text-fog-500">Your projects will appear here.</p>}
        </div>
        <Link href="/app/projects" className="mt-2 block text-xs text-iris-300 hover:text-white">All projects →</Link>
      </aside>
    </div>
  );
}
