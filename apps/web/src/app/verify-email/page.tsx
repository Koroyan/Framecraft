'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { buttonVariants, Spinner } from '@/components/ui';
import { Logo } from '@/components/logo';

/** Landing page of the confirmation link sent by email. */
export default function VerifyEmailPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}

function Verify() {
  const token = useSearchParams().get('token') ?? '';
  const qc = useQueryClient();
  const [state, setState] = useState<{ kind: 'working' | 'ok' | 'error'; message?: string }>({ kind: 'working' });
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    api('/api/auth/verify-email', { body: { token } })
      .then(() => {
        setState({ kind: 'ok' });
        void qc.invalidateQueries({ queryKey: ['me'] });
      })
      .catch((e) => setState({ kind: 'error', message: e instanceof ApiError ? e.message : 'Could not confirm the email' }));
  }, [token, qc]);
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-5">
      <Logo />
      {state.kind === 'working' && <div className="flex items-center gap-2 text-fog-200"><Spinner /> Confirming your email…</div>}
      {state.kind === 'ok' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-lg text-white"><CheckCircle2 className="size-5 text-signal-green" /> Email confirmed</div>
          <p className="text-sm text-fog-300">You can now choose a credit pack and start creating.</p>
          <div className="flex gap-2">
            <Link href="/app/billing" className={buttonVariants()}>Choose credits</Link>
            <Link href="/app" className={buttonVariants({ variant: 'secondary' })}>Open the studio</Link>
          </div>
        </div>
      )}
      {state.kind === 'error' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-lg text-white"><XCircle className="size-5 text-signal-red" /> {state.message}</div>
          <Link href="/app" className={buttonVariants({ variant: 'secondary' })}>Open the studio to request a new link</Link>
        </div>
      )}
    </div>
  );
}
