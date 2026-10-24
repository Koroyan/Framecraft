'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Coins } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, PageHeader, Skeleton } from '@/components/ui';
import { cn, formatCredits, timeAgo } from '@/lib/utils';
import { newKey } from '@/lib/utils';

type Billing = {
  wallet: { balance: number; reserved: number; available: number; lifetimePurchased: number; lifetimeSpent: number };
  plan: { key: string; name: string; monthlyCredits: number; limits: Record<string, unknown> };
  ledger: { id: string; type: string; amount: number; balanceAfter: number; description: string; createdAt: string }[];
  payments: { id: string; kind: string; productKey: string; amountCents: number; currency: string; status: string; createdAt: string }[];
  subscription: { planKey: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean } | null;
};
type Plans = { plans: { key: string; name: string; description: string; priceCents: number; monthlyCredits: number; features: string[] }[]; packs: { key: string; name: string; credits: number; priceCents: number }[]; provider: string; paymentsConfigured: boolean };

const TYPE_LABEL: Record<string, string> = { grant: 'Free credits', purchase: 'Purchase', subscription_allowance: 'Monthly allowance', reserve: 'Reserved', release: 'Released', capture: 'Charged', refund: 'Refund', adjustment: 'Adjustment', expire: 'Expired' };

function BillingInner() {
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const b = useQuery({ queryKey: ['billing'], queryFn: () => api<Billing>('/api/billing') });
  const p = useQuery({ queryKey: ['plans'], queryFn: () => api<Plans>('/api/billing/plans') });
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (params.get('status') === 'success') toast.success('Payment received — credits will appear shortly.');
    if (params.get('status') === 'cancelled') toast.message('Checkout cancelled.');
  }, [params]);

  const checkout = async (kind: 'credits' | 'subscription', productKey: string) => {
    setBusy(productKey);
    try {
      const r = await api<{ checkoutUrl: string }>('/api/billing/checkout', { body: { kind, productKey, idempotencyKey: newKey() } });
      if (r.checkoutUrl.startsWith('/')) router.push(r.checkoutUrl);
      else window.location.href = r.checkoutUrl;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Checkout unavailable');
    } finally {
      setBusy(null);
    }
  };

  if (!b.data || !p.data) return <Skeleton className="mx-auto h-96 max-w-5xl" />;
  const { wallet, plan, ledger, subscription } = b.data;
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader title="Credits & Billing" description="Credits are reserved when a generation starts and settled at the real model cost when it finishes. Failed generations are refunded automatically." />
      {!p.data.paymentsConfigured && <Card className="p-4 text-sm text-signal-amber">Payments are not configured on this server yet.</Card>}
      {p.data.provider === 'sandbox' && p.data.paymentsConfigured && <Card className="p-4 text-sm text-signal-amber">Sandbox payments: checkouts are simulated and no real money moves. Configure a payment provider before launch.</Card>}

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-sm text-fog-300"><Coins className="size-4 text-signal-amber" /> Available</div>
          <div className="mt-2 text-3xl font-semibold tabular-nums text-white">{formatCredits(wallet.available)}</div>
          {wallet.reserved > 0 && <div className="text-xs text-fog-400">{formatCredits(wallet.reserved)} held for running jobs</div>}
        </Card>
        <Card className="p-5">
          <div className="text-sm text-fog-300">Plan</div>
          <div className="mt-2 text-2xl font-semibold text-white">{plan.name}</div>
          <div className="text-xs text-fog-400">{subscription ? `Renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}${subscription.cancelAtPeriodEnd ? ' · cancels at period end' : ''}` : 'No active subscription'}</div>
          {subscription && !subscription.cancelAtPeriodEnd && (
            <Button size="sm" variant="ghost" className="mt-2 px-0" onClick={async () => { await api('/api/billing/subscription/cancel', { body: {} }); void qc.invalidateQueries({ queryKey: ['billing'] }); toast.message('Your plan will end at the close of this period.'); }}>Cancel subscription</Button>
          )}
        </Card>
        <Card className="p-5">
          <div className="text-sm text-fog-300">Lifetime</div>
          <div className="mt-2 text-sm text-fog-100">{formatCredits(wallet.lifetimeSpent)} credits used</div>
          <div className="text-sm text-fog-100">{formatCredits(wallet.lifetimePurchased)} credits purchased</div>
        </Card>
      </div>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-white">Plans</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {p.data.plans.map((pl) => (
            <Card key={pl.key} className={cn('flex flex-col p-5', pl.key === plan.key && 'border-iris-500/50')}>
              <div className="flex items-center justify-between">
                <div className="font-semibold text-white">{pl.name}</div>
                {pl.key === plan.key && <Badge tone="iris">Current</Badge>}
              </div>
              <div className="mt-2 text-2xl font-semibold text-white">${(pl.priceCents / 100).toFixed(0)}<span className="text-sm font-normal text-fog-400">{pl.priceCents ? '/mo' : ''}</span></div>
              <ul className="mt-3 flex-1 space-y-1.5">
                {pl.features.map((f) => <li key={f} className="flex gap-2 text-xs text-fog-300"><Check className="size-3.5 shrink-0 text-iris-400" />{f}</li>)}
              </ul>
              {pl.priceCents > 0 && pl.key !== plan.key && (
                <Button className="mt-4" size="sm" onClick={() => checkout('subscription', pl.key)} loading={busy === pl.key} disabled={!p.data!.paymentsConfigured}>Choose {pl.name}</Button>
              )}
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-white">Buy credits</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {p.data.packs.map((pk) => (
            <Card key={pk.key} className="flex items-center justify-between p-4">
              <div>
                <div className="font-medium text-white">{pk.name}</div>
                <div className="text-sm text-fog-400">${(pk.priceCents / 100).toFixed(0)}</div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => checkout('credits', pk.key)} loading={busy === pk.key} disabled={!p.data!.paymentsConfigured}>Buy</Button>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-white">Credit history</h2>
        <Card className="divide-y divide-white/5">
          {ledger.map((l) => (
            <div key={l.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="truncate text-fog-100">{l.description}</div>
                <div className="text-xs text-fog-400">{TYPE_LABEL[l.type] ?? l.type} · {timeAgo(l.createdAt)}</div>
              </div>
              <div className={cn('shrink-0 tabular-nums', l.type === 'reserve' || l.type === 'release' ? 'text-fog-400' : l.amount > 0 ? 'text-signal-green' : 'text-fog-100')}>
                {l.type === 'reserve' ? `hold ${formatCredits(l.amount)}` : l.type === 'release' ? `free ${formatCredits(l.amount)}` : `${l.amount > 0 ? '+' : ''}${formatCredits(l.amount)}`}
              </div>
            </div>
          ))}
          {!ledger.length && <div className="p-6 text-center text-sm text-fog-400">No activity yet.</div>}
        </Card>
      </section>
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense>
      <BillingInner />
    </Suspense>
  );
}
