'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ImagePlus, MapPin, Plus, UserRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Button, Dialog, Field, Input, Textarea } from '@/components/ui';
import { useUploader } from '@/components/studio/upload';
import { cn } from '@/lib/utils';

type Ref = { assetId: string; url: string; isPrimary: boolean };
type Element = { id: string; name: string; description: string; references: Ref[] };
type Kind = 'character' | 'location';

const API = { character: '/api/characters', location: '/api/locations' } as const;
const KEY = { character: 'characters', location: 'locations' } as const;

export function useElements(kind: Kind) {
  return useQuery({ queryKey: [KEY[kind]], queryFn: () => api<Record<string, Element[]>>(API[kind]).then((r) => r[KEY[kind]] ?? []) });
}

/**
 * Pick saved characters / locations for any video. Their photos and descriptions keep faces and
 * places consistent (the first frame is drawn from them). New ones can be created right here.
 */
export function CastPicker({ characterIds, locationIds, onCharacters, onLocations }: { characterIds: string[]; locationIds: string[]; onCharacters: (ids: string[]) => void; onLocations: (ids: string[]) => void }) {
  const chars = useElements('character');
  const locs = useElements('location');
  const [creating, setCreating] = useState<Kind | null>(null);

  const toggle = (ids: string[], id: string, max: number, set: (v: string[]) => void) => {
    if (ids.includes(id)) set(ids.filter((x) => x !== id));
    else if (ids.length >= max) toast.error(`Up to ${max} at a time`);
    else set([...ids, id]);
  };

  const chip = (e: Element, on: boolean, onClick: () => void, Icon: typeof UserRound) => (
    <button
      key={e.id}
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={e.description}
      className={cn('flex shrink-0 items-center gap-2 rounded-xl border py-1 pl-1 pr-3 text-xs transition', on ? 'border-iris-400 bg-iris-500/15 text-white' : 'border-white/10 text-fog-200 hover:border-white/25')}
    >
      {e.references[0] ? <img src={e.references[0].url} alt="" className="size-7 rounded-lg object-cover" /> : <span className="grid size-7 place-items-center rounded-lg bg-white/[0.06]"><Icon className="size-3.5" /></span>}
      <span className="max-w-28 truncate">{e.name}</span>
      {on && <Check className="size-3.5 text-iris-300" />}
    </button>
  );

  return (
    <div className="space-y-3">
      <Row label="Characters" hint="Same face in every video" onAdd={() => setCreating('character')}>
        {(chars.data ?? []).map((c) => chip(c, characterIds.includes(c.id), () => toggle(characterIds, c.id, 5, onCharacters), UserRound))}
        {chars.data && !chars.data.length && <span className="text-xs text-fog-400">No characters yet — add one with a photo.</span>}
      </Row>
      <Row label="Locations" hint="Same place every time" onAdd={() => setCreating('location')}>
        {(locs.data ?? []).map((l) => chip(l, locationIds.includes(l.id), () => toggle(locationIds, l.id, 2, onLocations), MapPin))}
        {locs.data && !locs.data.length && <span className="text-xs text-fog-400">No locations yet.</span>}
      </Row>
      <QuickCreate
        kind={creating}
        onClose={() => setCreating(null)}
        onCreated={(kind, id) => (kind === 'character' ? onCharacters([...characterIds, id].slice(-5)) : onLocations([...locationIds, id].slice(-2)))}
      />
    </div>
  );
}

function Row({ label, hint, onAdd, children }: { label: string; hint: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-fog-200">
          {label} <span className="font-normal text-fog-400">· {hint}</span>
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {children}
        <button type="button" onClick={onAdd} className="flex shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-white/15 px-3 py-1.5 text-xs text-fog-300 transition hover:border-iris-400 hover:text-white">
          <Plus className="size-3.5" /> New
        </button>
      </div>
    </div>
  );
}

/** Create a character or location in place: name, a sentence, and 1–3 photos. */
export function QuickCreate({ kind, onClose, onCreated }: { kind: Kind | null; onClose: () => void; onCreated?: (kind: Kind, id: string) => void }) {
  const qc = useQueryClient();
  const up = useUploader({ kind: 'reference' });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<{ id: string; url: string }[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const reset = () => {
    setName('');
    setDescription('');
    setPhotos([]);
    setConsent(false);
  };
  const save = async () => {
    if (!kind) return;
    setBusy(true);
    try {
      const body = kind === 'character' ? { name, description, appearance: { distinguishing: description.slice(0, 400) }, referenceAssetIds: photos.map((p) => p.id), likenessConsent: consent } : { name, description, referenceAssetIds: photos.map((p) => p.id) };
      const r = await api<Record<string, { id: string }>>(API[kind], { body });
      await qc.invalidateQueries({ queryKey: [KEY[kind]] });
      toast.success(`${kind === 'character' ? 'Character' : 'Location'} saved`);
      onCreated?.(kind, r[kind]!.id);
      reset();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  const isChar = kind === 'character';
  return (
    <Dialog
      open={Boolean(kind)}
      onOpenChange={(o) => !o && onClose()}
      title={isChar ? 'New character' : 'New location'}
      description={isChar ? 'A clear, well-lit photo of the face (1–3 photos) keeps the character identical in every shot.' : 'Photos of the place keep it the same in every shot.'}
      footer={
        <Button onClick={save} loading={busy} disabled={!name.trim() || (isChar && photos.length > 0 && !consent)}>
          Save
        </Button>
      }
    >
      {up.element}
      <div className="space-y-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={isChar ? 'Nino' : 'Old Tbilisi courtyard'} maxLength={80} autoFocus />
        </Field>
        <Field label={isChar ? 'Look & personality' : 'Description'} hint={isChar ? 'Age, hair, clothing, anything distinctive' : 'Time of day, mood, details'}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} />
        </Field>
        <div className="flex flex-wrap gap-2">
          {photos.map((p) => (
            <span key={p.id} className="relative">
              <img src={p.url} alt="" className="size-16 rounded-xl object-cover" />
              <button type="button" aria-label="Remove photo" onClick={() => setPhotos((x) => x.filter((y) => y.id !== p.id))} className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-ink-700 text-fog-100">
                <X className="size-3" />
              </button>
            </span>
          ))}
          {photos.length < 3 && (
            <button
              type="button"
              onClick={async () => {
                const a = await up.pick();
                if (a) setPhotos((x) => [...x, { id: a.id, url: a.url }]);
              }}
              className="grid size-16 place-items-center rounded-xl border border-dashed border-white/15 text-fog-300 hover:border-iris-400 hover:text-white"
              aria-label="Add photo"
            >
              <ImagePlus className="size-5" />
            </button>
          )}
        </div>
        {isChar && photos.length > 0 && (
          <label className="flex items-start gap-2.5 text-xs text-fog-200">
            <input type="checkbox" className="mt-0.5 size-4 accent-iris-500" checked={consent} onChange={(e) => setConsent(e.target.checked)} />I have the right and the consent of any real person shown in these photos to use their likeness.
          </label>
        )}
      </div>
    </Dialog>
  );
}
