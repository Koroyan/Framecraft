'use client';

import { useState } from 'react';
import { ImagePlus, Plus, Save } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Button, Card, Field, Input, Textarea } from '@/components/ui';
import { useUploader } from '@/components/studio/upload';
import { useBrandKits, type BrandKit } from '@/lib/brand';

const EMPTY: Omit<BrandKit, 'id' | 'logoUrl'> = { name: '', logoAssetId: null, colors: { primary: '#7C5CFF', secondary: '#111111', text: '#FFFFFF' }, voice: '', products: '', ctas: [], slogans: [], website: null, musicStyle: '', offers: '', handles: {} };

/** Brand facts used by ads. Only what you enter here is ever stated about your business. */
export default function BrandKitPage() {
  const q = useBrandKits();
  const [edit, setEdit] = useState<(Omit<BrandKit, 'id' | 'logoUrl'> & { id?: string; logoUrl?: string | null }) | null>(null);
  const [busy, setBusy] = useState(false);
  const up = useUploader({ kind: 'upload', accept: 'image/png,image/jpeg,image/webp' });
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const body = { name: edit.name, logoAssetId: edit.logoAssetId, colors: edit.colors, voice: edit.voice, products: edit.products, ctas: edit.ctas.filter(Boolean), slogans: edit.slogans.filter(Boolean), website: edit.website || null, musicStyle: edit.musicStyle, offers: edit.offers, handles: edit.handles };
      await api(edit.id ? `/api/brand-kits/${edit.id}` : '/api/brand-kits', { method: edit.id ? 'PUT' : 'POST', body });
      toast.success('Brand kit saved');
      setEdit(null);
      void q.refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {up.element}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">Brand kits</h1>
        <Button size="sm" onClick={() => setEdit({ ...EMPTY })}><Plus /> New brand kit</Button>
      </div>
      <p className="text-sm text-fog-400">Ads use only these facts — no invented prices, offers, claims or reviews. Leave a field empty if it does not apply.</p>
      {(q.data?.brandKits ?? []).map((b) => (
        <Card key={b.id} className="flex items-center gap-3 p-3">
          {b.logoUrl ? <img src={b.logoUrl} alt="" className="size-12 rounded-lg bg-white/5 object-contain" /> : <div className="size-12 rounded-lg" style={{ background: b.colors.primary }} />}
          <div className="min-w-0 flex-1">
            <div className="text-sm text-white">{b.name}</div>
            <div className="truncate text-xs text-fog-400">{b.products || 'No product description'} · {b.ctas.join(' · ') || 'no CTA'}</div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setEdit({ ...b })}>Edit</Button>
        </Card>
      ))}
      {edit && (
        <Card className="space-y-3 p-4">
          <div className="flex items-center gap-3">
            {edit.logoUrl ? <img src={edit.logoUrl} alt="" className="size-14 rounded-lg bg-white/5 object-contain" /> : <div className="grid size-14 place-items-center rounded-lg bg-white/5 text-fog-400"><ImagePlus className="size-5" /></div>}
            <Button size="sm" variant="secondary" onClick={async () => { const a = await up.pick(); if (a) setEdit({ ...edit, logoAssetId: a.id, logoUrl: a.url }); }}>Upload logo</Button>
            <Field label="Brand name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={80} /></Field>
          </div>
          <div className="flex gap-4 text-xs text-fog-300">
            {(['primary', 'secondary', 'text'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5 capitalize">{k}<input type="color" value={edit.colors[k]} onChange={(e) => setEdit({ ...edit, colors: { ...edit.colors, [k]: e.target.value.toUpperCase() } })} className="h-7 w-9 border-0 bg-transparent" /></label>
            ))}
          </div>
          <Field label="What you sell"><Textarea rows={2} value={edit.products} onChange={(e) => setEdit({ ...edit, products: e.target.value })} maxLength={1500} /></Field>
          <Field label="Brand voice" hint="e.g. warm, premium, playful"><Input value={edit.voice} onChange={(e) => setEdit({ ...edit, voice: e.target.value })} maxLength={600} /></Field>
          <Field label="Calls to action (one per line)"><Textarea rows={2} value={edit.ctas.join('\n')} onChange={(e) => setEdit({ ...edit, ctas: e.target.value.split('\n') })} /></Field>
          <Field label="Approved slogans (one per line)"><Textarea rows={2} value={edit.slogans.join('\n')} onChange={(e) => setEdit({ ...edit, slogans: e.target.value.split('\n') })} /></Field>
          <Field label="Current offers / prices" hint="Only if real — ads will never invent one"><Input value={edit.offers} onChange={(e) => setEdit({ ...edit, offers: e.target.value })} maxLength={600} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Website"><Input value={edit.website ?? ''} onChange={(e) => setEdit({ ...edit, website: e.target.value })} maxLength={300} /></Field>
            <Field label="Music style"><Input value={edit.musicStyle} onChange={(e) => setEdit({ ...edit, musicStyle: e.target.value })} maxLength={200} /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            <Button size="sm" onClick={save} loading={busy} disabled={!edit.name.trim()}><Save /> Save</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
