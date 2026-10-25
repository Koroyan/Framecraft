'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Dialog as D } from 'radix-ui';
import { ArrowRight, FolderKanban, Search } from 'lucide-react';
import { api, type Project } from '@/lib/api';
import { cn } from '@/lib/utils';
import { KIND_LABEL, projectHref } from '@/lib/projects';

/*
 * Ctrl/Cmd + K: jump anywhere — pages, quick actions and your projects — from the keyboard.
 */

export type PaletteItem = { label: string; hint?: string; href: string; icon?: React.ComponentType<{ className?: string }>; keywords?: string };

export function CommandPalette({ items }: { items: PaletteItem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const projects = useQuery({ queryKey: ['projects', 'palette'], queryFn: () => api<{ projects: Project[] }>('/api/projects'), enabled: open, staleTime: 30_000 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('fc-open-palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('fc-open-palette', onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const proj: PaletteItem[] = (projects.data?.projects ?? []).slice(0, 50).map((p) => ({ label: p.title, hint: KIND_LABEL[p.kind] ?? p.kind, href: projectHref(p), icon: FolderKanban }));
    const all = [...items, ...proj];
    if (!needle) return all.slice(0, 12);
    return all.filter((x) => `${x.label} ${x.hint ?? ''} ${x.keywords ?? ''}`.toLowerCase().includes(needle)).slice(0, 14);
  }, [q, items, projects.data]);

  const go = (x: PaletteItem | undefined) => {
    if (!x) return;
    setOpen(false);
    router.push(x.href);
  };

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <D.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
          }}
          className="fixed left-1/2 top-[12dvh] z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border hairline bg-ink-900 shadow-2xl"
        >
          <D.Title className="sr-only">Search and jump</D.Title>
          <div className="flex items-center gap-2 border-b hairline px-4">
            <Search className="size-4 text-fog-400" />
            <input
              ref={input}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(results.length - 1, a + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === 'Enter') go(results[active]);
              }}
              placeholder="Search pages, actions and projects…"
              className="h-12 flex-1 bg-transparent text-sm text-white placeholder:text-fog-500 focus:outline-none"
            />
            <kbd className="rounded border hairline px-1.5 text-[10px] text-fog-400">Esc</kbd>
          </div>
          <div role="listbox" className="max-h-[50dvh] overflow-y-auto p-1.5">
            {results.map((x, i) => (
              <button
                key={`${x.href}-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(x)}
                className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm', i === active ? 'bg-white/[0.07] text-white' : 'text-fog-200')}
              >
                {x.icon ? <x.icon className="size-4 text-iris-300" /> : <ArrowRight className="size-4 text-fog-500" />}
                <span className="min-w-0 flex-1 truncate">{x.label}</span>
                {x.hint && <span className="shrink-0 text-[11px] text-fog-500">{x.hint}</span>}
              </button>
            ))}
            {!results.length && <p className="px-3 py-6 text-center text-sm text-fog-400">Nothing found.</p>}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
