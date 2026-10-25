'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Globe, ImagePlus, Package, Plus, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, EmptyState, Field, Input, NativeSelect, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from '@/components/ui';
import { useUploader } from '@/components/studio/upload';
import { MediaDropzone } from '@/components/studio/media-dropzone';
import { brandBody, EMPTY_BRAND, SOCIAL_PLATFORMS, useBrandKits, useProducts, type BrandFact, type BrandKit, type BrandProduct, type WebsiteDraft } from '@/lib/brand';
import { cn } from '@/lib/utils';

type Edit = Omit<BrandKit, 'id' | 'logoUrl'> & { id?: string; logoUrl?: string | null };

/**
 * Brand workspace: a reusable profile every ad builds on. Facts come from the owner or from the
 * brand's own website (reviewed one by one, with sources); only approved facts reach the ads.
 */
export default function BrandsPage() {
  const q = useBrandKits();
  const [edit, setEdit] = useState<Edit | null>(null);
  const brands = useMemo(() => q.data?.brandKits ?? [], [q.data]);
  useEffect(() => {
    if (!edit && brands.length === 1) setEdit({ ...EMPTY_BRAND, ...brands[0]! });
  }, [brands, edit]);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">My Brands</h1>
          <p className="mt-1 max-w-2xl text-sm text-fog-400">Create your brand once — products, identity, approved facts and voice — and every ad uses it. Ads never state anything you have not approved.</p>
        </div>
        <Button size="sm" onClick={() => setEdit({ ...EMPTY_BRAND })}><Plus /> New brand</Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <div className="space-y-2">
          {brands.map((b) => (
            <button key={b.id} type="button" onClick={() => setEdit({ ...EMPTY_BRAND, ...b })} className={cn('flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition', edit?.id === b.id ? 'border-iris-400/60 bg-iris-500/10' : 'hairline hover:border-white/25')}>
              {b.logoUrl ? <img src={b.logoUrl} alt="" className="size-10 rounded-lg bg-white/5 object-contain" /> : <div className="size-10 rounded-lg" style={{ background: b.colors.primary }} />}
              <div className="min-w-0">
                <div className="truncate text-sm text-white">{b.name}</div>
                <div className="truncate text-[11px] text-fog-400">{b.industry || b.products || 'No description yet'}</div>
              </div>
            </button>
          ))}
          {!brands.length && !q.isLoading && <p className="text-xs text-fog-400">No brands yet.</p>}
        </div>
        {edit ? <BrandEditor key={edit.id ?? 'new'} initial={edit} onSaved={(b) => setEdit({ ...EMPTY_BRAND, ...b })} onClose={() => setEdit(null)} /> : <EmptyState icon={<Package />} title="Select or create a brand" description="Start with your website — we read it and you approve what is right." action={<Button onClick={() => setEdit({ ...EMPTY_BRAND })}><Plus /> New brand</Button>} />}
      </div>
    </div>
  );
}

function BrandEditor({ initial, onSaved, onClose }: { initial: Edit; onSaved: (b: BrandKit) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const [b, setB] = useState<Edit>(initial);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(initial.id ? 'profile' : 'website');
  const up = useUploader({ kind: 'upload', accept: 'image/png,image/jpeg,image/webp' });
  const patch = (p: Partial<Edit>) => setB((x) => ({ ...x, ...p }));

  const save = async (next: Edit = b) => {
    if (!next.name.trim()) return toast.error('Give the brand a name first');
    setBusy(true);
    try {
      const r = await api<{ brandKit: BrandKit }>(next.id ? `/api/brand-kits/${next.id}` : '/api/brand-kits', { method: next.id ? 'PUT' : 'POST', body: brandBody(next) });
      toast.success('Brand saved');
      await qc.invalidateQueries({ queryKey: ['brand-kits'] });
      onSaved({ ...r.brandKit, logoUrl: next.logoUrl ?? null });
      setB((x) => ({ ...x, id: r.brandKit.id }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const facts = b.knowledge.facts;
  const setFacts = (f: BrandFact[]) => patch({ knowledge: { ...b.knowledge, facts: f } });

  return (
    <Card className="space-y-4 p-4">
      {up.element}
      <div className="flex flex-wrap items-center gap-3">
        {b.logoUrl ? <img src={b.logoUrl} alt="" className="size-14 rounded-xl bg-white/5 object-contain" /> : <div className="grid size-14 place-items-center rounded-xl bg-white/5 text-fog-400"><ImagePlus className="size-5" /></div>}
        <div className="min-w-48 flex-1"><Field label="Brand name"><Input value={b.name} onChange={(e) => patch({ name: e.target.value })} maxLength={80} placeholder="e.g. PIJILO" /></Field></div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}><X /> Close</Button>
          <Button size="sm" onClick={() => save()} loading={busy}><Save /> Save brand</Button>
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="website">Website &amp; social</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="knowledge">Knowledge · {facts.filter((f) => f.status === 'approved').length} approved</TabsTrigger>
          <TabsTrigger value="products" disabled={!b.id}>Products</TabsTrigger>
        </TabsList>

        <TabsContent value="website" className="pt-4">
          <WebsiteImport brand={b} onApply={(next) => { setB(next); setTab('knowledge'); toast.success('Added to the profile for your review — save to keep it'); }} />
        </TabsContent>

        <TabsContent value="profile" className="space-y-4 pt-4">
          <Section title="Identity">
            <div className="flex flex-wrap items-end gap-4">
              <Button size="sm" variant="secondary" onClick={async () => { const a = await up.pick(); if (a) patch({ logoAssetId: a.id, logoUrl: a.url }); }}><ImagePlus /> {b.logoAssetId ? 'Replace logo' : 'Upload logo'}</Button>
              {(['primary', 'secondary', 'text'] as const).map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-xs capitalize text-fog-300">{k}<input type="color" value={b.colors[k]} onChange={(e) => patch({ colors: { ...b.colors, [k]: e.target.value.toUpperCase() } })} className="h-8 w-10 rounded border-0 bg-transparent" /></label>
              ))}
              <Field label="Heading font"><NativeSelect value={b.fonts?.heading ?? 'black'} onChange={(e) => patch({ fonts: { heading: e.target.value, body: b.fonts?.body ?? 'semibold' } })}>{['black', 'bold', 'semibold', 'serif', 'sans'].map((f) => <option key={f}>{f}</option>)}</NativeSelect></Field>
              <Field label="Body font"><NativeSelect value={b.fonts?.body ?? 'semibold'} onChange={(e) => patch({ fonts: { heading: b.fonts?.heading ?? 'black', body: e.target.value } })}>{['semibold', 'bold', 'sans', 'serif'].map((f) => <option key={f}>{f}</option>)}</NativeSelect></Field>
            </div>
            <Field label="Approved slogans (one per line)"><Textarea rows={2} value={b.slogans.join('\n')} onChange={(e) => patch({ slogans: e.target.value.split('\n') })} /></Field>
          </Section>
          <Section title="Business">
            <Field label="What the business does"><Textarea rows={3} value={b.description} onChange={(e) => patch({ description: e.target.value })} maxLength={2000} /></Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Industry / category"><Input value={b.industry} onChange={(e) => patch({ industry: e.target.value })} maxLength={120} /></Field>
              <Field label="Products or services (summary)"><Input value={b.products} onChange={(e) => patch({ products: e.target.value })} maxLength={1500} /></Field>
              <Field label="Target customers"><Input value={b.audience} onChange={(e) => patch({ audience: e.target.value })} maxLength={600} /></Field>
              <Field label="Markets (comma separated)"><Input value={b.markets.join(', ')} onChange={(e) => patch({ markets: e.target.value.split(',') })} /></Field>
              <Field label="Ad languages"><div className="flex gap-3 pt-2 text-xs text-fog-200">{(['ka', 'en', 'ru'] as const).map((l) => <label key={l} className="flex items-center gap-1"><input type="checkbox" className="accent-iris-500" checked={b.languages.includes(l)} onChange={(e) => patch({ languages: e.target.checked ? [...b.languages, l] : b.languages.filter((x) => x !== l) })} />{l.toUpperCase()}</label>)}</div></Field>
              <Field label="Website"><Input value={b.website ?? ''} onChange={(e) => patch({ website: e.target.value })} maxLength={300} /></Field>
              <Field label="Contact email"><Input value={b.contact.email ?? ''} onChange={(e) => patch({ contact: { ...b.contact, email: e.target.value } })} maxLength={200} /></Field>
              <Field label="Contact phone"><Input value={b.contact.phone ?? ''} onChange={(e) => patch({ contact: { ...b.contact, phone: e.target.value } })} maxLength={60} /></Field>
            </div>
          </Section>
          <Section title="Messaging">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Voice and tone" hint="e.g. warm, premium, playful"><Input value={b.voice} onChange={(e) => patch({ voice: e.target.value })} maxLength={600} /></Field>
              <Field label="Music style"><Input value={b.musicStyle} onChange={(e) => patch({ musicStyle: e.target.value })} maxLength={200} /></Field>
              <Field label="Calls to action (one per line)"><Textarea rows={2} value={b.ctas.join('\n')} onChange={(e) => patch({ ctas: e.target.value.split('\n') })} /></Field>
              <Field label="Approved vocabulary (comma separated)"><Textarea rows={2} value={b.vocabulary.join(', ')} onChange={(e) => patch({ vocabulary: e.target.value.split(',') })} /></Field>
              <Field label="Current offers / prices" hint="Only if real — ads never invent one"><Input value={b.offers} onChange={(e) => patch({ offers: e.target.value })} maxLength={600} /></Field>
              <Field label="Never say or show" hint="Restrictions every ad respects"><Input value={b.restrictions} onChange={(e) => patch({ restrictions: e.target.value })} maxLength={1500} /></Field>
            </div>
          </Section>
          <Section title="Social channels">
            <div className="grid gap-2 md:grid-cols-2">
              {SOCIAL_PLATFORMS.map((p) => (
                <Field key={p} label={p}><Input value={b.handles[p] ?? ''} placeholder={`https://${p === 'x' ? 'x' : p}.com/…`} onChange={(e) => patch({ handles: { ...b.handles, [p]: e.target.value } })} maxLength={120} /></Field>
              ))}
            </div>
            <p className="text-xs text-fog-400">Social posts and videos are not read automatically — the platforms only share them with the account owner’s authorization, which is not connected yet. Upload the videos and photos you want to use in the Media Library.</p>
          </Section>
        </TabsContent>

        <TabsContent value="knowledge" className="space-y-3 pt-4">
          <p className="text-xs text-fog-400">Facts ads may state. Approve only what is true; pending and rejected facts are never used.</p>
          {facts.map((f) => (
            <div key={f.id} className={cn('flex flex-wrap items-start gap-2 rounded-xl border p-2.5', f.status === 'approved' ? 'border-signal-green/30' : f.status === 'rejected' ? 'border-white/5 opacity-50' : 'hairline')}>
              <Textarea rows={1} className="min-w-60 flex-1" value={f.text} onChange={(e) => setFacts(facts.map((x) => (x.id === f.id ? { ...x, text: e.target.value } : x)))} />
              <div className="flex items-center gap-1">
                <Badge tone={f.confidence >= 0.8 ? 'green' : f.confidence >= 0.6 ? 'iris' : 'amber'}>{Math.round(f.confidence * 100)}%</Badge>
                {f.sourceUrl ? <a href={f.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-fog-400 hover:text-white" title={f.sourceUrl}><ExternalLink className="size-3.5" /></a> : <span className="text-[10px] text-fog-500">manual</span>}
                <Button size="icon" variant={f.status === 'approved' ? 'secondary' : 'ghost'} aria-label="Approve" onClick={() => setFacts(facts.map((x) => (x.id === f.id ? { ...x, status: 'approved' } : x)))}><Check /></Button>
                <Button size="icon" variant="ghost" aria-label="Reject" onClick={() => setFacts(facts.map((x) => (x.id === f.id ? { ...x, status: 'rejected' } : x)))}><X /></Button>
                <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => setFacts(facts.filter((x) => x.id !== f.id))}><Trash2 /></Button>
              </div>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setFacts([...facts, { id: crypto.randomUUID().slice(0, 12), text: 'New fact', kind: 'about', sourceUrl: null, confidence: 1, status: 'approved' }])}><Plus /> Add a fact</Button>
          {b.knowledge.sources.length > 0 && (
            <div className="space-y-1 rounded-xl bg-white/[0.03] p-3 text-[11px] text-fog-400">
              <div className="text-fog-200">Sources</div>
              {b.knowledge.sources.map((s) => <div key={s.url}>{s.status === 'read' ? '✓ read' : s.status === 'blocked' ? '— not read' : 'manual'} · {s.url} · {new Date(s.fetchedAt).toLocaleDateString()}{s.note ? ` — ${s.note}` : ''}</div>)}
            </div>
          )}
        </TabsContent>

        <TabsContent value="products" className="pt-4">{b.id && <ProductCatalog brandId={b.id} />}</TabsContent>
      </Tabs>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-xl border hairline p-3">
      <div className="text-xs font-medium uppercase tracking-[0.14em] text-fog-400">{title}</div>
      {children}
    </div>
  );
}

/** Read the brand's website and review every extracted item before it joins the profile. */
function WebsiteImport({ brand, onApply }: { brand: Edit; onApply: (b: Edit) => void }) {
  const [url, setUrl] = useState(brand.website ?? '');
  const [draft, setDraft] = useState<WebsiteDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState({ name: true, description: true, colors: true, contact: true, social: true, logo: true });
  const [facts, setFacts] = useState<Record<string, boolean>>({});
  const [images, setImages] = useState<Record<string, boolean>>({});

  const analyze = async () => {
    setBusy(true);
    try {
      const r = await api<{ draft: WebsiteDraft }>('/api/brand-kits/analyze-website', { body: { url } });
      setDraft(r.draft);
      setFacts(Object.fromEntries(r.draft.facts.map((f) => [f.id, f.confidence >= 0.8])));
      setImages({});
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not read the website');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      let logo: { id: string; url: string } | null = null;
      if (pick.logo && draft.logoUrl && !brand.logoAssetId) logo = await api<{ asset: { id: string; url: string } }>('/api/brand-kits/import-image', { body: { url: draft.logoUrl, rightsConfirmed: true } }).then((r) => r.asset).catch(() => null);
      for (const u of Object.keys(images).filter((k) => images[k])) await api('/api/brand-kits/import-image', { body: { url: u, rightsConfirmed: true } }).catch(() => toast.error(`Could not import ${u}`));
      const now = new Date().toISOString();
      const extra: BrandFact[] = [
        ...draft.products.map((p) => ({ id: crypto.randomUUID().slice(0, 12), text: `${p.name}${p.price ? ` — ${p.price}` : ''}${p.description ? `: ${p.description}` : ''}`.slice(0, 500), kind: 'product' as const, sourceUrl: p.sourceUrl, confidence: p.confidence, status: 'pending' as const })),
        ...(draft.fonts.length ? [{ id: crypto.randomUUID().slice(0, 12), text: `Website fonts: ${draft.fonts.join(', ')}`, kind: 'other' as const, sourceUrl: draft.url, confidence: 0.8, status: 'pending' as const }] : []),
      ];
      const reviewed = draft.facts.map((f) => ({ ...f, status: facts[f.id] ? ('approved' as const) : ('pending' as const) }));
      const known = new Set(brand.knowledge.facts.map((f) => f.text.toLowerCase()));
      const handles = pick.social ? { ...Object.fromEntries(Object.entries(draft.social).map(([k, v]) => [k, v.slice(0, 120)])), ...Object.fromEntries(Object.entries(brand.handles).filter(([, v]) => v)) } : brand.handles;
      onApply({
        ...brand,
        name: brand.name || (pick.name ? draft.name ?? '' : ''),
        description: brand.description || (pick.description ? draft.description ?? '' : ''),
        industry: brand.industry || draft.industry || '',
        audience: brand.audience || draft.audienceSuggestions.join('; '),
        slogans: brand.slogans.length ? brand.slogans : draft.slogan ? [draft.slogan] : [],
        website: draft.url,
        colors: pick.colors && draft.colors.length ? { ...brand.colors, primary: draft.colors[0]!, ...(draft.colors[1] ? { secondary: draft.colors[1] } : {}) } : brand.colors,
        contact: pick.contact ? { ...draft.contact, ...Object.fromEntries(Object.entries(brand.contact).filter(([, v]) => v)) } : brand.contact,
        handles,
        logoAssetId: logo?.id ?? brand.logoAssetId,
        logoUrl: logo?.url ?? brand.logoUrl,
        knowledge: {
          facts: [...brand.knowledge.facts, ...[...reviewed, ...extra].filter((f) => !known.has(f.text.toLowerCase()))],
          sources: [
            ...brand.knowledge.sources.filter((s) => s.url !== draft.url),
            { url: draft.url, kind: 'website', fetchedAt: now, status: 'read', note: `${draft.pages.filter((p) => p.status === 'read').length} pages read${draft.summarySource === 'llm' ? ', AI summary checked against page quotes' : ''}` },
            ...draft.socialNotes.map((n) => ({ url: n.url, kind: 'social' as const, fetchedAt: now, status: 'blocked' as const, note: 'Not read: needs the owner’s authorization via the platform API' })),
          ],
        },
      });
      setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-64 flex-1"><Field label="Your website" hint="We read a few public pages (home, about, products, contact) and respect robots.txt"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="pijilo.ge" onKeyDown={(e) => e.key === 'Enter' && url.trim() && analyze()} /></Field></div>
        <Button onClick={analyze} loading={busy && !draft} disabled={url.trim().length < 3}><Globe /> Analyze website</Button>
      </div>
      {draft && (
        <div className="space-y-4">
          <div className="text-xs text-fog-400">
            Read: {draft.pages.map((p) => <span key={p.url} className={cn('mr-2', p.status === 'read' ? 'text-signal-green' : 'text-fog-500')} title={p.note}>{new URL(p.url).pathname}{p.status !== 'read' ? ` (${p.status})` : ''}</span>)}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Pick on={pick.name} set={(v) => setPick({ ...pick, name: v })} label="Name" value={draft.name} />
            <Pick on={pick.description} set={(v) => setPick({ ...pick, description: v })} label="Description" value={draft.description} />
            <Pick on={pick.contact} set={(v) => setPick({ ...pick, contact: v })} label="Contact" value={[draft.contact.email, draft.contact.phone, draft.contact.address].filter(Boolean).join(' · ') || null} />
            <Pick on={pick.colors} set={(v) => setPick({ ...pick, colors: v })} label="Colours" value={draft.colors.length ? <span className="flex gap-1">{draft.colors.map((c) => <span key={c} className="size-5 rounded" style={{ background: c }} title={c} />)}</span> : null} />
            <Pick on={pick.logo} set={(v) => setPick({ ...pick, logo: v })} label="Logo" value={draft.logoUrl ? <img src={draft.logoUrl} alt="" className="h-8 rounded bg-white/10 object-contain" /> : null} />
            <Pick on={pick.social} set={(v) => setPick({ ...pick, social: v })} label="Social channels" value={Object.keys(draft.social).join(', ') || null} />
          </div>
          {draft.socialNotes.length > 0 && <p className="rounded-xl bg-signal-amber/10 p-3 text-xs text-signal-amber">Found {draft.socialNotes.map((n) => n.platform).join(', ')}. Their posts and videos were not read: these platforms only share them with the owner’s authorization through their official APIs. Upload your videos and photos instead.</p>}
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-fog-200">Facts found ({draft.facts.length}) — tick the ones that are true</div>
            {draft.facts.map((f) => (
              <label key={f.id} className="flex items-start gap-2 rounded-lg border hairline p-2 text-xs text-fog-200">
                <input type="checkbox" className="mt-0.5 accent-iris-500" checked={facts[f.id] ?? false} onChange={(e) => setFacts({ ...facts, [f.id]: e.target.checked })} />
                <span className="flex-1">{f.text}</span>
                <Badge tone={f.confidence >= 0.8 ? 'green' : 'amber'}>{Math.round(f.confidence * 100)}%</Badge>
                {f.sourceUrl && <a href={f.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-fog-400 hover:text-white"><ExternalLink className="size-3.5" /></a>}
              </label>
            ))}
            {draft.products.length > 0 && <p className="text-[11px] text-fog-400">{draft.products.length} product{draft.products.length > 1 ? 's' : ''} found ({draft.products.map((p) => p.name).join(', ')}) — added as facts to review; create them in Products.</p>}
          </div>
          {draft.imageUrls.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-fog-200">Images on your site — pick the ones to import into your media</div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {draft.imageUrls.slice(0, 18).map((im) => (
                  <button key={im.url} type="button" onClick={() => setImages({ ...images, [im.url]: !images[im.url] })} className={cn('relative overflow-hidden rounded-lg border', images[im.url] ? 'border-iris-400' : 'hairline')}>
                    <img src={im.url} alt={im.alt} className="aspect-square w-full object-cover" referrerPolicy="no-referrer" />
                    {images[im.url] && <Check className="absolute right-1 top-1 size-4 rounded-full bg-iris-500 p-0.5 text-white" />}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-fog-500">Importing confirms the images belong to your brand or you may use them.</p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDraft(null)}>Discard</Button>
            <Button onClick={apply} loading={busy}><ShieldCheck /> Add the selected items</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Pick({ on, set, label, value }: { on: boolean; set: (v: boolean) => void; label: string; value: React.ReactNode }) {
  if (!value) return <div className="rounded-xl border border-dashed hairline p-2.5 text-xs text-fog-500">{label}: not found on the site</div>;
  return (
    <label className={cn('flex items-start gap-2 rounded-xl border p-2.5 text-xs', on ? 'border-iris-400/40 bg-iris-500/5' : 'hairline')}>
      <input type="checkbox" className="mt-0.5 accent-iris-500" checked={on} onChange={(e) => set(e.target.checked)} />
      <span className="min-w-0 flex-1"><span className="block text-fog-400">{label}</span><span className="block text-fog-100">{value}</span></span>
    </label>
  );
}

const VIEWS = ['front', 'side', 'back', 'detail', 'packaging', 'logo', 'other'] as const;

/** Products: approved claims, identity reference photos, and the footage that shows exactly this product. */
function ProductCatalog({ brandId }: { brandId: string }) {
  const q = useProducts(brandId);
  const [edit, setEdit] = useState<(Partial<BrandProduct> & { name: string; refs: { assetId: string; view: string; url: string }[]; media: { id: string; url: string; kind: string }[] }) | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const body = { name: edit.name, description: edit.description ?? '', category: edit.category ?? '', price: edit.price ?? '', url: edit.url || null, claims: (edit.claims ?? []).map((c) => c.trim()).filter(Boolean), references: edit.refs.map((r) => ({ assetId: r.assetId, view: r.view })), mediaAssetIds: edit.media.map((m) => m.id) };
      await api(edit.id ? `/api/brand-kits/${brandId}/products/${edit.id}` : `/api/brand-kits/${brandId}/products`, { method: edit.id ? 'PUT' : 'POST', body });
      toast.success('Product saved');
      setEdit(null);
      await qc.invalidateQueries({ queryKey: ['brand-products', brandId] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  const products = q.data?.products ?? [];
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((p) => (
          <button key={p.id} type="button" onClick={() => setEdit({ ...p, refs: p.references.map((r) => ({ ...r, url: '' })), media: p.mediaAssetIds.map((id) => ({ id, url: '', kind: '' })) })} className="flex items-center gap-3 rounded-xl border hairline p-2 text-left hover:border-white/25">
            {p.coverUrl ? <img src={p.coverUrl} alt="" className="size-14 rounded-lg object-cover" /> : <div className="grid size-14 place-items-center rounded-lg bg-white/5"><Package className="size-5 text-fog-500" /></div>}
            <div className="min-w-0">
              <div className="truncate text-sm text-white">{p.name}</div>
              <div className="text-[11px] text-fog-400">{p.price || 'no price'} · {p.mediaAssetIds.length} media · {p.references.length} reference photos</div>
            </div>
          </button>
        ))}
        <button type="button" onClick={() => setEdit({ name: '', refs: [], media: [] })} className="grid min-h-[72px] place-items-center rounded-xl border border-dashed hairline text-sm text-fog-300 hover:border-white/25"><span className="flex items-center gap-1"><Plus className="size-4" /> Add product</span></button>
      </div>
      {edit && (
        <div className="space-y-3 rounded-xl border hairline p-3">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Product name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={120} /></Field>
            <Field label="Category"><Input value={edit.category ?? ''} onChange={(e) => setEdit({ ...edit, category: e.target.value })} maxLength={120} /></Field>
            <Field label="Price" hint="Only if real"><Input value={edit.price ?? ''} onChange={(e) => setEdit({ ...edit, price: e.target.value })} maxLength={60} /></Field>
          </div>
          <Field label="Description"><Textarea rows={2} value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} maxLength={2000} /></Field>
          <Field label="Approved claims (one per line)" hint="The only product claims ads may make"><Textarea rows={2} value={(edit.claims ?? []).join('\n')} onChange={(e) => setEdit({ ...edit, claims: e.target.value.split('\n') })} /></Field>
          <div className="space-y-2">
            <div className="text-xs font-medium text-fog-200">Product identity references — front, side, back, details, packaging, logo</div>
            <div className="flex flex-wrap gap-2">
              {edit.refs.map((r, i) => (
                <div key={r.assetId} className="w-24 space-y-1">
                  {r.url ? <img src={r.url} alt="" className="aspect-square w-full rounded-lg object-cover" /> : <div className="grid aspect-square place-items-center rounded-lg bg-white/5 text-[10px] text-fog-500">saved</div>}
                  <NativeSelect value={r.view} onChange={(e) => setEdit({ ...edit, refs: edit.refs.map((x, j) => (j === i ? { ...x, view: e.target.value } : x)) })}>{VIEWS.map((v) => <option key={v}>{v}</option>)}</NativeSelect>
                  <button type="button" className="text-[10px] text-fog-400 hover:text-signal-red" onClick={() => setEdit({ ...edit, refs: edit.refs.filter((_, j) => j !== i) })}>remove</button>
                </div>
              ))}
            </div>
            <MediaDropzone compact kind="reference" accept="image/jpeg,image/png,image/webp,image/heic,.heic" label="Add reference photos" onAsset={(a) => setEdit((e) => (e && !e.refs.some((r) => r.assetId === a.id) ? { ...e, refs: [...e.refs, { assetId: a.id, view: VIEWS[Math.min(e.refs.length, 3)]!, url: a.url }] } : e))} />
          </div>
          <div className="space-y-2">
            <div className="text-xs font-medium text-fog-200">Videos and photos of this product ({edit.media.length}) — ads for it use only these</div>
            <MediaDropzone compact label="Add product footage" onAsset={(a) => setEdit((e) => (e && !e.media.some((m) => m.id === a.id) ? { ...e, media: [...e.media, { id: a.id, url: a.thumbnailUrl ?? a.url, kind: a.mediaType }] } : e))} />
          </div>
          <div className="flex justify-end gap-2">
            {edit.id && <Button variant="danger" size="sm" onClick={async () => { await api(`/api/brand-kits/${brandId}/products/${edit.id}`, { method: 'DELETE' }); setEdit(null); await qc.invalidateQueries({ queryKey: ['brand-products', brandId] }); }}><Trash2 /> Delete</Button>}
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            <Button size="sm" onClick={save} loading={busy} disabled={!edit.name.trim()}><Save /> Save product</Button>
          </div>
        </div>
      )}
    </div>
  );
}
