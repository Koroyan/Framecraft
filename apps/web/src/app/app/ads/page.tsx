'use client';

import Link from 'next/link';
import { Film, Globe, ImageIcon, Package, Sparkles } from 'lucide-react';
import { ChatHome } from '@/components/chat/chat-view';
import { Badge, buttonVariants, Card } from '@/components/ui';
import { useCampaigns } from '@/lib/ads';
import { useBrandKits } from '@/lib/brand';
import { cn } from '@/lib/utils';

const ENTRY = [
  { from: 'videos', title: 'From my videos', text: 'MOV or MP4 straight from the phone, 4K included. We pick the strongest moments.', icon: Film },
  { from: 'photos', title: 'From product photos', text: 'A few photos become real shots with camera moves and detail crops.', icon: ImageIcon },
  { from: 'website', title: 'From my website', text: 'We read your public site into a brand profile you approve.', icon: Globe },
  { from: 'brand', title: 'From my brand', text: 'Pick a saved product: its footage and approved claims are used.', icon: Package },
];

/** Ad Studio overview: the main action, the four entry points, recent work and brands. */
export default function AdStudioHome() {
  const campaigns = useCampaigns();
  const brands = useBrandKits();
  const recent = (campaigns.data?.campaigns ?? []).slice(0, 6);
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="overflow-hidden rounded-3xl border border-iris-500/30 bg-gradient-to-br from-iris-500/20 via-transparent to-transparent p-6 md:p-8">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-iris-300">Ad Studio</div>
        <h1 className="mt-1 max-w-2xl text-2xl font-semibold text-white md:text-3xl">Cinematic ads from your real products</h1>
        <p className="mt-2 max-w-2xl text-sm text-fog-300">Upload your footage, connect your brand, and an AI creative director proposes concepts, storyboards every shot and cuts a fully editable ad. Your product stays exactly as it is.</p>
        <Link href="/app/ads/create" className={cn(buttonVariants({ size: 'lg' }), 'mt-5')}><Sparkles /> Create an Ad for My Brand</Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {ENTRY.map((e) => (
          <Link key={e.from} href={`/app/ads/create?from=${e.from}`} className="group rounded-2xl border hairline p-4 transition hover:border-iris-400/50 hover:bg-white/[0.02]">
            <e.icon className="size-5 text-iris-300" />
            <div className="mt-2 text-sm font-medium text-white">{e.title}</div>
            <p className="mt-1 text-xs text-fog-400">{e.text}</p>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-white">Recent ads</div>
            <Link href="/app/ads/campaigns" className="text-xs text-iris-200 hover:text-white">All</Link>
          </div>
          {!recent.length && <p className="text-xs text-fog-400">No ads yet. Your drafts and finished ads will appear here.</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {recent.map((c) => (
              <Link key={c.id} href={`/app/ads/footage/${c.id}`} className="rounded-xl border hairline p-3 hover:border-white/25">
                <div className="line-clamp-1 text-sm text-white">{c.title}</div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-fog-400">
                  <Badge tone={c.status === 'ready' ? 'green' : c.status === 'failed' ? 'red' : 'iris'}>{c.status}</Badge>
                  {new Date(c.updatedAt).toLocaleDateString()}
                </div>
              </Link>
            ))}
          </div>
          <p className="text-[11px] text-fog-500">Performance numbers appear here only when an ad platform account is connected. None are estimated or invented.</p>
        </Card>
        <Card className="space-y-2 p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-white">My Brands</div>
            <Link href="/app/ads/brand" className="text-xs text-iris-200 hover:text-white">Manage</Link>
          </div>
          {(brands.data?.brandKits ?? []).map((b) => (
            <Link key={b.id} href="/app/ads/brand" className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-white/[0.04]">
              {b.logoUrl ? <img src={b.logoUrl} alt="" className="size-8 rounded bg-white/5 object-contain" /> : <span className="size-8 rounded" style={{ background: b.colors.primary }} />}
              <span className="truncate text-sm text-fog-100">{b.name}</span>
            </Link>
          ))}
          {!brands.data?.brandKits.length && <Link href="/app/ads/brand" className={buttonVariants({ size: 'sm', variant: 'secondary' })}>Set up your brand</Link>}
        </Card>
      </div>

      <div>
        <div className="mb-2 text-sm font-medium text-white">Or describe an ad to generate from scratch</div>
        <ChatHome kind="ad" />
      </div>
    </div>
  );
}
