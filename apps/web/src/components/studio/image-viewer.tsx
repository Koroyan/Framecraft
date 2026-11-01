'use client';

import { useEffect } from 'react';
import { Dialog as D } from 'radix-ui';
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/** `short`: a compact label for the thumbnail strip (falls back to `label`). */
export type ViewerImage = { url: string; label?: string; short?: string };

/**
 * Full-screen image viewer: the picture as large as the screen allows (never cropped), arrows and
 * ← / → to step through the set, thumbnails to jump, Esc to close.
 */
export function ImageViewer({ images, index, onIndex, title }: { images: ViewerImage[]; index: number | null; onIndex: (i: number | null) => void; title?: string }) {
  const open = index !== null && images.length > 0;
  const i = open ? Math.min(Math.max(0, index), images.length - 1) : 0;
  const cur = images[i];
  const step = (d: number) => onIndex((i + d + images.length) % images.length);

  useEffect(() => {
    if (!open || images.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <D.Root open={open} onOpenChange={(o) => !o && onIndex(null)}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm data-[state=open]:animate-fade-up" />
        <D.Content className="fixed inset-0 z-50 flex flex-col outline-none" aria-describedby={undefined}>
          <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
            <D.Title className="min-w-0 truncate text-sm font-medium text-white">
              {title}
              {cur?.label && <span className="text-fog-300">{title ? ' · ' : ''}{cur.label}</span>}
              {images.length > 1 && <span className="ml-2 text-xs tabular-nums text-fog-500">{i + 1} / {images.length}</span>}
            </D.Title>
            <span className="flex shrink-0 items-center gap-1">
              {cur && (
                <a href={cur.url} target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-fog-300 hover:bg-white/10 hover:text-white">
                  <ExternalLink className="size-3.5" /> Original
                </a>
              )}
              <D.Close className="grid size-8 place-items-center rounded-lg text-fog-300 hover:bg-white/10 hover:text-white" aria-label="Close">
                <X className="size-4" />
              </D.Close>
            </span>
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center px-4" onClick={(e) => e.target === e.currentTarget && onIndex(null)}>
            {cur && <img key={cur.url} src={cur.url} alt={cur.label ? `${cur.label} view` : 'Reference image'} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />}
            {images.length > 1 && (
              <>
                <button type="button" aria-label="Previous image" onClick={() => step(-1)} className="absolute left-3 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white ring-1 ring-white/15 transition hover:bg-black/70">
                  <ChevronLeft className="size-5" />
                </button>
                <button type="button" aria-label="Next image" onClick={() => step(1)} className="absolute right-3 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white ring-1 ring-white/15 transition hover:bg-black/70">
                  <ChevronRight className="size-5" />
                </button>
              </>
            )}
          </div>

          {images.length > 1 && (
            <div className="flex shrink-0 justify-center gap-2 overflow-x-auto px-4 py-3">
              {images.map((im, k) => (
                <button key={im.url + k} type="button" onClick={() => onIndex(k)} aria-label={`Show ${im.label ?? `image ${k + 1}`}`} aria-current={k === i} className={cn('relative h-16 shrink-0 overflow-hidden rounded-md ring-2 transition', k === i ? 'ring-iris-400' : 'opacity-60 ring-transparent hover:opacity-100')}>
                  <img src={im.url} alt="" className="h-full w-auto object-cover" />
                  {(im.short ?? im.label) && <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-center text-[9px] text-white">{im.short ?? im.label}</span>}
                </button>
              ))}
            </div>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
