'use client';

import Link from 'next/link';
import { Clapperboard, Film, Palette } from 'lucide-react';
import { ChatHome } from '@/components/chat/chat-view';
import { buttonVariants } from '@/components/ui';
import { cn } from '@/lib/utils';

export default function AdStudioHome() {
  return (
    <div className="space-y-6">
      <div className="mx-auto grid max-w-3xl gap-3 sm:grid-cols-[1.4fr_1fr]">
        <Link href="/app/ads/footage" className="group rounded-2xl border border-iris-500/40 bg-gradient-to-br from-iris-500/20 to-transparent p-4 transition hover:border-iris-400">
          <div className="flex items-center gap-2 text-sm font-semibold text-white"><Film className="size-4 text-iris-300" /> Create an ad from my videos</div>
          <p className="mt-1 text-xs text-fog-300">Upload your real product footage. AI studies it, writes a storyboard, and cuts a finished, editable ad — your product stays exactly as filmed.</p>
          <span className={cn(buttonVariants({ size: 'sm' }), 'mt-3')}>Start</span>
        </Link>
        <div className="grid gap-3">
          <Link href="/app/ads/brand" className="flex items-center gap-2 rounded-2xl border hairline p-4 text-sm text-fog-100 hover:border-white/25"><Palette className="size-4 text-iris-300" /> Brand kit <span className="text-xs text-fog-400">logo, colours, CTAs</span></Link>
          <div className="flex items-center gap-2 rounded-2xl border hairline p-4 text-sm text-fog-300"><Clapperboard className="size-4" /> Or chat below to generate an ad from scratch</div>
        </div>
      </div>
      <ChatHome kind="ad" />
    </div>
  );
}
