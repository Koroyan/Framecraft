'use client';

import { useState } from 'react';
import { Images, Loader2, MapPin, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Button, Dialog } from '@/components/ui';
import { cn, newKey } from '@/lib/utils';
import { ImageViewer } from '@/components/studio/image-viewer';

export type ViewKind = 'character' | 'location';
type Estimate = { available: boolean; credits: number; perImage: number };
/** A reference image of a character or place; `view` says which reference view it is, if any. */
export type RefImage = { url?: string; view?: string | null };

const PATH = { character: '/api/characters', location: '/api/locations' } as const;
/** The four reference views, in the order they are shown (keys as the server stores them). */
export const VIEWS = {
  character: [
    { key: 'front', label: 'Front' },
    { key: 'three-quarter', label: '¾' },
    { key: 'side', label: 'Side' },
    { key: 'back', label: 'Back' },
  ],
  location: [
    { key: 'wide', label: 'Wide' },
    { key: 'reverse', label: 'Reverse' },
    { key: 'side', label: 'Side' },
    { key: 'detail', label: 'Detail' },
  ],
} as const;
const LONG_LABEL: Record<string, string> = { '¾': 'Three-quarter' };

/**
 * The element's reference images: the four views in their own slots (front, ¾, side, back · wide,
 * reverse, side, detail) whichever order they were made in, then the user's own photos. Full-body
 * views get tall slots so nothing is cut off; click any image to see it full size.
 */
export function ViewStrip({ kind, items, pending = 0, name, className }: { kind: ViewKind; items: RefImage[]; pending?: number; name?: string; className?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const Icon = kind === 'character' ? UserRound : MapPin;
  const views = VIEWS[kind];
  const withUrl = items.filter((x): x is { url: string; view?: string | null } => Boolean(x.url));
  const byView = new Map(withUrl.filter((x) => x.view && views.some((v) => v.key === x.view)).map((x) => [x.view!, x.url]));
  const photos = withUrl.filter((x) => !x.view || !views.some((v) => v.key === x.view)).map((x) => x.url);
  // No views yet: the photos lead (labelled as photos); otherwise the four view slots come first.
  const slots: { url?: string; label: string; waiting: boolean }[] = byView.size
    ? [...views.map((v) => ({ url: byView.get(v.key), label: v.label, waiting: false })), ...photos.map((url) => ({ url, label: 'Photo', waiting: false }))]
    : [...photos.map((url) => ({ url, label: 'Photo', waiting: false }))];
  // Empty slots name the view they are for until there are photos or views to show.
  while (slots.length < 4) slots.push({ label: byView.size || photos.length ? '' : views[slots.length]!.label, waiting: false });
  // Views still being made show a spinner in their empty slots.
  let left = pending;
  for (const s of slots) {
    if (s.url || left <= 0) continue;
    s.waiting = true;
    left--;
  }
  const shown = slots.slice(0, 8);
  const gallery = shown.filter((s) => s.url).map((s) => ({ url: s.url!, label: LONG_LABEL[s.label] ?? s.label, short: s.label }));
  return (
    <>
      <div className={cn('grid grid-cols-4 gap-1.5', className)}>
        {shown.map((s, i) => {
          const box = cn('relative overflow-hidden rounded-lg border bg-ink-950', kind === 'character' ? 'aspect-[9/16]' : 'aspect-video', s.url ? 'hairline' : 'border-dashed border-white/10');
          const tag = s.label && <span className="pointer-events-none absolute bottom-0.5 left-1 rounded bg-black/60 px-1 text-[9px] text-white/85">{s.label}</span>;
          return s.url ? (
            <button key={i} type="button" onClick={() => setOpen(gallery.findIndex((g) => g.url === s.url))} aria-label={`Open the ${(LONG_LABEL[s.label] ?? s.label).toLowerCase() || 'reference'} image${name ? ` of ${name}` : ''}`} className={cn(box, 'group cursor-zoom-in transition hover:border-iris-400/70 focus-visible:border-iris-400')}>
              <img src={s.url} alt="" className="size-full object-cover object-top transition duration-200 group-hover:scale-[1.03]" loading="lazy" />
              {tag}
            </button>
          ) : (
            <div key={i} className={box}>
              <span className="grid size-full place-items-center text-fog-500">{s.waiting ? <Loader2 className="size-4 animate-spin text-iris-300" /> : <Icon className="size-4" />}</span>
              {tag}
            </div>
          );
        })}
      </div>
      <ImageViewer images={gallery} index={open} onIndex={setOpen} title={name} />
    </>
  );
}

/**
 * "Make 4 views": shows the price first, then creates front / ¾ / side / back (or wide / reverse /
 * side / detail) reference images. Paid images — nothing starts without the user's confirmation.
 */
export function ViewsButton({ kind, id, name, projectId, style, pending = 0, hasViews, onStarted, size = 'sm', className }: { kind: ViewKind; id: string; name: string; projectId?: string; style?: string; pending?: number; hasViews?: boolean; onStarted?: () => void; size?: 'sm' | 'md'; className?: string }) {
  const [est, setEst] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState<'estimate' | 'start' | null>(null);
  if (pending > 0)
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-xs text-iris-200', className)}>
        <Loader2 className="size-3.5 animate-spin" /> Making views… {pending} left
      </span>
    );
  const ask = async () => {
    setBusy('estimate');
    try {
      const e = await api<Estimate>(`${PATH[kind]}/${id}/views/estimate`);
      if (!e.available) return void toast.error('Image generation is not set up on this server.');
      setEst(e);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not get the price');
    } finally {
      setBusy(null);
    }
  };
  const start = async () => {
    setBusy('start');
    try {
      await api(`${PATH[kind]}/${id}/views`, { body: { idempotencyKey: newKey(), projectId, style } });
      toast.success(`Making 4 views of ${name} — they appear here as they finish.`);
      setEst(null);
      onStarted?.();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start');
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Button size={size} variant="secondary" className={className} onClick={ask} loading={busy === 'estimate'} title={kind === 'character' ? 'Front, three-quarter, side and back — the same face and outfit in every shot' : 'Wide, reverse, side and detail — the same place in every shot'}>
        <Images /> {hasViews ? 'New 4 views' : 'Make 4 views'}
      </Button>
      <Dialog
        open={Boolean(est)}
        onOpenChange={(o) => !o && setEst(null)}
        title={`4 views of ${name}`}
        description={kind === 'character' ? 'Front, three-quarter, side and back on a plain background. The first view sets the look; the other three follow it, so the face and outfit stay the same.' : 'Wide, reverse angle, side and detail. The first view sets the place; the others follow it.'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEst(null)}>Cancel</Button>
            <Button onClick={start} loading={busy === 'start'}>
              <Images /> Make them · {est?.credits} credits
            </Button>
          </>
        }
      >
        <p className="text-sm text-fog-300">About {est?.credits} credits for four images (≈{est?.perImage} each), reserved now and charged per finished image. Failed images are refunded.</p>
      </Dialog>
    </>
  );
}

/** One price and one confirmation for every element without reference images (a film's cast). */
export function ViewsForAll({ items, projectId, style, onStarted }: { items: { kind: ViewKind; id: string; name: string }[]; projectId?: string; style?: string; onStarted?: () => void }) {
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState<'estimate' | 'start' | null>(null);
  if (!items.length) return null;
  const ask = async () => {
    setBusy('estimate');
    try {
      const all = await Promise.all(items.map((it) => api<Estimate>(`${PATH[it.kind]}/${it.id}/views/estimate`)));
      if (all.some((e) => !e.available)) return void toast.error('Image generation is not set up on this server.');
      setTotal(all.reduce((s, e) => s + e.credits, 0));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not get the price');
    } finally {
      setBusy(null);
    }
  };
  const start = async () => {
    setBusy('start');
    let ok = 0;
    for (const it of items) {
      try {
        await api(`${PATH[it.kind]}/${it.id}/views`, { body: { idempotencyKey: newKey(), projectId, style } });
        ok++;
      } catch (err) {
        toast.error(`${it.name}: ${err instanceof ApiError ? err.message : 'could not start'}`);
        break;
      }
    }
    if (ok) toast.success(`Making views for ${ok} of ${items.length}.`);
    setTotal(null);
    setBusy(null);
    onStarted?.();
  };
  const chars = items.filter((i) => i.kind === 'character').length;
  const places = items.length - chars;
  return (
    <>
      <Button onClick={ask} loading={busy === 'estimate'}>
        <Images /> Make views for all {items.length}
      </Button>
      <Dialog
        open={total !== null}
        onOpenChange={(o) => !o && setTotal(null)}
        title={`Reference views for ${[chars && `${chars} character${chars > 1 ? 's' : ''}`, places && `${places} place${places > 1 ? 's' : ''}`].filter(Boolean).join(' and ')}`}
        description="Four images each — so every shot draws the same faces, outfits and places from any angle."
        footer={
          <>
            <Button variant="ghost" onClick={() => setTotal(null)}>Cancel</Button>
            <Button onClick={start} loading={busy === 'start'}>
              <Images /> Make {items.length * 4} images · {total} credits
            </Button>
          </>
        }
      >
        <p className="text-sm text-fog-300">About {total} credits in all, reserved now and charged per finished image. Failed images are refunded.</p>
      </Dialog>
    </>
  );
}
