'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { ApiError } from '@/lib/api';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  // In the editor the top bar holds the workspace switch and Export: messages appear bottom-left there.
  const editor = /^\/app\/editor\//.test(usePathname() ?? '');
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster theme="dark" position={editor ? 'bottom-left' : 'top-center'} offset={editor ? 72 : undefined} toastOptions={{ style: { background: '#14141b', border: '1px solid rgba(255,255,255,0.08)', color: '#ececf2' } }} />
    </QueryClientProvider>
  );
}
