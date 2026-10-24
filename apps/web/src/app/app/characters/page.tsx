'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageIcon, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { LANGUAGES } from '@framecraft/shared';
import { api, ApiError, type Asset, type Character } from '@/lib/api';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, NativeSelect, PageHeader, Skeleton, Textarea } from '@/components/ui';
import { ImageSlot } from '@/components/studio/upload';
import { newKey } from '@/lib/utils';

type Form = {
  name: string;
  description: string;
  age: string;
  gender: string;
  hair: string;
  eyes: string;
  build: string;
  distinguishing: string;
  clothing: string;
  voiceStyle: string;
  voiceLanguage: string;
  refs: (Asset | { id: string; url: string } | null)[];
  consent: boolean;
};

const empty: Form = { name: '', description: '', age: '', gender: '', hair: '', eyes: '', build: '', distinguishing: '', clothing: '', voiceStyle: '', voiceLanguage: 'en', refs: [null, null, null, null], consent: false };

export default function CharactersPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['characters'], queryFn: () => api<{ characters: Character[] }>('/api/characters') });
  const [editing, setEditing] = useState<{ id?: string; form: Form } | null>(null);
  const [busy, setBusy] = useState(false);

  const open = (c?: Character) =>
    setEditing({
      id: c?.id,
      form: c
        ? {
            name: c.name,
            description: c.description,
            age: c.appearance.age ?? '',
            gender: c.appearance.gender ?? '',
            hair: c.appearance.hair ?? '',
            eyes: c.appearance.eyes ?? '',
            build: c.appearance.build ?? '',
            distinguishing: c.appearance.distinguishing ?? '',
            clothing: c.clothing,
            voiceStyle: c.voice.style ?? '',
            voiceLanguage: c.voice.language ?? 'en',
            refs: [...c.references.map((r) => ({ id: r.assetId, url: r.url })), null, null, null, null].slice(0, 4),
            consent: Boolean(c.likenessConsentAt),
          }
        : empty,
    });

  const save = async () => {
    if (!editing) return;
    const f = editing.form;
    setBusy(true);
    try {
      const body = {
        name: f.name,
        description: f.description,
        appearance: { age: f.age || undefined, gender: f.gender || undefined, hair: f.hair || undefined, eyes: f.eyes || undefined, build: f.build || undefined, distinguishing: f.distinguishing || undefined },
        clothing: f.clothing,
        voice: { style: f.voiceStyle || undefined, language: f.voiceLanguage },
        referenceAssetIds: f.refs.filter(Boolean).map((r) => r!.id),
        likenessConsent: f.consent,
      };
      await api(editing.id ? `/api/characters/${editing.id}` : '/api/characters', { method: editing.id ? 'PUT' : 'POST', body });
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['characters'] });
      toast.success('Character saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const sheet = async (id: string) => {
    try {
      await api(`/api/characters/${id}/sheet`, { body: { idempotencyKey: newKey() } });
      toast.success('Character sheet queued — it will appear as a reference image.');
      setTimeout(() => qc.invalidateQueries({ queryKey: ['characters'] }), 4000);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not create sheet');
    }
  };

  const set = (patch: Partial<Form>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Characters"
        description="Reusable characters with a written look and reference images. They’re applied to every shot they appear in for better consistency."
        actions={
          <Button onClick={() => open()}>
            <Plus /> New character
          </Button>
        }
      />
      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-64" />)}</div>
      ) : data?.characters.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.characters.map((c) => (
            <Card key={c.id} className="overflow-hidden">
              <div className="grid aspect-[4/3] grid-cols-2 gap-px bg-ink-800">
                {c.references.slice(0, 2).map((r) => (
                  <img key={r.assetId} src={r.url} alt="" className="size-full object-cover" />
                ))}
                {!c.references.length && (
                  <div className="col-span-2 grid place-items-center text-fog-400">
                    <Users className="size-6" />
                  </div>
                )}
              </div>
              <div className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium text-white">{c.name}</div>
                  {c.references.some((r) => r.isFixture) && <Badge tone="amber">placeholder refs</Badge>}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-fog-300">{[c.appearance.distinguishing, c.clothing && `wears ${c.clothing}`].filter(Boolean).join(' · ') || c.description}</p>
                <div className="mt-3 flex gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => open(c)}>
                    <Pencil /> Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => sheet(c.id)}>
                    <ImageIcon /> Character sheet
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Delete"
                    onClick={async () => {
                      await api(`/api/characters/${c.id}`, { method: 'DELETE' });
                      void qc.invalidateQueries({ queryKey: ['characters'] });
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
        <EmptyState icon={<Users />} title="No characters yet" description="Create a character once and reuse it across scenes and films." action={<Button onClick={() => open()}>Create character</Button>} />
      )}

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.id ? 'Edit character' : 'New character'}
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={save} loading={busy} disabled={!editing?.form.name}>Save character</Button>
          </>
        }
      >
        {editing && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name">
              <Input value={editing.form.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Age / look">
              <Input value={editing.form.age} onChange={(e) => set({ age: e.target.value })} placeholder="early 30s" />
            </Field>
            <Field label="Hair">
              <Input value={editing.form.hair} onChange={(e) => set({ hair: e.target.value })} placeholder="short silver bob" />
            </Field>
            <Field label="Eyes">
              <Input value={editing.form.eyes} onChange={(e) => set({ eyes: e.target.value })} placeholder="green" />
            </Field>
            <Field label="Build">
              <Input value={editing.form.build} onChange={(e) => set({ build: e.target.value })} placeholder="tall, athletic" />
            </Field>
            <Field label="Gender (optional)">
              <Input value={editing.form.gender} onChange={(e) => set({ gender: e.target.value })} />
            </Field>
            <div className="md:col-span-2">
              <Field label="Distinguishing features">
                <Input value={editing.form.distinguishing} onChange={(e) => set({ distinguishing: e.target.value })} placeholder="thin scar over left eyebrow, round glasses" />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="Clothing" hint="Written exactly as it should appear in every shot.">
                <Input value={editing.form.clothing} onChange={(e) => set({ clothing: e.target.value })} placeholder="long charcoal trench coat, red scarf" />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="Backstory / description">
                <Textarea value={editing.form.description} onChange={(e) => set({ description: e.target.value })} className="min-h-20" />
              </Field>
            </div>
            <Field label="Voice style">
              <Input value={editing.form.voiceStyle} onChange={(e) => set({ voiceStyle: e.target.value })} placeholder="calm, low, gravelly" />
            </Field>
            <Field label="Voice language">
              <NativeSelect value={editing.form.voiceLanguage} onChange={(e) => set({ voiceLanguage: e.target.value })}>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </NativeSelect>
            </Field>
            <div className="md:col-span-2">
              <Field label="Reference images" hint="Front-facing portrait first. Up to four.">
                <div className="grid grid-cols-4 gap-2">
                  {editing.form.refs.map((r, i) => (
                    <ImageSlot key={i} label={i === 0 ? 'Primary' : `Ref ${i + 1}`} asset={r as Asset | null} onChange={(a) => set({ refs: editing.form.refs.map((x, j) => (j === i ? a : x)) })} />
                  ))}
                </div>
              </Field>
            </div>
            <label className="flex items-start gap-3 text-sm text-fog-200 md:col-span-2">
              <input type="checkbox" className="mt-0.5 size-4 accent-iris-500" checked={editing.form.consent} onChange={(e) => set({ consent: e.target.checked })} />
              If this character is based on a real person, I have their consent to use their likeness. (Public figures and impersonation are not allowed.)
            </label>
          </div>
        )}
      </Dialog>
    </div>
  );
}
