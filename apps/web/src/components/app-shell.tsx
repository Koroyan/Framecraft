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
  Scissors,
  Search,
  Image as ImageIcon,
} from 'lucide-react';
import { EditorChrome } from '@/components/editor-chrome';
import { CommandPalette, type PaletteItem } from '@/components/command-palette';
import { api, ApiError } from '@/lib/api';
import { toast } from 'sonner';
import { useMe, useSystemStatus } from '@/lib/hooks';
import { cn, formatCredits, timeAgo } from '@/lib/utils';
import { Logo } from '@/components/logo';
import { Dialog, Spinner } from '@/components/ui';

const NAV = [
  { href: '/app', label: 'Home', icon: Home, exact: true },
  { divider: 'Create' },
  { href: '/app/create', label: 'Create with AI', icon: Wand2, hint: 'AI video from a sentence or an image' },
  { href: '/app/edit', label: 'Video Editor', icon: Scissors, hint: 'Edit your own clips' },
  { href: '/app/social', label: 'Social Studio', icon: Smartphone, hint: 'TikTok, Reels, Shorts' },
  { href: '/app/ads', label: 'Ad Studio', icon: Megaphone, hint: 'Product ads' },
  { href: '/app/movie', label: 'AI Movie Maker', icon: Clapperboard, hint: 'Films with a story' },
  { href: '/app/cinematic', label: 'Cinematic Studio', icon: Sparkles, hint: 'Single cinematic shots' },
  { divider: 'Library' },
  { href: '/app/projects', label: 'Projects', icon: FolderKanban },
  { href: '/app/media', label: 'Media', icon: ImageIcon },
  { href: '/app/templates', label: 'Templates', icon: LayoutTemplate },
  { href: '/app/characters', label: 'Characters', icon: Users },
  { href: '/app/locations', label: 'Locations', icon: MapPin },
  { href: '/app/history', label: 'History', icon: History },
  { divider: 'Account' },
  { href: '/app/billing', label: 'Credits & Billing', icon: Coins },
  { href: '/app/settings', label: 'Settings', icon: Settings },
] as const;

const PALETTE: PaletteItem[] = [
  ...NAV.filter((n): n is Extract<(typeof NAV)[number], { href: string }> => 'href' in n).map((n) => ({ label: n.label, hint: 'hint' in n ? n.hint : 'Go to', href: n.href, icon: n.icon })),
  { label: 'New video', hint: 'Action', href: '/app/new', icon: Plus, keywords: 'generate create start' },
  { label: 'Animate an image', hint: 'Action', href: '/app/create?mode=animate', icon: Wand2, keywords: 'photo image to video' },
  { label: 'New edit project', hint: 'Action', href: '/app/edit', icon: Scissors, keywords: 'capcut timeline editor' },
  { label: 'Create an ad for my brand', hint: 'Action', href: '/app/ads/create', icon: Megaphone, keywords: 'advert commercial' },
  { label: 'Chat with the AI Director', hint: 'Action', href: '/app/movie/chat', icon: Clapperboard, keywords: 'film story' },
  { label: 'Upload media', hint: 'Action', href: '/app/media', icon: ImageIcon, keywords: 'import video photo' },
  { label: 'Buy credits', hint: 'Action', href: '/app/billing', icon: Coins, keywords: 'payment price' },
];

type NavItem = { href: string; label: string; icon: typeof Home; exact?: boolean; hint?: string };

function NavLink({ item, onClick }: { item: NavItem; onClick?: () => void }) {
  const path = usePathname();
  const active = item.exact ? path === item.href : path.startsWith(item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onClick}
      title={item.hint}
      aria-current={active ? 'page' : undefined}
      className={cn('flex items-center gap-3 rounded-xl px-3 py-[7px] text-[13.5px] transition', active ? 'bg-white/[0.08] text-white' : 'text-fog-300 hover:bg-white/[0.04] hover:text-white')}
    >
      <Icon className={cn('size-[17px]', active ? 'text-iris-300' : '')} />
      {item.label}
    </Link>
  );
}

function NavList({ isAdmin, onNavigate }: { isAdmin: boolean; onNavigate?: () => void }) {
  return (
    <nav className="space-y-0.5">
      {NAV.map((n, i) =>
        'divider' in n ? (
          <div key={i} className="px-3 pb-1 pt-4 text-[10.5px] font-medium uppercase tracking-[0.14em] text-fog-500">
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

  // The editor is a full-screen workspace (like desktop and mobile video editors) with a single
  // header row of its own: the shell's home link and tools go into it.
  if (/^\/app\/editor\/[^/]+$/.test(path))
    return (
      <div className="flex min-h-dvh flex-col">
        <CommandPalette items={PALETTE} />
        <EditorChrome.Provider
          value={{
            home: <Link href="/app" aria-label="Home" title="Home"><Logo small /></Link>,
            tools: (
              <>
                <SearchButton compact />
                {data.wallet && <CreditPill balance={data.wallet.balance} reserved={data.wallet.reserved} />}
                <Notifications />
              </>
            ),
          }}
        >
          <main className="flex-1 px-3 py-2">{children}</main>
        </EditorChrome.Provider>
      </div>
    );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[260px_1fr]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r hairline bg-ink-900/60 px-3 py-5 lg:flex">
        <Link href="/app" className="mb-6 px-3">
          <Logo />
        </Link>
        <Link href="/app/new" className="mb-4 flex items-center justify-center gap-2 rounded-xl bg-iris-500 px-3 py-2.5 text-sm font-medium text-white shadow-[0_8px_30px_-12px_rgb(124_108_255/0.9)] transition hover:bg-iris-400">
          <Plus className="size-4" /> New video
        </Link>
        <div className="flex-1 overflow-y-auto">
          <NavList isAdmin={isAdmin} />
        </div>
        <div className="mt-3 flex items-center gap-2.5 rounded-xl border hairline p-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-iris-500/25 text-xs font-semibold text-iris-200">{initials(data.user.name)}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-white">{data.user.name}</div>
            <div className="truncate text-[11px] text-fog-400">{data.plan?.name} plan</div>
          </div>
          <button onClick={logout} aria-label="Sign out" title="Sign out" className="grid size-8 place-items-center rounded-lg text-fog-400 hover:bg-white/5 hover:text-white">
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <CommandPalette items={PALETTE} />
        <DevBanner />
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b hairline bg-ink-950/80 px-4 backdrop-blur-xl md:px-6">
          <Link href="/app" className="lg:hidden">
            <Logo small />
          </Link>
          <div className="hidden min-w-0 flex-1 lg:block"><SearchButton /></div>
          <div className="flex items-center gap-1.5">
            <span className="lg:hidden"><SearchButton compact /></span>
            {data.wallet && <CreditPill balance={data.wallet.balance} reserved={data.wallet.reserved} />}
            <Notifications />
          </div>
        </header>
        <main className="flex-1 px-4 pb-28 pt-6 md:px-8 md:pt-8 lg:pb-12">
          {data?.verificationRequired && <VerifyBanner email={data.user?.email ?? ''} />}
          {children}
        </main>
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
          <Link href="/app/new" aria-label="Create" className="mx-auto -mt-5 mb-1 grid size-14 place-items-center rounded-2xl bg-iris-500 text-white shadow-[0_10px_30px_-8px_rgb(124_108_255/0.9)]">
            <Plus className="size-6" />
          </Link>
          <MobileTab href="/app/edit" icon={Scissors} label="Editor" />
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

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

/** Opens the command palette (Ctrl/Cmd + K). */
function SearchButton({ compact }: { compact?: boolean }) {
  const open = () => window.dispatchEvent(new Event('fc-open-palette'));
  if (compact)
    return (
      <button type="button" aria-label="Search (Ctrl+K)" onClick={open} className="grid size-9 place-items-center rounded-full text-fog-300 hover:bg-white/5 hover:text-white">
        <Search className="size-[18px]" />
      </button>
    );
  return (
    <button type="button" onClick={open} className="flex h-9 w-full max-w-sm items-center gap-2 rounded-xl border hairline bg-white/[0.03] px-3 text-left text-[13px] text-fog-400 transition hover:border-white/20">
      <Search className="size-4" />
      <span className="flex-1">Search or jump to…</span>
      <kbd className="rounded border hairline px-1.5 text-[10px]">Ctrl K</kbd>
    </button>
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

/** Unconfirmed email: buying credits (and so generating) waits for the confirmation link. */
function VerifyBanner({ email }: { email: string }) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div role="status" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-signal-amber/30 bg-signal-amber/10 px-4 py-3 text-sm text-signal-amber">
      <span>Confirm your email to buy credits and start creating — we sent a link to <b>{email}</b>.</span>
      <button
        type="button"
        disabled={busy || sent}
        className="rounded-lg border border-signal-amber/40 px-3 py-1 text-xs hover:bg-signal-amber/10 disabled:opacity-60"
        onClick={async () => {
          setBusy(true);
          try {
            await api('/api/auth/resend-verification', { body: {} });
            setSent(true);
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : 'Could not send the email');
          } finally {
            setBusy(false);
          }
        }}
      >
        {sent ? 'Sent — check your inbox' : 'Send the link again'}
      </button>
    </div>
  );
}
