'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Button, Input, Label } from '@/components/ui';
import { Logo } from '@/components/logo';
import { FilmFrame } from '@/components/marketing/frames';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = () => {
    const prompt = params.get('prompt');
    const template = params.get('template');
    const n = params.get('next');
    if (n?.startsWith('/app')) return n;
    if (template) return `/app/create?template=${encodeURIComponent(template)}`;
    if (prompt) return `/app/create?prompt=${encodeURIComponent(prompt)}`;
    return '/app';
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') await api('/api/auth/register', { body: { email, password, name, acceptTerms: accept } });
      else await api('/api/auth/login', { body: { email, password } });
      await qc.invalidateQueries({ queryKey: ['me'] });
      if (mode === 'register') toast.success('Welcome! Your free trial credits are ready.');
      router.push(next());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="flex flex-col px-5 py-8 md:px-12">
        <Link href="/" aria-label="Home">
          <Logo />
        </Link>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <h1 className="text-3xl font-semibold tracking-tight text-white">{mode === 'login' ? 'Welcome back' : 'Create your studio'}</h1>
          <p className="mt-2 text-fog-300">{mode === 'login' ? 'Sign in to continue creating.' : 'Free trial credits included. No card required.'}</p>
          <form onSubmit={submit} className="mt-8 space-y-4">
            {mode === 'register' && (
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} />
              {mode === 'register' && <p className="mt-1.5 text-xs text-fog-400">At least 10 characters with letters and numbers.</p>}
            </div>
            {mode === 'register' && (
              <label className="flex items-start gap-3 text-sm text-fog-300">
                <input type="checkbox" className="mt-1 size-4 accent-iris-500" checked={accept} onChange={(e) => setAccept(e.target.checked)} required />
                <span>
                  I agree to the{' '}
                  <Link href="/legal/terms" className="text-iris-300 underline-offset-2 hover:underline" target="_blank">Terms</Link> and{' '}
                  <Link href="/legal/ai-policy" className="text-iris-300 underline-offset-2 hover:underline" target="_blank">AI content policy</Link>, and understand that generated videos are AI-made.
                </span>
              </label>
            )}
            {error && <div role="alert" className="rounded-xl bg-signal-red/10 px-3 py-2.5 text-sm text-signal-red">{error}</div>}
            <Button type="submit" size="lg" className="w-full" loading={busy}>
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-fog-400">
            {mode === 'login' ? (
              <>New here? <Link className="text-white hover:underline" href={`/register?${params.toString()}`}>Create an account</Link></>
            ) : (
              <>Already have an account? <Link className="text-white hover:underline" href={`/login?${params.toString()}`}>Sign in</Link></>
            )}
          </p>
        </div>
      </div>
      <div className="relative hidden overflow-hidden border-l hairline bg-ink-900 lg:block">
        <div className="absolute inset-0 grid grid-cols-2 gap-4 p-10 opacity-90">
          <FilmFrame scene="ocean" className="translate-y-10" />
          <FilmFrame scene="noir" className="-translate-y-6" />
        </div>
        <div className="absolute inset-x-10 bottom-10 rounded-2xl bg-black/50 p-5 backdrop-blur">
          <p className="font-display text-2xl italic text-white">“Simple for beginners. Powerful for professionals.”</p>
          <p className="mt-2 text-xs text-fog-400">Illustrative artwork — not AI output.</p>
        </div>
      </div>
    </div>
  );
}
