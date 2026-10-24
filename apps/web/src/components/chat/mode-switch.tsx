'use client';

import Link from 'next/link';
import { LayoutList, MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

/** AI Movie Maker has two ways in: a guided chat with the AI Director, or the classic form. */
export function MovieModeSwitch({ mode }: { mode: 'chat' | 'form' }) {
  const item = (m: 'chat' | 'form', href: string, label: string, Icon: typeof LayoutList) => (
    <Link
      href={href}
      aria-current={mode === m ? 'page' : undefined}
      className={cn('flex items-center gap-2 rounded-xl px-4 py-2 text-sm transition', mode === m ? 'bg-white text-ink-950' : 'text-fog-200 hover:text-white')}
    >
      <Icon className="size-4" /> {label}
    </Link>
  );
  return (
    <div className="mx-auto mb-6 flex w-fit gap-1 rounded-2xl border hairline bg-ink-900 p-1">
      {item('chat', '/app/movie/chat', 'Chat with the AI Director', MessagesSquare)}
      {item('form', '/app/movie', 'Form', LayoutList)}
    </div>
  );
}
