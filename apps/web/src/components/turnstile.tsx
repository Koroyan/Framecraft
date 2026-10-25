'use client';

import { useEffect, useRef } from 'react';

/* Cloudflare Turnstile bot check (only rendered when the server has a site key configured). */

type TurnstileApi = { render: (el: HTMLElement, o: { sitekey: string; theme?: string; callback: (t: string) => void; 'expired-callback'?: () => void; 'error-callback'?: () => void }) => string; reset: (id?: string) => void; remove: (id: string) => void };
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    let s = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
    if (!s) {
      s = document.createElement('script');
      s.src = SRC;
      s.async = true;
      document.head.appendChild(s);
    }
    s.addEventListener('load', () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile unavailable'))));
    s.addEventListener('error', () => reject(new Error('Turnstile could not load')));
  });
}

export function Turnstile({ siteKey, onToken, resetKey }: { siteKey: string; onToken: (t: string | null) => void; resetKey?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  useEffect(() => {
    let id: string | undefined;
    let api: TurnstileApi | undefined;
    loadScript()
      .then((t) => {
        api = t;
        if (el.current) id = t.render(el.current, { sitekey: siteKey, theme: 'dark', callback: (tok) => cb.current(tok), 'expired-callback': () => cb.current(null), 'error-callback': () => cb.current(null) });
      })
      .catch(() => cb.current(null));
    return () => {
      if (api && id) api.remove(id);
    };
  }, [siteKey, resetKey]);
  return <div ref={el} className="min-h-[65px]" />;
}
