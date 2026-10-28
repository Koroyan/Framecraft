'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageIcon, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { CARTOON_STYLES, LANGUAGES } from '@framecraft/shared';
import { useBrandKits } from '@/lib/brand';
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
  // Character Bible
  kind: 'character' | 'mascot';
  brandId: string;
  style: string;
  personality: string;
  role: string;
  palette: string[];
  proportions: string;
  expressions: string;
  relationships: string;
};

const empty: Form = { name: '', description: '', age: '', gender: '', hair: '', eyes: '', build: '', distinguishing: '', clothing: '', voiceStyle: '', voiceLanguage: 'en', refs: [null, null, null, null], consent: false, kind: 'character', brandId: '', style: '', personality: '', role: '', palette: [], proportions: '', expressions: '', relationships: '' };
const BIBLE = ['kind', 'brandId', 'style', 'personality', 'role', 'proportions', 'expressions', 'relationships'] as const;
/** What a shot takes from a character: if this changes, their shots are affected. */
const lookOf = (c: { description: string; appearance: unknown; clothing: string; styleMeta: Record<string, string | undefined> }, primary?: string) => JSON.stringify([c.description, c.appearance, c.clothing, c.styleMeta.palette, c.styleMeta.proportions, primary]);

export default function CharactersPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['characters'], queryFn: () => api<{ characters: Character[] }>('/api/characters') });
  const brands = useBrandKits();
  const [before, setBefore] = useState('');
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
            refs: [...c.references.slice().sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)).map((r) => ({ id: r.assetId, url: r.url })), null, null, null, null].slice(0, 4),
            consent: Boolean(c.likenessConsentAt),
            kind: c.styleMeta.kind === 'mascot' ? 'mascot' : 'character',
            brandId: c.styleMeta.brandId ?? '',
            style: c.styleMeta.style ?? '',
            personality: c.styleMeta.personality ?? '',
            role: c.styleMeta.role ?? '',
            palette: (c.styleMeta.palette ?? '').split(',').map((x) => x.trim()).filter((x) => /^#[0-9a-f]{6}$/i.test(x)),
            proportions: c.styleMeta.proportions ?? '',
            expressions: c.styleMeta.expressions ?? '',
            relationships: c.styleMeta.relationships ?? '',
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
        // The Character Bible: who they are, how they look in every shot, their brand when they are a mascot.
        styleMeta: Object.fromEntries(
          [...BIBLE.map((k) => [k, String(f[k] ?? '').trim()] as const), ['palette', f.palette.join(', ')] as const].filter(([k, v]) => v && !(k === 'kind' && v === 'character') && !(k === 'brandId' && f.kind !== 'mascot')),
        ) as Record<string, string>,
        voice: { style: f.voiceStyle || undefined, language: f.voiceLanguage },
        referenceAssetIds: f.refs.filter(Boolean).map((r) => r!.id),
        likenessConsent: f.consent,
      };
      await api(editing.id ? `/api/characters/${editing.id}` : '/api/characters', { method: editing.id ? 'PUT' : 'POST', body });
      const was = data?.characters.find((c) => c.id === editing.id);
      const now = lookOf({ description: body.description, appearance: body.appearance, clothing: body.clothing, styleMeta: body.styleMeta }, body.referenceAssetIds[0]);
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['characters'] });
      // Controlled propagation: say which shots are affected; nothing is regenerated by itself.
      if (was?.usage?.shots && before && now !== before) {
        toast.message(`${f.name} appears in ${was.usage.shots} shot${was.usage.shots === 1 ? '' : 's'}${was.usage.generated ? ` (${was.usage.generated} already generated)` : ''}.`, { description: 'Planned shots use the new look. Generated shots keep theirs until you regenerate them — in the story graph, open Cast to see which shots they are in.', duration: 9000 });
      } else toast.success('Character saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const sheet = async (id: string) => {
    try {
      // A reference sheet is a paid image: ask with its price first.
      const est = await api<{ available: boolean; credits: number }>(`/api/characters/${id}/sheet/estimate`);
      if (!est.available) return void toast.error('Image generation is not set up on this server.');
      if (!window.confirm(`Create a reference sheet (front, side, back and three expressions) for about ${est.credits} credits?`)) return;
      await api(`/api/characters/${id}/sheet`, { body: { idempotencyKey: newKey() } });
      toast.success('Character sheet queued — it will appear as a reference image.');
      setTimeout(() => qc.invalidateQueries({ queryKey: ['characters'] }), 4000);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not create sheet');
    }
  };

  const set = (patch: Partial<Form>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));
  useEffect(() => {
    const c = editing?.id ? data?.characters.find((x) => x.id === editing.id) : undefined;
    setBefore(c ? lookOf(c, c.references.slice().sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0]?.assetId) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Character Bible"
        description="Characters and brand mascots with an approved look, personality and voice. Every shot they appear in starts from the same reference — better consistency, though no model can guarantee it."
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
                  <span className="flex gap-1">
                    {c.styleMeta.kind === 'mascot' && <Badge>mascot</Badge>}
                    {c.references.some((r) => r.isFixture) && <Badge tone="amber">placeholder refs</Badge>}
                  </span>
                </div>
                {c.styleMeta.personality && <p className="mt-0.5 text-xs text-fog-400">{c.styleMeta.personality}</p>}
                <p className="mt-1 text-[11px] text-fog-500">
                  {c.usage?.shots ? `In ${c.usage.shots} shot${c.usage.shots === 1 ? '' : 's'} · ${c.usage.projects} project${c.usage.projects === 1 ? '' : 's'}` : 'Not in a shot yet'}
                  {c.references.length ? ' · approved look' : ' · no reference image yet'}
                </p>
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
              <Field label="Reference images" hint="The first is the approved look: every shot starts from it. A front view on a plain background works best; add side views or expressions.">
                <div className="grid grid-cols-4 gap-2">
                  {editing.form.refs.map((r, i) => (
                    <ImageSlot key={i} label={i === 0 ? 'Approved look' : `Ref ${i + 1}`} asset={r as Asset | null} onChange={(a) => set({ refs: editing.form.refs.map((x, j) => (j === i ? a : x)) })} />
                  ))}
                </div>
              </Field>
            </div>
            <div className="space-y-3 rounded-2xl border hairline p-3 md:col-span-2">
              <div className="text-sm font-medium text-white">Character Bible</div>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Kind">
                  <NativeSelect value={editing.form.kind} onChange={(e) => set({ kind: e.target.value as Form['kind'] })}>
                    <option value="character">Story character</option>
                    <option value="mascot">Brand mascot</option>
                  </NativeSelect>
                </Field>
                {editing.form.kind === 'mascot' ? (
                  <Field label="Brand">
                    <NativeSelect value={editing.form.brandId} onChange={(e) => set({ brandId: e.target.value })}>
                      <option value="">Choose a brand</option>
                      {(brands.data?.brandKits ?? []).map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </NativeSelect>
                  </Field>
                ) : (
                  <Field label="Role in the story">
                    <Input value={editing.form.role} onChange={(e) => set({ role: e.target.value })} placeholder="the hero who wants to cook" />
                  </Field>
                )}
                <Field label="Drawn in the style">
                  <NativeSelect value={editing.form.style} onChange={(e) => set({ style: e.target.value })}>
                    <option value="">Photoreal / any</option>
                    {CARTOON_STYLES.map((s) => (
                      <option key={s.key} value={s.key}>{s.label}</option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Personality">
                  <Input value={editing.form.personality} onChange={(e) => set({ personality: e.target.value })} placeholder="curious, clumsy, never gives up" />
                </Field>
                <Field label="Proportions">
                  <Input value={editing.form.proportions} onChange={(e) => set({ proportions: e.target.value })} placeholder="small, big round head, short legs" />
                </Field>
                <Field label="Expressions">
                  <Input value={editing.form.expressions} onChange={(e) => set({ expressions: e.target.value })} placeholder="LED eyes that turn into hearts when happy" />
                </Field>
                <Field label="Colour palette">
                  <div className="flex items-center gap-2">
                    {[0, 1, 2].map((i) => (
                      <input key={i} type="color" aria-label={`Colour ${i + 1}`} value={editing.form.palette[i] ?? '#888888'} onChange={(e) => set({ palette: [0, 1, 2].map((j) => (j === i ? e.target.value : (editing.form.palette[j] ?? '#888888'))) })} className="h-8 w-10 cursor-pointer rounded border hairline bg-transparent" />
                    ))}
                    {editing.form.palette.length > 0 && (
                      <button type="button" onClick={() => set({ palette: [] })} className="text-xs text-fog-400 hover:text-white">clear</button>
                    )}
                  </div>
                </Field>
                <Field label="Relationships">
                  <Input value={editing.form.relationships} onChange={(e) => set({ relationships: e.target.value })} placeholder="best friends with Pepper the dog" />
                </Field>
              </div>
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
