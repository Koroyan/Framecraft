'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Clapperboard, ImagePlay, Megaphone, Scissors, Sparkles, Wand2 } from 'lucide-react';
import { guessIntent, type CreateFlow, type CreateIntent } from '@framecraft/shared';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';

const FLOWS: { key: CreateFlow; icon: typeof Wand2; title: string; text: string; needs: string; cost: string }[] = [
  { key: 'ai', icon: Wand2, title: 'Create with AI', text: 'Describe an idea — get a video.', needs: 'A sentence', cost: 'Paid · price shown first' },
  { key: 'animate', icon: ImagePlay, title: 'Animate an image', text: 'Bring a photo to life with motion.', needs: 'One image', cost: 'Paid · price shown first' },
  { key: 'edit', icon: Scissors, title: 'Edit my video', text: 'Trim, text, music, colour, objects.', needs: 'Your clips', cost: 'Free editing' },
  { key: 'ad', icon: Megaphone, title: 'Create an advertisement', text: 'Your product, your footage, a real ad.', needs: 'Product videos or photos', cost: 'Paid parts priced first' },
  { key: 'film', icon: Clapperboard, title: 'Create a film', text: 'Story, characters, scenes and shots.', needs: 'An idea', cost: 'Paid · plan first' },
];

const LABEL: Record<CreateFlow, string> = { ai: 'AI video', animate: 'Animate an image', edit: 'Edit your video', ad: 'Advertisement', film: 'Film' };

function hrefFor(flow: CreateFlow, idea: string, intent: CreateIntent | null): string {
  const q = new URLSearchParams();
  if (flow === 'edit') {
    if (intent?.aspect) q.set('aspect', intent.aspect);
    return `/app/edit?${q}`;
  }
  if (flow === 'ad') {
    if (idea) q.set('idea', idea);
    if (intent?.durationSec) q.set('length', String(intent.durationSec));
    return `/app/ads/create?${q}`;
  }
  if (flow === 'film') {
    if (idea) q.set('idea', idea);
    if (intent?.durationSec) q.set('length', String(intent.durationSec));
    if (intent?.aspect) q.set('aspect', intent.aspect);
    return `/app/movie?${q}`;
  }
  if (idea) q.set('prompt', idea);
  if (intent?.aspect) q.set('aspect', intent.aspect);
  if (intent?.durationSec) q.set('duration', String(intent.durationSec));
  if (flow === 'animate') q.set('mode', 'animate');
  return `/app/create?${q}`;
}

/** New video: describe it (we suggest the right start) or pick one of five clear starting points. */
export default function NewVideoPage() {
  const router = useRouter();
  const [idea, setIdea] = useState('');
  const intent = useMemo(() => guessIntent(idea), [idea]);
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="rounded-3xl border hairline bg-gradient-to-br from-iris-500/15 via-transparent to-transparent p-5 md:p-7">
        <h1 className="text-2xl font-semibold text-white md:text-3xl">What do you want to make?</h1>
        <p className="mt-1 text-sm text-fog-300">Say it in your own words — Georgian, English or Russian. We suggest where to start; nothing is generated or charged here.</p>
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (intent) router.push(hrefFor(intent.flow, idea.trim(), intent));
          }}
        >
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            rows={2}
            maxLength={1000}
            aria-label="Describe your video"
            placeholder="e.g. A cinematic 20-second vertical ad for my handmade candles"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (intent) router.push(hrefFor(intent.flow, idea.trim(), intent));
              }
            }}
            className="w-full resize-none rounded-2xl border hairline bg-ink-900/70 px-4 py-3 text-[15px] text-fog-100 placeholder:text-fog-500 focus:border-iris-500/60 focus:outline-none"
          />
          {intent && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl border border-iris-400/30 bg-iris-500/[0.07] p-3" data-testid="intent-suggestion">
              <Sparkles className="size-4 shrink-0 text-iris-300" />
              <div className="min-w-0 flex-1 text-sm">
                <span className="text-white">Suggested: <b>{LABEL[intent.flow]}</b></span>
                <span className="text-fog-300"> · {intent.reasons.slice(1).join(' · ')}</span>
                <div className="text-[11px] text-fog-400">Because {intent.reasons[0]}. You can change everything on the next screen.</div>
              </div>
              <div className="flex gap-1.5">
                {FLOWS.filter((f) => f.key !== intent.flow).slice(0, 2).map((f) => (
                  <Link key={f.key} href={hrefFor(f.key, idea.trim(), intent)} className="rounded-lg px-2 py-1.5 text-xs text-fog-300 hover:bg-white/[0.06] hover:text-white">{LABEL[f.key]}</Link>
                ))}
                <Button type="submit" size="sm">Continue <ArrowRight /></Button>
              </div>
            </div>
          )}
        </form>
      </div>

      <div>
        <div className="mb-2 text-sm font-medium text-white">Or start here</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {FLOWS.map((f) => (
            <Link key={f.key} href={hrefFor(f.key, idea.trim(), intent)} className={cn('group flex flex-col rounded-2xl border hairline bg-ink-900/60 p-4 transition hover:border-iris-400/60 hover:bg-ink-900', intent?.flow === f.key && 'border-iris-400/60')}>
              <f.icon className="size-6 text-iris-300" />
              <div className="mt-3 text-sm font-semibold text-white">{f.title}</div>
              <div className="mt-1 flex-1 text-xs text-fog-300">{f.text}</div>
              <div className="mt-3 space-y-0.5 text-[11px] text-fog-500">
                <div>Needs: {f.needs}</div>
                <div>{f.cost}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
