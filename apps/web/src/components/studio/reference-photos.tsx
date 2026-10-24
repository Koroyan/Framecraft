'use client';

import { ImagePlus, Loader2, X } from 'lucide-react';
import { photoTokensIn } from '@framecraft/shared';
import type { Asset } from '@/lib/api';
import { Button, Input } from '@/components/ui';
import { useUploader } from './upload';

export type ReferencePhoto = { token: string; asset: Asset; note: string };

const MAX = 12;

/**
 * User photos for the AI Movie Maker. Each photo gets a token (photo1, photo2…) the story
 * can mention — "a detective like photo1 lives in a house like photo2". Optional: without
 * photos the AI Director invents characters and places itself.
 */
export function ReferencePhotos({ photos, onChange, story, onInsert }: { photos: ReferencePhoto[]; onChange: (p: ReferencePhoto[]) => void; story: string; onInsert: (token: string) => void }) {
  const up = useUploader({ kind: 'reference' });
  const nextToken = () => {
    for (let i = 1; i <= MAX; i++) if (!photos.some((p) => p.token === `photo${i}`)) return `photo${i}`;
    return null;
  };
  const add = async () => {
    const token = nextToken();
    if (!token) return;
    const asset = await up.pick();
    if (asset) {
      onChange([...photos, { token, asset, note: '' }]);
      if (!new RegExp(`\\b${token}\\b`, 'i').test(story)) onInsert(token);
    }
  };
  const mentioned = photoTokensIn(story);
  const missing = mentioned.filter((t) => !photos.some((p) => p.token === t));

  return (
    <div className="space-y-3">
      {up.element}
      <div className="flex flex-wrap items-start gap-3">
        {photos.map((p, i) => (
          <div key={p.token} className="w-[132px] space-y-1.5">
            <div className="group relative aspect-square overflow-hidden rounded-xl border hairline">
              <img src={p.asset.url} alt={`Reference ${p.token}`} className="size-full object-cover" />
              <button type="button" onClick={() => onInsert(p.token)} className="absolute bottom-1.5 left-1.5 rounded-full bg-iris-500 px-2 py-0.5 text-[11px] font-semibold text-white shadow" title={`Insert ${p.token} into the story`}>
                {p.token}
              </button>
              <button type="button" aria-label={`Remove ${p.token}`} onClick={() => onChange(photos.filter((_, j) => j !== i))} className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/70 text-white">
                <X className="size-3.5" />
              </button>
              {!mentioned.includes(p.token) && <span className="absolute right-1 bottom-1.5 rounded bg-black/70 px-1 text-[9px] text-fog-200">not in text</span>}
            </div>
            <Input value={p.note} onChange={(e) => onChange(photos.map((x, j) => (j === i ? { ...x, note: e.target.value.slice(0, 200) } : x)))} placeholder="Who/what is it?" aria-label={`Note for ${p.token}`} className="h-8 px-2 text-xs" />
          </div>
        ))}
        {photos.length < MAX && (
          <button type="button" onClick={add} className="flex aspect-square w-[132px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed hairline text-fog-400 transition hover:border-iris-500/50 hover:text-fog-100">
            {up.busy ? <Loader2 className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}
            <span className="text-[12px]">Add photo</span>
            <span className="text-[11px] text-fog-400">{nextToken()}</span>
          </button>
        )}
      </div>
      {missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-signal-amber/10 px-3 py-2 text-xs text-signal-amber">
          Your story mentions {missing.join(', ')} but no photo is uploaded for {missing.length > 1 ? 'them' : 'it'}.
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={add}>Upload</Button>
        </div>
      )}
    </div>
  );
}
