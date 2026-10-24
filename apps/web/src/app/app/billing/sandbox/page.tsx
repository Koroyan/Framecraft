'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Button, Card, Skeleton } from '@/components/ui';

function SandboxInner() {
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const id = params.get('payment');
  const { data } = useQuery({ queryKey: ['payment', id], queryFn: () => api<{ payment: { id: string; kind: string; productKey: string; amountCents: number; currency: string; credits: number; status: string } }>(`/api/billing/payments/${id}`), enabled: Boolean(id) });
  const [busy, setBusy] = useState(false);
  const complete = async (outcome: 'success' | 'failure') => {
    setBusy(true);
    try {
      await api('/api/billing/sandbox/complete', { body: { paymentId: id, outcome } });
      await qc.invalidateQueries();
      router.push(`/app/billing?status=${outcome === 'success' ? 'success' : 'cancelled'}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed');
      setBusy(false);
    }
  };
  if (!data) return <Skeleton className="mx-auto mt-10 h-64 max-w-md" />;
  const p = data.payment;
  return (
    <Card className="mx-auto mt-10 max-w-md p-6">
      <div className="mb-4 flex items-center gap-2 text-signal-amber">
        <FlaskConical className="size-5" /> <span className="font-medium">Sandbox checkout — no real payment</span>
      </div>
      <div className="text-sm text-fog-300">{p.kind === 'credits' ? `${p.credits} credits` : `${p.productKey} plan subscription`}</div>
      <div className="mt-1 text-3xl font-semibold text-white">${(p.amountCents / 100).toFixed(2)}</div>
      <p className="mt-3 text-xs text-fog-400">This page simulates the payment provider so the full billing flow can be tested in development. It is disabled in production.</p>
      <div className="mt-6 flex gap-2">
        <Button onClick={() => complete('success')} loading={busy} disabled={p.status !== 'pending'}>Simulate success</Button>
        <Button variant="ghost" onClick={() => complete('failure')} disabled={busy || p.status !== 'pending'}>Simulate failure</Button>
      </div>
      {p.status !== 'pending' && <p className="mt-3 text-sm text-fog-300">This payment is already {p.status}.</p>}
    </Card>
  );
}

export default function SandboxPage() {
  return (
    <Suspense>
      <SandboxInner />
    </Suspense>
  );
}
