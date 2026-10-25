'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Clapperboard, FolderOpen, LayoutDashboard, LayoutTemplate, Palette, Sparkles } from 'lucide-react';
import { buttonVariants } from '@/components/ui';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/app/ads', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/app/ads/brand', label: 'My Brands', icon: Palette },
  { href: '/app/ads/create', label: 'Create Advertisement', icon: Sparkles },
  { href: '/app/ads/library', label: 'Media Library', icon: FolderOpen },
  { href: '/app/ads/campaigns', label: 'Creative Studio', icon: Clapperboard },
  { href: '/app/ads/templates', label: 'Brand Templates', icon: LayoutTemplate },
];

/** Ad Studio workspace: one navigation for brands, media, creation, storyboards and templates. */
export default function AdStudioLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const active = (n: (typeof NAV)[number]) => (n.exact ? path === n.href : path.startsWith(n.href) || (n.href === '/app/ads/campaigns' && path.startsWith('/app/ads/footage/')));
  const inChat = /^\/app\/ads\/[0-9a-f-]{36}$/.test(path);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Ad Studio" className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 pb-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n) ? 'page' : undefined}
              className={cn('flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-[13px] transition', active(n) ? 'bg-white/[0.08] text-white' : 'text-fog-400 hover:bg-white/[0.04] hover:text-fog-100')}
            >
              <n.icon className="size-3.5" />
              {n.label}
            </Link>
          ))}
        </nav>
        {path !== '/app/ads' && !path.startsWith('/app/ads/create') && !inChat && (
          <Link href="/app/ads/create" className={buttonVariants({ size: 'sm' })}>
            <Sparkles /> Create an Ad for My Brand
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}
