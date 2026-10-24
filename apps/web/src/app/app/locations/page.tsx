'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type Asset, type Location } from '@/lib/api';
import { Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Textarea } from '@/components/ui';
import { ImageSlot } from '@/components/studio/upload';

export default function LocationsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['locations'], queryFn: () => api<{ locations: Location[] }>('/api/locations') });
  const [form, setForm] = useState<{ id?: string; name: string; description: string; refs: (Asset | { id: string; url: string } | null)[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await api(form.id ? `/api/locations/${form.id}` : '/api/locations', { method: form.id ? 'PUT' : 'POST', body: { name: form.name, description: form.description, referenceAssetIds: form.refs.filter(Boolean).map((r) => r!.id) } });
      setForm(null);
      void qc.invalidateQueries({ queryKey: ['locations'] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Locations" description="Reusable settings so every scene in a place looks like the same place." actions={<Button onClick={() => setForm({ name: '', description: '', refs: [null, null, null] })}><Plus /> New location</Button>} />
      {data?.locations.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.locations.map((l) => (
            <Card key={l.id} className="overflow-hidden">
              <div className="aspect-video bg-ink-800">
                {l.references[0] ? <img src={l.references[0].url} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-fog-400"><MapPin /></div>}
              </div>
              <div className="p-4">
                <div className="font-medium text-white">{l.name}</div>
                <p className="mt-1 line-clamp-2 text-sm text-fog-300">{l.description}</p>
                <div className="mt-3 flex gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => setForm({ id: l.id, name: l.name, description: l.description, refs: [...l.references.map((r) => ({ id: r.assetId, url: r.url })), null, null, null].slice(0, 3) })}>Edit</Button>
                  <Button size="icon" variant="ghost" aria-label="Delete" onClick={async () => { await api(`/api/locations/${l.id}`, { method: 'DELETE' }); void qc.invalidateQueries({ queryKey: ['locations'] }); }}>
                    <Trash2 />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState icon={<MapPin />} title="No locations yet" description="Locations created by the Movie Maker appear here too." />
      )}
      <Dialog open={Boolean(form)} onOpenChange={(o) => !o && setForm(null)} title={form?.id ? 'Edit location' : 'New location'} footer={<Button onClick={save} loading={busy} disabled={!form?.name}>Save</Button>}>
        {form && (
          <div className="space-y-4">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Description" hint="Architecture, time of day, weather, palette."><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <Field label="Reference images">
              <div className="grid grid-cols-3 gap-2">
                {form.refs.map((r, i) => (
                  <ImageSlot key={i} label={`Ref ${i + 1}`} asset={r as Asset | null} onChange={(a) => setForm({ ...form, refs: form.refs.map((x, j) => (j === i ? a : x)) })} />
                ))}
              </div>
            </Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}
