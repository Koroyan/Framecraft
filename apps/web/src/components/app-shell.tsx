'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Clapperboard,
  Megaphone,
  Coins,
  Film,
  FolderKanban,
  History,
  Home,
  LayoutTemplate,
  LogOut,
  MapPin,
  Menu,
  Plus,
  Settings,
  Shield,
  Smartphone,
  Sparkles,
  Users,
  Wand2,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useMe, useSystemStatus } from '@/lib/hooks';
import { cn, formatCredits, timeAgo } from '@/lib/utils';
import { Logo } from '@/components/logo';
import { Dialog, Spinner } from '@/components/ui';

const NAV = [
  { href: '/app', label: 'Dashboard', icon: Home, exact: true },
  { href: '/app/create', label: 'Quick Create', icon: Wand2 },
  { href: '/app/social', label: 'Social Studio', icon: Smartphone },
  { href: '/app/cinematic', label: 'Cinematic Studio', icon: Sparkles },
  { href: '/app/movie', label: 'AI Movie Maker', icon: Clapperboard },
  { href: '/app/ads', label: 'Ad Studio', icon: Megaphone },
  { divider: 'Library' },
  { href: '/app/projects', label: 'Projects', icon: FolderKanban },
  { href: '/app/templates', label: 'Templates', icon: LayoutTemplate },
  { href: '/app/characters', label: 'Characters', icon: Users },
  { href: '/app/locations', label: 'Locations', icon: MapPin },
  { href: '/app/history', label: 'History', icon: History },
  { divider: 'Account' },
  { href: '/app/billing', label: 'Credits & Billing', icon: Coins },
  { href: '/app/settings', label: 'Settings', icon: Settings },
] as const;

type NavItem = { href: string; label: string; icon: typeof Home; exact?: boolean };

function NavLink({ item, onClick }: { item: NavItem; onClick?: () => void }) {
  const path = usePathname();
  const active = item.exact ? path === item.href : path.startsWith(item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={cn('flex items-center gap-3 rounded-xl px-3 py-2 text-[14px] transition', active ? 'bg-white/[0.07] text-white' : 'text-fog-300 hover:bg-white/[0.04] hover:text-white')}
    >
      <Icon className={cn('size-[18px]', active ? 'text-iris-300' : '')} />
      {item.label}
    </Link>
  );
}

function NavList({ isAdmin, onNavigate }: { isAdmin: boolean; onNavigate?: () => void }) {
  return (
    <nav className="space-y-0.5">
      {NAV.map((n, i) =>
        'divider' in n ? (
          <div key={i} className="px-3 pb-1 pt-5 text-[11px] font-medium uppercase tracking-[0.14em] text-fog-400">
            {n.divider}
          </div>
        ) : (
          <NavLink key={n.href} item={n as NavItem} onClick={onNavigate} />
        ),
      )}
      {isAdmin && <NavLink item={{ href: '/app/admin', label: 'Admin', icon: Shield }} onClick={onNavigate} />}
    </nav>
  );
}

function CreditPill({ balance, reserved }: { balance: number; reserved: number }) {
  return (
    <Link href="/app/billing" className="flex items-center gap-2 rounded-full border hairline bg-white/[0.03] px-3 py-1.5 text-[13px] text-fog-100 transition hover:border-white/20" title={reserved ? `${formatCredits(reserved)} reserved for running jobs` : 'Available credits'}>
      <Coins className="size-3.5 text-signal-amber" />
      <span className="font-medium tabular-nums">{formatCredits(balance - reserved)}</span>
      {reserved > 0 && <span className="text-fog-400">({formatCredits(reserved)} held)</span>}
    </Link>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: { id: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string }[]; unread: number }>('/api/notifications'),
    refetchInterval: 20_000,
  });
  return (
    <>
      <button
        type="button"
        aria-label="Notifications"
        onClick={async () => {
          setOpen(true);
          if (data?.unread) {
            await api('/api/notifications/read', { body: {} });
            void qc.invalidateQueries({ queryKey: ['notifications'] });
          }
        }}
        className="relative grid size-9 place-items-center rounded-full text-fog-300 transition hover:bg-white/5 hover:text-white"
      >
        <Bell className="size-[18px]" />
        {Boolean(data?.unread) && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-iris-400" />}
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="Notifications">
        <div className="space-y-1">
          {!data?.notifications.length && <p className="py-6 text-center text-sm text-fog-400">Nothing yet.</p>}
          {data?.notifications.map((n) => (
            <Link key={n.id} href={n.link ?? '/app'} onClick={() => setOpen(false)} className="block rounded-xl px-3 py-2.5 hover:bg-white/5">
              <div className="text-sm font-medium text-white">{n.title}</div>
              {n.body && <div className="text-xs text-fog-300">{n.body}</div>}
              <div className="mt-0.5 text-[11px] text-fog-400">{timeAgo(n.createdAt)}</div>
            </Link>
          ))}
        </div>
      </Dialog>
    </>
  );
}

function DevBanner() {
  const { data } = useSystemStatus();
  if (!data || data.liveGenerationEnabled) return null;
  return (
    <div className="border-b border-signal-amber/20 bg-signal-amber/[0.07] px-4 py-2 text-center text-[12.5px] text-signal-amber">
      {data.mode === 'development' ? 'Development mode' : 'Setup mode'}: live AI generation is off.{' '}
      {data.devFixtures ? 'Videos are clearly labelled test fixtures — not AI output — and cost no credits.' : 'Generation will be available once providers are configured.'}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useMe();
  const router = useRouter();
  const path = usePathname();
  const qc = useQueryClient();
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (!isLoading && !data?.user) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [isLoading, data, router, path]);

  if (isLoading || !data?.user) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  const isAdmin = data.user.role === 'admin';
  const logout = async () => {
    await api('/api/auth/logout', { body: {} });
    qc.clear();
    router.push('/');
  };

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[260px_1fr]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r hairline bg-ink-900/60 px-3 py-5 lg:flex">
        <Link href="/app" className="mb-6 px-3">
          <Logo />
        </Link>
        <Link href="/app/create" className="mb-4 flex items-center justify-center gap-2 rounded-xl bg-iris-500 px-3 py-2.5 text-sm font-medium text-white shadow-[0_8px_30px_-12px_rgb(124_108_255/0.9)] transition hover:bg-iris-400">
          <Plus className="size-4" /> New video
        </Link>
        <div className="flex-1 overflow-y-auto">
          <NavList isAdmin={isAdmin} />
        </div>
        <div className="mt-4 rounded-2xl border hairline p-3">
          <div className="truncate text-sm font-medium text-white">{data.user.name}</div>
          <div className="truncate text-xs text-fog-400">{data.plan?.name} plan</div>
          <button onClick={logout} className="mt-2 flex items-center gap-2 text-xs text-fog-300 hover:text-white">
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <DevBanner />
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b hairline bg-ink-950/80 px-4 backdrop-blur-xl md:px-6">
          <Link href="/app" className="lg:hidden">
            <Logo small />
          </Link>
          <div className="hidden text-sm text-fog-400 lg:block">{data.plan?.name} · up to {data.plan?.limits.maxResolution}</div>
          <div className="flex items-center gap-1.5">
            {data.wallet && <CreditPill balance={data.wallet.balance} reserved={data.wallet.reserved} />}
            <Notifications />
          </div>
        </header>
        <main className="flex-1 px-4 pb-28 pt-6 md:px-8 md:pt-8 lg:pb-12">{children}</main>
      </div>

      {/* Mobile bottom navigation */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t hairline bg-ink-900/90 backdrop-blur-xl lg:hidden" aria-label="Primary">
        <div className="mx-auto grid max-w-md grid-cols-5 items-end px-2 pt-1.5">
          {[
            { href: '/app', icon: Home, label: 'Home', exact: true },
            { href: '/app/projects', icon: Film, label: 'Projects' },
          ].map((n) => (
            <MobileTab key={n.href} {...n} />
          ))}
          <Link href="/app/create" aria-label="Create" className="mx-auto -mt-5 mb-1 grid size-14 place-items-center rounded-2xl bg-iris-500 text-white shadow-[0_10px_30px_-8px_rgb(124_108_255/0.9)]">
            <Plus className="size-6" />
          </Link>
          <MobileTab href="/app/history" icon={History} label="History" />
          <button type="button" onClick={() => setMoreOpen(true)} className="flex flex-col items-center gap-0.5 py-1.5 text-[10.5px] text-fog-300">
            <Menu className="size-5" />
            More
          </button>
        </div>
      </nav>
      <Dialog open={moreOpen} onOpenChange={setMoreOpen} title="Menu">
        <NavList isAdmin={isAdmin} onNavigate={() => setMoreOpen(false)} />
        <button onClick={logout} className="mt-4 flex items-center gap-3 px-3 py-2 text-sm text-fog-300">
          <LogOut className="size-[18px]" /> Sign out
        </button>
      </Dialog>
    </div>
  );
}

function MobileTab({ href, icon: Icon, label, exact }: { href: string; icon: typeof Home; label: string; exact?: boolean }) {
  const path = usePathname();
  const active = exact ? path === href : path.startsWith(href);
  return (
    <Link href={href} className={cn('flex flex-col items-center gap-0.5 py-1.5 text-[10.5px]', active ? 'text-white' : 'text-fog-300')}>
      <Icon className={cn('size-5', active && 'text-iris-300')} />
      {label}
    </Link>
  );
}
