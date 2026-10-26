'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Film, Globe, ImageIcon, Music, Package, Shield, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { AD_MODES, AD_STYLES } from '@framecraft/shared';
import { api, ApiError, type Asset } from '@/lib/api';
import { useBrandKits, useProducts } from '@/lib/brand';
import { Button, Card, Field, Input, NativeSelect, Segmented, Textarea } from '@/components/ui';
import { MediaDropzone } from '@/components/studio/media-dropzone';
import { useUploader } from '@/components/studio/upload';
import { cn, seconds } from '@/lib/utils';

/*
 * One creation flow for every entry point — my videos, product photos, my website, my brand —
 * feeding the same production engine: a brief, analysed media, three concepts, a storyboard.
 * Beginners type one sentence; advanced settings are folded away. Nothing is spent here.
 */

type Picked = { id: string; url: string; name: string; kind: 'video' | 'image'; durationSec?: number; optimized?: boolean };
const FORMATS = [
  { key: 'tiktok', label: 'TikTok / Reels', aspect: '9:16' },
  { key: 'feed', label: 'Instagram Feed', aspect: '4:5' },
  { key: 'square', label: 'Square', aspect: '1:1' },
  { key: 'youtube', label: 'YouTube / Website hero', aspect: '16:9' },
] as const;
const LENGTHS = [10, 15, 30, 45, 60];
const IDENTITY = [
  { key: 'strict', label: 'Strict Original', hint: 'Only your real footage with deterministic editing — the product is never synthesized.', mode: 'original', preservation: 'strict' },
  { key: 'safe', label: 'Brand-Safe AI', hint: 'Careful AI enhancements (light, background) that keep the product identical; every change is reviewed.', mode: 'enhanced', preservation: 'guided' },
  { key: 'creative', label: 'Creative AI', hint: 'More freedom, clearly disclosed. After the analysis you can also stage only the product in a completely new place (AI scenes, 360° turntable) — every result is reviewed.', mode: 'enhanced', preservation: 'creative' },
] as const;

const DRAFT_KEY = 'framecraft.ad-draft.v1';

type Draft = {
  request: string;
  brandKitId: string;
  productId: string;
  files: Picked[];
  lengthSec: number;
  format: (typeof FORMATS)[number]['key'];
  language: 'ka' | 'en' | 'ru';
  narration: 'third_person' | 'none';
  voiceGender: 'auto' | 'female' | 'male';
  music: 'generate' | 'upload' | 'none';
  musicStyle: string;
  identity: (typeof IDENTITY)[number]['key'];
  objective: 'sales' | 'awareness' | 'launch' | 'engagement' | 'traffic';
  audience: string;
  style: string;
  intensity: 'calm' | 'balanced' | 'bold';
  cta: string;
  productNotes: string;
  budget: string;
  adMode: string;
};

const INITIAL: Draft = { request: '', brandKitId: '', productId: '', files: [], lengthSec: 30, format: 'tiktok', language: 'ka', narration: 'third_person', voiceGender: 'auto', music: 'generate', musicStyle: '', identity: 'strict', objective: 'sales', audience: '', style: 'auto', intensity: 'balanced', cta: '', productNotes: '', budget: '', adMode: '' };

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? { ...INITIAL, ...(JSON.parse(raw) as Partial<Draft>) } : INITIAL;
  } catch {
    return INITIAL;
  }
}

export default function CreateAdPage() {
  return (
    <Suspense>
      <CreateAd />
    </Suspense>
  );
}

function CreateAd() {
  const router = useRouter();
  const params = useSearchParams();
  const from = (params.get('from') ?? 'videos') as 'videos' | 'photos' | 'website' | 'brand';
  const [d, setD] = useState<Draft>(INITIAL);
  const [loaded, setLoaded] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const kits = useBrandKits();
  const products = useProducts(d.brandKitId || null);
  const mus = useUploader({ kind: 'upload', accept: 'audio/mpeg,audio/wav,audio/mp4,audio/aac' });
  const [musicAsset, setMusicAsset] = useState<{ id: string; name: string } | null>(null);
  const patch = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  // Autosave (this browser only): a reload never loses the brief.
  useEffect(() => {
    const draft = loadDraft();
    const style = params.get('style');
    // From the "New video" hub: the idea and length the user typed there.
    const idea = params.get('idea');
    const length = Number(params.get('length')) || undefined;
    setD({ ...draft, ...(style ? { style } : {}), ...(idea ? { request: idea } : {}), ...(length ? { lengthSec: Math.min(90, Math.max(10, length)) } : {}) });
    setLoaded(true);
  }, [params]);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch {
      /* storage unavailable — fine */
    }
  }, [d, loaded]);
  useEffect(() => {
    const brands = kits.data?.brandKits ?? [];
    if (loaded && !d.brandKitId && brands.length === 1) patch({ brandKitId: brands[0]!.id });
  }, [kits.data, loaded, d.brandKitId]);

  const product = products.data?.products.find((p) => p.id === d.productId);
  const brand = kits.data?.brandKits.find((b) => b.id === d.brandKitId);
  const identity = IDENTITY.find((i) => i.key === d.identity)!;
  const fmt = FORMATS.find((f) => f.key === d.format)!;
  const hasMedia = d.files.length > 0 || Boolean(product?.mediaAssetIds.length);
  const add = (a: Asset & { prep?: { status: string } | null }) =>
    setD((x) => (x.files.some((f) => f.id === a.id) ? { ...x, files: x.files.map((f) => (f.id === a.id ? { ...f, optimized: a.prep?.status !== 'processing' } : f)) } : { ...x, files: [...x.files, { id: a.id, url: a.thumbnailUrl ?? a.url, name: a.originalName ?? a.mediaType, kind: a.mediaType === 'video' ? 'video' : 'image', durationSec: a.durationMs ? a.durationMs / 1000 : undefined, optimized: a.prep?.status !== 'processing' }] }));

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ campaign: { id: string } }>('/api/ads/campaigns', {
        body: {
          request: d.request,
          style: d.style === 'auto' ? 'cinematic_luxury' : d.style,
          mode: identity.mode,
          preservation: identity.preservation,
          language: d.language,
          lengthSec: d.lengthSec,
          aspectRatio: fmt.aspect,
          voiceover: d.narration === 'third_person',
          voiceGender: d.voiceGender,
          music: d.music,
          musicStyle: d.musicStyle,
          musicAssetId: musicAsset?.id,
          footageAssetIds: d.files.filter((f) => f.kind === 'video').map((f) => f.id),
          imageAssetIds: d.files.filter((f) => f.kind === 'image').map((f) => f.id),
          productNotes: d.productNotes,
          brandKitId: d.brandKitId || null,
          productId: d.productId || null,
          objective: d.objective,
          audience: d.audience,
          intensity: d.intensity,
          cta: d.cta,
          budgetCredits: d.budget ? Number(d.budget) : null,
          adMode: d.adMode || null,
        },
      });
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      router.push(`/app/ads/footage/${r.campaign.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start');
    } finally {
      setBusy(false);
    }
  };

  const ENTRY = [
    { key: 'videos', label: 'From my videos', icon: Film },
    { key: 'photos', label: 'From product photos', icon: ImageIcon },
    { key: 'website', label: 'From my website', icon: Globe },
    { key: 'brand', label: 'From my brand', icon: Package },
  ] as const;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {mus.element}
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-iris-300">Create Advertisement</div>
        <h1 className="text-2xl font-semibold text-white">Create an ad for your brand</h1>
        <p className="mt-1 max-w-2xl text-sm text-fog-400">Describe the ad in one sentence and add your media. Framecraft studies the footage, proposes three creative concepts, and builds a storyboard you approve before anything is spent.</p>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {ENTRY.map((e) => (
          <Link key={e.key} href={`/app/ads/create?from=${e.key}`} replace className={cn('flex items-center gap-2 rounded-xl border p-3 text-sm transition', from === e.key ? 'border-iris-400/60 bg-iris-500/10 text-white' : 'hairline text-fog-300 hover:border-white/25')}>
            <e.icon className="size-4 text-iris-300" /> {e.label}
          </Link>
        ))}
      </div>

      {/* 1 · Brand & product */}
      <Card className="space-y-3 p-4">
        <div className="text-sm font-medium text-white">1 · Brand and product</div>
        {from === 'website' && !brand && <p className="rounded-xl bg-iris-500/10 p-3 text-xs text-fog-200">Start in <Link href="/app/ads/brand" className="text-iris-200 underline">My Brands → Website &amp; social</Link>: paste your website, approve what we found, then come back here and pick the brand.</p>}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Brand">
            <NativeSelect value={d.brandKitId} onChange={(e) => patch({ brandKitId: e.target.value, productId: '' })}>
              <option value="">No brand profile</option>
              {(kits.data?.brandKits ?? []).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Product" hint={d.brandKitId ? 'Ads use only this product’s media and approved claims' : 'Pick a brand first'}>
            <NativeSelect value={d.productId} disabled={!d.brandKitId} onChange={(e) => patch({ productId: e.target.value })}>
              <option value="">Whole brand / not specified</option>
              {(products.data?.products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.mediaAssetIds.length ? ` · ${p.mediaAssetIds.length} media` : ''}</option>)}
            </NativeSelect>
          </Field>
        </div>
        {brand && <p className="text-xs text-fog-400">Using {brand.knowledge.facts.filter((f) => f.status === 'approved').length} approved facts{brand.logoUrl ? ', the logo' : ''} and the brand colours. <Link href="/app/ads/brand" className="text-iris-200 hover:text-white">Edit brand</Link></p>}
      </Card>

      {/* 2 · Media */}
      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-white">2 · {from === 'photos' ? 'Product photos' : 'Your footage and photos'}</div>
          <Button size="sm" variant="ghost" onClick={() => setLibraryOpen((v) => !v)}>{libraryOpen ? 'Hide library' : 'Pick from Media Library'}</Button>
        </div>
        {product && product.mediaAssetIds.length > 0 && !d.files.length && <p className="rounded-xl bg-signal-green/10 p-3 text-xs text-signal-green"><Check className="mr-1 inline size-3.5" />{product.name}: its {product.mediaAssetIds.length} saved videos/photos will be used. Add more below if you like.</p>}
        {d.files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {d.files.map((f) => (
              <figure key={f.id} className="relative w-28 overflow-hidden rounded-xl bg-ink-800">
                <img src={f.url} alt="" className="aspect-video w-full object-cover" />
                <figcaption className="truncate px-1.5 py-1 text-[10px] text-fog-300">{f.name}{f.durationSec ? ` · ${seconds(f.durationSec)}` : ''}{f.optimized === false ? ' · optimizing…' : ''}</figcaption>
                <button type="button" aria-label="Remove" onClick={() => patch({ files: d.files.filter((y) => y.id !== f.id) })} className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/70 text-white"><X className="size-3" /></button>
              </figure>
            ))}
          </div>
        )}
        {libraryOpen && <LibraryPicker selected={d.files.map((f) => f.id)} onPick={add} />}
        <MediaDropzone onAsset={add} label={from === 'photos' ? 'Drop product photos here' : 'Drop product videos and photos here'} />
      </Card>

      {/* 3 · Brief */}
      <Card className="space-y-4 p-4">
        <div className="text-sm font-medium text-white">3 · What ad do you want?</div>
        <Textarea rows={3} value={d.request} onChange={(e) => patch({ request: e.target.value })} maxLength={3000} placeholder="e.g. A premium cinematic 40-second ad in Georgian: show how a personalised figurine is made, the hand painting, the beautiful packaging and the emotion of gifting it. Third-person narrator, elegant music, no on-camera dialogue." />
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Length">
            <div className="flex flex-wrap items-center gap-1.5">
              {LENGTHS.map((v) => <button key={v} type="button" onClick={() => patch({ lengthSec: v })} className={cn('rounded-lg border px-2.5 py-1 text-xs', d.lengthSec === v ? 'border-iris-400 bg-iris-500/15 text-white' : 'hairline text-fog-300')}>{v} s</button>)}
              <Input type="number" min={6} max={90} className="h-7 w-20 text-xs" value={d.lengthSec} onChange={(e) => patch({ lengthSec: Math.max(6, Math.min(90, Number(e.target.value) || 30)) })} aria-label="Custom length" />
            </div>
          </Field>
          <Field label="Format">
            <div className="flex flex-wrap gap-1.5">
              {FORMATS.map((f) => <button key={f.key} type="button" onClick={() => patch({ format: f.key })} className={cn('rounded-lg border px-2.5 py-1 text-xs', d.format === f.key ? 'border-iris-400 bg-iris-500/15 text-white' : 'hairline text-fog-300')}>{f.label} · {f.aspect}</button>)}
            </div>
          </Field>
          <Field label="Language"><Segmented size="sm" value={d.language} onChange={(v) => patch({ language: v })} options={[{ value: 'ka', label: 'ქართული' }, { value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' }]} /></Field>
          <Field label="Narration">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented size="sm" value={d.narration} onChange={(v) => patch({ narration: v })} options={[{ value: 'third_person', label: 'Narrator' }, { value: 'none', label: 'No voice' }]} />
              {d.narration === 'third_person' && <Segmented size="sm" value={d.voiceGender} onChange={(v) => patch({ voiceGender: v })} options={[{ value: 'auto', label: 'Auto' }, { value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }]} />}
            </div>
          </Field>
          <Field label="Music">
            <div className="flex flex-wrap items-center gap-2">
              <Music className="size-4 text-fog-400" />
              <Segmented size="sm" value={d.music} onChange={(v) => patch({ music: v })} options={[{ value: 'generate', label: 'Generate' }, { value: 'upload', label: 'My track' }, { value: 'none', label: 'None' }]} />
              {d.music === 'upload' && <Button size="sm" variant="ghost" onClick={async () => { const a = await mus.pick(); if (a) setMusicAsset({ id: a.id, name: a.originalName ?? 'music' }); }}>{musicAsset ? musicAsset.name : 'Choose…'}</Button>}
            </div>
          </Field>
          <div className="md:col-span-2">
            <Field label="Creative Director mode" hint="How the ad tells its story and is cut — or let the director propose three">
              <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => patch({ adMode: '' })} className={cn('rounded-lg border px-2.5 py-1 text-xs', !d.adMode ? 'border-iris-400 bg-iris-500/15 text-white' : 'hairline text-fog-300')}>Auto (three concepts)</button>
                {AD_MODES.map((m) => (
                  <button key={m.key} type="button" title={m.purpose} onClick={() => patch({ adMode: m.key })} className={cn('rounded-lg border px-2.5 py-1 text-xs', d.adMode === m.key ? 'border-iris-400 bg-iris-500/15 text-white' : 'hairline text-fog-300')}>{m.label}</button>
                ))}
              </div>
              {d.adMode && <p className="mt-1 text-[11px] text-fog-400">{AD_MODES.find((m) => m.key === d.adMode)?.purpose}</p>}
            </Field>
          </div>
          <Field label="Objective"><NativeSelect value={d.objective} onChange={(e) => patch({ objective: e.target.value as Draft['objective'] })}>{(['sales', 'awareness', 'launch', 'engagement', 'traffic'] as const).map((o) => <option key={o} value={o}>{o}</option>)}</NativeSelect></Field>
        </div>
      </Card>

      {/* 4 · Product identity */}
      <Card className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-white"><Shield className="size-4 text-signal-green" /> 4 · Product identity</div>
        <div className="grid gap-2 md:grid-cols-3">
          {IDENTITY.map((i) => (
            <button key={i.key} type="button" onClick={() => patch({ identity: i.key })} className={cn('rounded-xl border p-3 text-left transition', d.identity === i.key ? 'border-iris-400 bg-iris-500/10' : 'hairline hover:border-white/25')}>
              <div className="text-sm text-white">{i.label}</div>
              <div className="mt-1 text-[11px] text-fog-400">{i.hint}</div>
            </button>
          ))}
        </div>
        {d.identity !== 'strict' && <p className="text-xs text-fog-400">Handmade products, figurines and jewellery look best in Strict Original — AI is used only where you approve it, shot by shot.</p>}
      </Card>

      {/* Advanced */}
      <Card className="p-4">
        <button type="button" className="flex w-full items-center justify-between text-sm text-fog-200" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
          Advanced settings <ChevronDown className={cn('size-4 transition', advanced && 'rotate-180')} />
        </button>
        {advanced && (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Field label="Creative style" hint="Auto: the AI proposes three concepts and recommends one">
              <NativeSelect value={d.style} onChange={(e) => patch({ style: e.target.value })}>
                <option value="auto">Auto (three concepts)</option>
                {AD_STYLES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Visual intensity"><Segmented size="sm" value={d.intensity} onChange={(v) => patch({ intensity: v })} options={[{ value: 'calm', label: 'Calm' }, { value: 'balanced', label: 'Balanced' }, { value: 'bold', label: 'Bold' }]} /></Field>
            <Field label="Target audience"><Input value={d.audience} onChange={(e) => patch({ audience: e.target.value })} maxLength={300} placeholder={brand?.audience || 'e.g. people looking for a personal gift'} /></Field>
            <Field label="Call to action" hint="Empty = from your brand"><Input value={d.cta} onChange={(e) => patch({ cta: e.target.value })} maxLength={120} /></Field>
            <Field label="Music style"><Input value={d.musicStyle} onChange={(e) => patch({ musicStyle: e.target.value })} maxLength={200} placeholder={brand?.musicStyle || 'e.g. elegant cinematic strings'} /></Field>
            <Field label="Maximum budget (credits)" hint="The ad never spends more without asking again"><Input type="number" min={0} value={d.budget} onChange={(e) => patch({ budget: e.target.value })} placeholder="No limit — ask each time" /></Field>
            <div className="md:col-span-2"><Field label="Product details that must stay exactly right"><Textarea rows={2} value={d.productNotes} onChange={(e) => patch({ productNotes: e.target.value })} maxLength={1500} placeholder="Colours, logo, packaging, unique features" /></Field></div>
          </div>
        )}
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="text-xs text-fog-400">Analysis, concepts and storyboard are free · voice-over and music are priced on the next screen</span>
        <Button size="lg" onClick={create} loading={busy} disabled={!hasMedia || d.request.trim().length < 3}><Sparkles /> Analyse &amp; propose concepts</Button>
      </div>
    </div>
  );
}

function LibraryPicker({ selected, onPick }: { selected: string[]; onPick: (a: Asset) => void }) {
  const q = useQuery({ queryKey: ['assets', 'library-picker'], queryFn: () => api<{ assets: (Asset & { prep?: { status: string } | null })[] }>('/api/assets?limit=120') });
  const items = useMemo(() => (q.data?.assets ?? []).filter((a) => a.mediaType === 'video' || a.mediaType === 'image'), [q.data]);
  if (!items.length) return <p className="text-xs text-fog-400">{q.isLoading ? 'Loading…' : 'Your library is empty.'}</p>;
  return (
    <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-6">
      {items.map((a) => (
        <button key={a.id} type="button" onClick={() => onPick(a)} className={cn('relative overflow-hidden rounded-lg border text-left', selected.includes(a.id) ? 'border-iris-400' : 'hairline hover:border-white/25')}>
          <img src={a.thumbnailUrl ?? a.url} alt="" className="aspect-video w-full object-cover" />
          <span className="block truncate px-1 py-0.5 text-[10px] text-fog-300">{a.originalName ?? a.mediaType}</span>
          {selected.includes(a.id) && <Check className="absolute right-1 top-1 size-4 rounded-full bg-iris-500 p-0.5 text-white" />}
        </button>
      ))}
    </div>
  );
}
