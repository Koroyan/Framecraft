'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ImagePlus, MapPin, Plus, Trash2, UserRound, X } from 'lucide-react';
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
  const [removing, setRemoving] = useState<{ kind: Kind; el: Element } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const qc = useQueryClient();
  const remove = async () => {
    if (!removing) return;
    setDeleting(true);
    try {
      await api(`${API[removing.kind]}/${removing.el.id}`, { method: 'DELETE' });
      if (removing.kind === 'character') onCharacters(characterIds.filter((x) => x !== removing.el.id));
      else onLocations(locationIds.filter((x) => x !== removing.el.id));
      await qc.invalidateQueries({ queryKey: [KEY[removing.kind]] });
      toast.success(`${removing.el.name} deleted`);
      setRemoving(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete');
    } finally {
      setDeleting(false);
    }
  };

  const toggle = (ids: string[], id: string, max: number, set: (v: string[]) => void) => {
    if (ids.includes(id)) set(ids.filter((x) => x !== id));
    else if (ids.length >= max) toast.error(`Up to ${max} at a time`);
    else set([...ids, id]);
  };
  const [open, setOpen] = useState<Kind | null>(null);
  const [q, setQ] = useState('');
  const pickedChars = (chars.data ?? []).filter((c) => characterIds.includes(c.id));
  const pickedLocs = (locs.data ?? []).filter((l) => locationIds.includes(l.id));

  const chip = (kind: Kind, e: Element, Icon: typeof UserRound) => (
    <span key={e.id} className="flex shrink-0 items-center gap-2 rounded-xl border border-iris-400/50 bg-iris-500/15 py-1 pl-1 pr-1.5 text-xs text-white" title={e.description}>
      {e.references[0] ? <img src={e.references[0].url} alt="" className="size-7 rounded-lg object-cover" /> : <span className="grid size-7 place-items-center rounded-lg bg-white/[0.06]"><Icon className="size-3.5" /></span>}
      <span className="max-w-32 truncate">{e.name}</span>
      <button type="button" aria-label={`Remove ${e.name}`} title="Remove from this video" onClick={() => (kind === 'character' ? onCharacters(characterIds.filter((x) => x !== e.id)) : onLocations(locationIds.filter((x) => x !== e.id)))} className="grid size-5 place-items-center rounded-md text-fog-300 hover:bg-white/10 hover:text-white">
        <X className="size-3" />
      </button>
    </span>
  );

  const list = open === 'character' ? (chars.data ?? []) : open === 'location' ? (locs.data ?? []) : [];
  const shown = list.filter((e) => e.name.toLowerCase().includes(q.trim().toLowerCase()));
  const ids = open === 'character' ? characterIds : locationIds;
  const openPicker = (k: Kind) => {
    setQ('');
    setOpen(k);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-fog-200">
          Characters &amp; places <span className="font-normal text-fog-400">· optional — keeps the same face and place in every video</span>
        </span>
        <span className="text-[11px] text-fog-500">
          or type <kbd className="rounded bg-white/[0.06] px-1 font-mono text-fog-300">@</kbd> in the description
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {pickedChars.map((c) => chip('character', c, UserRound))}
        {pickedLocs.map((l) => chip('location', l, MapPin))}
        <button type="button" onClick={() => openPicker('character')} className="flex shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-white/15 px-3 py-2 text-xs text-fog-300 transition hover:border-iris-400 hover:text-white">
          <UserRound className="size-3.5" /> Add character
        </button>
        <button type="button" onClick={() => openPicker('location')} className="flex shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-white/15 px-3 py-2 text-xs text-fog-300 transition hover:border-iris-400 hover:text-white">
          <MapPin className="size-3.5" /> Add place
        </button>
      </div>
      <Dialog
        open={Boolean(open)}
        onOpenChange={(o) => !o && setOpen(null)}
        title={open === 'character' ? 'Choose characters' : 'Choose a place'}
        description={open === 'character' ? 'Pick up to 5 saved characters. Their photos keep the face the same.' : 'Pick up to 2 saved places.'}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                const k = open;
                setOpen(null);
                setCreating(k);
              }}
            >
              <Plus /> New {open === 'character' ? 'character' : 'place'}
            </Button>
            <Button onClick={() => setOpen(null)}>Done</Button>
          </>
        }
      >
        <div className="space-y-2">
          {list.length > 5 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" aria-label="Search saved" autoFocus />}
          <div className="max-h-[50dvh] space-y-1 overflow-y-auto">
            {shown.map((e) => {
              const on = ids.includes(e.id);
              const Icon = open === 'character' ? UserRound : MapPin;
              return (
                <div key={e.id} className={cn('group flex items-center gap-2 rounded-xl border p-1.5 transition', on ? 'border-iris-400/60 bg-iris-500/10' : 'border-transparent hover:bg-white/[0.04]')}>
                  <button type="button" aria-pressed={on} onClick={() => (open === 'character' ? toggle(characterIds, e.id, 5, onCharacters) : toggle(locationIds, e.id, 2, onLocations))} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                    {e.references[0] ? <img src={e.references[0].url} alt="" className="size-10 rounded-lg object-cover" /> : <span className="grid size-10 place-items-center rounded-lg bg-white/[0.06]"><Icon className="size-4" /></span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-white">{e.name}</span>
                      {e.description && <span className="block truncate text-[11px] text-fog-500">{e.description}</span>}
                    </span>
                    <span className={cn('grid size-5 shrink-0 place-items-center rounded-md border', on ? 'border-iris-400 bg-iris-500 text-white' : 'border-white/20')}>{on && <Check className="size-3" />}</span>
                  </button>
                  <button type="button" aria-label={`Delete ${e.name}`} title={`Delete ${e.name} from your library`} onClick={() => setRemoving({ kind: open!, el: e })} className="grid size-7 shrink-0 place-items-center rounded-md text-fog-500 opacity-0 transition hover:bg-signal-red/15 hover:text-signal-red focus-visible:opacity-100 group-hover:opacity-100">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })}
            {!list.length && <p className="py-6 text-center text-sm text-fog-400">Nothing saved yet — make one with “New {open === 'character' ? 'character' : 'place'}”.</p>}
            {list.length > 0 && !shown.length && <p className="py-4 text-center text-sm text-fog-400">No match.</p>}
          </div>
        </div>
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete ${removing?.el.name ?? ''}?`}
        description={removing?.kind === 'character' ? 'The character is removed from your library; its photos stay in your Media Library. Films already made are not changed.' : 'The location is removed from your library. Films already made are not changed.'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" loading={deleting} onClick={remove}><Trash2 /> Delete</Button>
          </>
        }
      >
        <span />
      </Dialog>
      <QuickCreate
        kind={creating}
        onClose={() => setCreating(null)}
        onCreated={(kind, id) => (kind === 'character' ? onCharacters([...characterIds, id].slice(-5)) : onLocations([...locationIds, id].slice(-2)))}
      />
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
