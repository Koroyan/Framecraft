'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { CARTOON_STYLES } from '@framecraft/shared';
import { api, ApiError, type Asset, type Location } from '@/lib/api';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, NativeSelect, PageHeader, Textarea } from '@/components/ui';
import { ImageSlot } from '@/components/studio/upload';

/*
 * Location Studio: reusable places. A scene that uses a place gets its reference photos in every
 * shot (prompts and first frames), so the place looks like the same place from shot to shot.
 */

const META = [
  { key: 'setting', label: 'Interior or exterior', options: ['', 'interior', 'exterior', 'interior and exterior'] },
  { key: 'timeOfDay', label: 'Time of day', options: ['', 'dawn', 'morning', 'midday', 'golden hour', 'dusk', 'night'] },
  { key: 'weather', label: 'Weather', options: ['', 'clear', 'cloudy', 'rain', 'snow', 'fog', 'storm'] },
  { key: 'lighting', label: 'Lighting', options: ['', 'soft natural light', 'warm practical lamps', 'neon', 'candlelight', 'bright studio light', 'moonlight'] },
] as const;
const VIEWS = ['Wide view', 'Medium view', 'Detail', 'Another angle'];

type Form = { id?: string; name: string; description: string; meta: Record<string, string>; refs: (Asset | { id: string; url: string } | null)[] };

export default function LocationsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['locations'], queryFn: () => api<{ locations: Location[] }>('/api/locations') });
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const list = useMemo(() => (data?.locations ?? []).filter((l) => `${l.name} ${l.description}`.toLowerCase().includes(q.trim().toLowerCase())), [data, q]);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const styleMeta = Object.fromEntries(Object.entries(form.meta).filter(([, v]) => v.trim()));
      await api(form.id ? `/api/locations/${form.id}` : '/api/locations', { method: form.id ? 'PUT' : 'POST', body: { name: form.name, description: form.description, styleMeta, referenceAssetIds: form.refs.filter(Boolean).map((r) => r!.id) } });
      setForm(null);
      void qc.invalidateQueries({ queryKey: ['locations'] });
      toast.success('Location saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  const open = (l?: Location) =>
    setForm(l ? { id: l.id, name: l.name, description: l.description, meta: { ...(l.styleMeta ?? {}) }, refs: [...l.references.map((r) => ({ id: r.assetId, url: r.url })), null, null, null, null].slice(0, 4) } : { name: '', description: '', meta: {}, refs: [null, null, null, null] });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Location Studio" description="Reusable places. A scene set in a place uses its photos in every shot, so it stays the same place — as far as the model allows." actions={<Button onClick={() => open()}><Plus /> New location</Button>} />
      {(data?.locations.length ?? 0) > 3 && (
        <div className="mb-4 flex max-w-sm items-center gap-2 rounded-xl border hairline bg-ink-900 px-3 py-2">
          <Search className="size-4 text-fog-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search locations" aria-label="Search locations" className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-fog-500 focus:outline-none" />
        </div>
      )}
      {list.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((l) => (
            <Card key={l.id} className="overflow-hidden">
              <div className="grid aspect-video grid-cols-3 grid-rows-2 gap-px bg-ink-800">
                {l.references[0] ? <img src={l.references[0].url} alt="" className="col-span-2 row-span-2 size-full object-cover" /> : <div className="col-span-3 row-span-2 grid place-items-center text-fog-400"><MapPin /></div>}
                {l.references.slice(1, 3).map((r) => <img key={r.assetId} src={r.url} alt="" className="size-full object-cover" />)}
              </div>
              <div className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate font-medium text-white">{l.name}</div>
                  {l.styleMeta?.timeOfDay && <Badge>{l.styleMeta.timeOfDay}</Badge>}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-fog-300">{l.description || 'No description yet'}</p>
                <p className="mt-1 text-[11px] text-fog-500">
                  {l.usage?.scenes ? `In ${l.usage.scenes} scene${l.usage.scenes === 1 ? '' : 's'} · ${l.usage.projects} project${l.usage.projects === 1 ? '' : 's'}` : 'Not used in a scene yet'}
                  {l.references.length ? ` · ${l.references.length} reference${l.references.length === 1 ? '' : 's'}` : ' · no reference photo yet'}
                </p>
                <div className="mt-3 flex gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => open(l)}>Edit</Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${l.name}`}
                    onClick={async () => {
                      if (l.usage?.scenes && !window.confirm(`${l.name} is the place of ${l.usage.scenes} scene(s). Delete it anyway? Those scenes keep their shots but lose the place.`)) return;
                      await api(`/api/locations/${l.id}`, { method: 'DELETE' });
                      void qc.invalidateQueries({ queryKey: ['locations'] });
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState icon={<MapPin />} title={q ? 'No location matches' : 'No locations yet'} description="Create a place once and use it in any scene — from the storyboard, the graph or a shot’s details. Places made by the Movie Maker appear here too." action={<Button onClick={() => open()}>Create a location</Button>} />
      )}
      <Dialog open={Boolean(form)} onOpenChange={(o) => !o && setForm(null)} title={form?.id ? 'Edit location' : 'New location'} wide footer={<Button onClick={save} loading={busy} disabled={!form?.name}>Save location</Button>}>
        {form && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Moonlight Bakery" /></Field>
            <Field label="Visual style">
              <NativeSelect value={form.meta.style ?? ''} onChange={(e) => setForm({ ...form, meta: { ...form.meta, style: e.target.value } })}>
                <option value="">Photoreal / any</option>
                {CARTOON_STYLES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </NativeSelect>
            </Field>
            <div className="md:col-span-2">
              <Field label="Description" hint="What it looks like — written as it should appear in every shot."><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="A tiny bakery with blue tiles, a copper oven and shelves of cakes" /></Field>
            </div>
            {META.map((m) => (
              <Field key={m.key} label={m.label}>
                <NativeSelect value={form.meta[m.key] ?? ''} onChange={(e) => setForm({ ...form, meta: { ...form.meta, [m.key]: e.target.value } })}>
                  {m.options.map((o) => <option key={o} value={o}>{o || '—'}</option>)}
                </NativeSelect>
              </Field>
            ))}
            <Field label="Architecture">
              <Input value={form.meta.architecture ?? ''} onChange={(e) => setForm({ ...form, meta: { ...form.meta, architecture: e.target.value } })} placeholder="old stone walls, arched windows" />
            </Field>
            <Field label="Props">
              <Input value={form.meta.props ?? ''} onChange={(e) => setForm({ ...form, meta: { ...form.meta, props: e.target.value } })} placeholder="copper oven, flour sacks, cake stand" />
            </Field>
            <div className="md:col-span-2">
              <Field label="Reference photos" hint="A wide view first: it is the place's approved look. Add closer views and details for consistency.">
                <div className="grid grid-cols-4 gap-2">
                  {form.refs.map((r, i) => (
                    <ImageSlot key={i} label={VIEWS[i] ?? `Ref ${i + 1}`} asset={r as Asset | null} onChange={(a) => setForm({ ...form, refs: form.refs.map((x, j) => (j === i ? a : x)) })} />
                  ))}
                </div>
              </Field>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
