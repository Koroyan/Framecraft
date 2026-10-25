'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Film, ImagePlus, Music, Shield, Sparkles, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { AD_STYLES } from '@framecraft/shared';
import { api, ApiError, type Asset } from '@/lib/api';
import { useBrandKits } from '@/lib/brand';
import { Button, Card, Field, NativeSelect, Segmented, Switch, Textarea } from '@/components/ui';
import { useUploader } from '@/components/studio/upload';
import { cn, seconds } from '@/lib/utils';

type Up = { id: string; url: string; name: string; kind: 'video' | 'image'; durationSec?: number };

/** Create an ad from the client's own product footage. */
export default function FootageAdsPage() {
  const router = useRouter();
  const kits = useBrandKits();
  const list = useQuery({ queryKey: ['campaigns'], queryFn: () => api<{ campaigns: { id: string; title: string; status: string; projectId: string | null; updatedAt: string }[] }>('/api/ads/campaigns') });
  const vid = useUploader({ kind: 'upload', accept: 'video/mp4,video/quicktime,video/webm' });
  const img = useUploader({ kind: 'upload', accept: 'image/png,image/jpeg,image/webp' });
  const ref = useUploader({ kind: 'reference', accept: 'image/png,image/jpeg,image/webp' });
  const refAd = useUploader({ kind: 'upload', accept: 'video/mp4,video/quicktime,video/webm' });
  const mus = useUploader({ kind: 'upload', accept: 'audio/mpeg,audio/wav,audio/mp4,audio/aac' });
  const [files, setFiles] = useState<Up[]>([]);
  const [productRefs, setProductRefs] = useState<Up[]>([]);
  const [reference, setReference] = useState<Up | null>(null);
  const [music, setMusic] = useState<'generate' | 'upload' | 'none'>('generate');
  const [musicAsset, setMusicAsset] = useState<Up | null>(null);
  const [request, setRequest] = useState('');
  const [style, setStyle] = useState('cinematic_luxury');
  const [mode, setMode] = useState<'original' | 'enhanced'>('original');
  const [preservation, setPreservation] = useState<'strict' | 'guided' | 'creative'>('strict');
  const [language, setLanguage] = useState<'ka' | 'en' | 'ru'>('ka');
  const [lengthSec, setLength] = useState(30);
  const [aspectRatio, setAspect] = useState<'9:16' | '1:1' | '4:5' | '16:9'>('9:16');
  const [voiceover, setVoiceover] = useState(true);
  const [productNotes, setNotes] = useState('');
  const [cta, setCta] = useState('');
  const [brandKitId, setBrand] = useState('');
  const [busy, setBusy] = useState(false);
  const asUp = (a: Asset, kind: 'video' | 'image'): Up => ({ id: a.id, url: a.thumbnailUrl ?? a.url, name: a.originalName ?? kind, kind, durationSec: a.durationMs ? a.durationMs / 1000 : undefined });

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ campaign: { id: string } }>('/api/ads/campaigns', {
        body: { request, style, mode, preservation, language, lengthSec, aspectRatio, voiceover, music, musicAssetId: musicAsset?.id, footageAssetIds: files.filter((f) => f.kind === 'video').map((f) => f.id), imageAssetIds: files.filter((f) => f.kind === 'image').map((f) => f.id), productRefAssetIds: productRefs.map((p) => p.id), productNotes, referenceAdAssetId: reference?.id ?? null, brandKitId: brandKitId || null, cta },
      });
      router.push(`/app/ads/footage/${r.campaign.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {vid.element}
      {img.element}
      {ref.element}
      {refAd.element}
      {mus.element}
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-iris-300">Ad Studio</div>
        <h1 className="text-xl font-semibold text-white">Create an ad from my videos</h1>
        <p className="mt-1 text-sm text-fog-400">Upload real footage of your product. We analyse every moment, plan a storyboard you can edit, and cut the ad on a normal editable timeline. Nothing is spent until you approve.</p>
      </div>

      {(list.data?.campaigns.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2">
          {list.data!.campaigns.slice(0, 8).map((c) => (
            <Link key={c.id} href={`/app/ads/footage/${c.id}`} className="rounded-xl border hairline px-3 py-1.5 text-xs text-fog-200 hover:border-white/25">{c.title} · <span className="text-fog-400">{c.status}</span></Link>
          ))}
        </div>
      )}

      <Card className="space-y-4 p-4">
        <div className="text-sm font-medium text-white">1 · Your footage</div>
        <div className="flex flex-wrap gap-2">
          {files.map((f) => (
            <figure key={f.id} className="relative w-28 overflow-hidden rounded-xl bg-ink-800">
              {f.kind === 'video' ? <video src={f.url} className="aspect-video w-full object-cover" muted /> : <img src={f.url} alt="" className="aspect-video w-full object-cover" />}
              <figcaption className="truncate px-1.5 py-1 text-[10px] text-fog-300">{f.name}{f.durationSec ? ` · ${seconds(f.durationSec)}` : ''}</figcaption>
              <button type="button" aria-label="Remove" onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))} className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/70 text-white"><X className="size-3" /></button>
            </figure>
          ))}
          <Button variant="secondary" onClick={async () => { const a = await vid.pick(); if (a) setFiles((x) => [...x, asUp(a, 'video')]); }}><Upload /> Add video</Button>
          <Button variant="ghost" onClick={async () => { const a = await img.pick(); if (a) setFiles((x) => [...x, asUp(a, 'image')]); }}><ImagePlus /> Add photo</Button>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <div className="text-sm font-medium text-white">2 · What ad do you want?</div>
        <Textarea rows={3} value={request} onChange={(e) => setRequest(e.target.value)} maxLength={3000} placeholder="e.g. Turn my raw videos into a premium 30-second TikTok ad. Make the figurine look luxurious, emotional music, Georgian narrator, no on-camera dialogue." />
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          {AD_STYLES.map((s) => (
            <button key={s.key} type="button" onClick={() => setStyle(s.key)} className={cn('rounded-xl border p-2 text-left text-[11px] transition', style === s.key ? 'border-iris-400 bg-iris-500/15 text-white' : 'hairline text-fog-300 hover:border-white/25')}>
              <div className="font-medium text-fog-100">{s.label}</div>
              <div className="mt-0.5 text-fog-400">{s.pacing} · {s.shotSec[0]}–{s.shotSec[1]} s shots</div>
            </button>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Length"><NativeSelect value={lengthSec} onChange={(e) => setLength(Number(e.target.value))}>{[15, 20, 30, 35, 45, 60].map((v) => <option key={v} value={v}>{v} s</option>)}</NativeSelect></Field>
          <Field label="Format"><Segmented size="sm" value={aspectRatio} onChange={setAspect} options={(['9:16', '1:1', '4:5', '16:9'] as const).map((v) => ({ value: v, label: v }))} /></Field>
          <Field label="Language"><Segmented size="sm" value={language} onChange={setLanguage} options={[{ value: 'ka', label: 'ქართ' }, { value: 'en', label: 'EN' }, { value: 'ru', label: 'RU' }]} /></Field>
          <Field label="Brand kit"><NativeSelect value={brandKitId} onChange={(e) => setBrand(e.target.value)}><option value="">None</option>{(kits.data?.brandKits ?? []).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</NativeSelect></Field>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-center justify-between rounded-xl border hairline p-3 text-sm text-fog-200">Narrator voice-over <Switch checked={voiceover} onCheckedChange={setVoiceover} label="Voice-over" /></label>
          <div className="flex items-center gap-2 rounded-xl border hairline p-3 text-sm text-fog-200"><Music className="size-4" /> Music
            <Segmented size="sm" value={music} onChange={setMusic} options={[{ value: 'generate', label: 'Generate' }, { value: 'upload', label: 'My track' }, { value: 'none', label: 'None' }]} />
            {music === 'upload' && <Button size="sm" variant="ghost" onClick={async () => { const a = await mus.pick(); if (a) setMusicAsset({ id: a.id, url: a.url, name: a.originalName ?? 'music', kind: 'video' }); }}>{musicAsset ? musicAsset.name : 'Choose…'}</Button>}
          </div>
        </div>
        <Field label="Call to action" hint="Leave empty to use your brand kit's"><input className="h-9 w-full rounded-lg border hairline bg-ink-900 px-2 text-sm text-white" value={cta} onChange={(e) => setCta(e.target.value)} maxLength={120} /></Field>
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-white"><Shield className="size-4 text-signal-green" /> 3 · Your product stays real</div>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'original', label: 'Original footage only' },
            { value: 'enhanced', label: 'AI-enhanced cinematic' },
          ]}
        />
        <p className="text-xs text-fog-400">{mode === 'original' ? 'Only your footage, edited conventionally: selection, trims, colour, camera moves, titles, music and voice. No AI changes to the picture.' : 'Starts from your footage and suggests selective AI changes (relight, background, atmosphere). Each one shows its cost, is marked as generated, and is used only after you approve it.'}</p>
        {mode === 'enhanced' && (
          <Field label="Product preservation">
            <NativeSelect value={preservation} onChange={(e) => setPreservation(e.target.value as typeof preservation)}>
              <option value="strict">Strict — never alter the product</option>
              <option value="guided">Reference-guided — keep shape, colours and markings</option>
              <option value="creative">Creative — the product may be reinterpreted</option>
            </NativeSelect>
          </Field>
        )}
        <Field label="Product details" hint="What must stay exactly right — colours, logo, packaging, unique features"><Textarea rows={2} value={productNotes} onChange={(e) => setNotes(e.target.value)} maxLength={1500} /></Field>
        <div className="flex flex-wrap items-center gap-2">
          {productRefs.map((p) => <img key={p.id} src={p.url} alt="" className="size-14 rounded-lg object-cover" />)}
          <Button size="sm" variant="ghost" onClick={async () => { const a = await ref.pick(); if (a) setProductRefs((x) => [...x, asUp(a, 'image')]); }}><ImagePlus /> Product reference photo</Button>
        </div>
      </Card>

      <Card className="space-y-2 p-4">
        <div className="text-sm font-medium text-white">Optional · an ad you like (for structure only)</div>
        <p className="text-xs text-fog-400">We read its pacing and shot rhythm — never its footage, music, text or branding.</p>
        <Button size="sm" variant="ghost" onClick={async () => { const a = await refAd.pick(); if (a) setReference(asUp(a, 'video')); }}><Film /> {reference ? reference.name : 'Upload reference ad'}</Button>
      </Card>

      <div className="flex justify-end">
        <Button onClick={create} loading={busy} disabled={!files.length || request.trim().length < 3}><Sparkles /> Analyse footage &amp; plan the ad</Button>
      </div>
    </div>
  );
}
