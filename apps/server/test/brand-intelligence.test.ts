import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { adConceptSchema, adPlanSchema, reviewPlanDiversity, type AdPlan } from '@framecraft/shared';
import { buildApp } from '../src/http/app';
import { createTestContext, type TestHarness } from './helpers/context';
import { FakeLlm } from '../src/director/llm';
import { ffmpeg } from '../src/media/ffmpeg';
import { storeAsset } from '../src/services/assets';
import { guardedFetch, isPublicAddress, validatePublicUrl, type PageFetcher } from '../src/brand/safe-fetch';
import { analyzeWebsite } from '../src/brand/website';
import { importBrandImage, saveProduct } from '../src/brand/brand';
import { applyReviewOption, chooseConcept, createCampaign, getCampaign, saveBrandKit, setBudget } from '../src/ads/campaigns';

/*
 * Brand intelligence and the creative director: SSRF-safe website reading, a reviewable draft
 * with sources (no invented facts), the product catalog, three concepts, and the shot diversity
 * review. A fake website and a scripted model — no network, no paid calls.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-brand-'));
const f = (n: string) => path.join(dir, n);
let png: Buffer;

beforeAll(async () => {
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=3:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('only.mp4')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'mandelbrot=s=1280x720:r=25', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('other.mp4')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xE0A020:s=800x800', '-frames:v', '1', f('figurine.png')]);
  png = fs.readFileSync(f('figurine.png'));
}, 60_000);

// ------------------------------------------------------------------ a small fake brand website

const SITE = 'https://pijilo.example';
const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const PAGES: Record<string, string> = {
  '/robots.txt': 'User-agent: *\nDisallow: /private',
  '/': page(
    `<header><img src="/img/pijilo-logo.png" alt="PIJILO logo"></header>
     <h1>Your photo, turned into a figurine</h1>
     <p>PIJILO makes personalised 3D figurines in Tbilisi, painted by hand.</p>
     <img src="/img/hero-figurine.jpg" alt="Hand-painted figurine" width="800">
     <a href="/about">About us</a> <a href="/products/couple-figurine">Couple figurine</a> <a href="/contact">Contact</a> <a href="/private/products">Products archive</a>
     <a href="https://www.instagram.com/pijilo.ge">Instagram</a> <a href="https://www.tiktok.com/@pijilo">TikTok</a>`,
    `<title>PIJILO | Personalised figurines</title>
     <meta name="description" content="Personalised 3D figurines made from your photos.">
     <meta name="theme-color" content="#7c3aed">
     <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Georgian:wght@400;700&display=swap" rel="stylesheet">
     <style>.btn{background:#7C3AED;color:#ffffff}.accent{color:#F59E0B}.x{color:#f59e0b}</style>
     <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"PIJILO","logo":"https://pijilo.example/img/pijilo-logo.png","sameAs":["https://www.facebook.com/pijilo"]}</script>`,
  ),
  '/about': page('<h2>Our story</h2><p>Every figurine is printed in 3D and then painted by hand in our studio.</p><p>We started in 2021.</p>', '<title>About PIJILO</title>'),
  '/products/couple-figurine': page(
    '<h1>Couple figurine</h1><p>A figurine of two people from one photo.</p>',
    `<title>Couple figurine</title><script type="application/ld+json">{"@type":"Product","name":"Couple figurine","description":"A figurine of two people from one photo.","image":"/img/couple.jpg","offers":{"@type":"Offer","price":"180","priceCurrency":"GEL"}}</script>`,
  ),
  '/contact': page('<a href="mailto:hello@pijilo.example">Email</a> <a href="tel:+995555000111">Call</a>', '<title>Contact</title>'),
  '/private/products': page('<p>secret</p>'),
};

const fakeSite: PageFetcher = async (url, opts) => {
  const u = new URL(url);
  if (u.origin !== SITE) throw new Error('offline');
  if (u.pathname.startsWith('/img/')) return { url, status: 200, contentType: 'image/png', body: png };
  const body = PAGES[u.pathname];
  if (!body) return { url, status: 404, contentType: 'text/html', body: Buffer.from('not found') };
  return { url, status: 200, contentType: opts?.accept === 'text' ? 'text/plain' : 'text/html', body: Buffer.from(body) };
};

// The model summarises; one fact quotes the page, one is invented (must be dropped).
const prompts: string[] = [];
const llm = new FakeLlm(({ system, prompt }) => {
  prompts.push(prompt);
  if (system.startsWith('You extract a brand profile')) {
    const about = prompt.split('PAGE ').findIndex((p) => p.includes('painted by hand in our studio'));
    return {
      description: 'Personalised 3D figurines.',
      industry: 'Personalised gifts',
      audience: ['People looking for a personal gift'],
      facts: [
        { text: 'Figurines are 3D printed and painted by hand', kind: 'about', quote: 'printed in 3D and then painted by hand in our studio', page: about },
        { text: 'Winner of the 2023 Design Award', kind: 'claim', quote: 'award-winning studio since 2010', page: about },
      ],
    };
  }
  throw new Error('use the offline path');
});

let h: TestHarness;
let app: FastifyInstance;
beforeAll(async () => {
  h = await createTestContext({ llm, webFetch: fakeSite });
  app = await buildApp(h.ctx);
});
afterAll(async () => {
  await app.close();
  await h.close();
});

describe('safe fetching of user-supplied URLs', () => {
  it('only public addresses, standard ports, no credentials', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) expect(isPublicAddress(ip)).toBe(false);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2a00:1450:4001::1']) expect(isPublicAddress(ip)).toBe(true);
    for (const bad of ['http://localhost/', 'file:///etc/passwd', 'ftp://pijilo.ge', 'http://user:pw@pijilo.ge', 'http://pijilo.ge:8080', 'http://192.168.1.1', 'http://[::1]/', 'http://metadata.internal']) expect(() => validatePublicUrl(bad)).toThrow();
    expect(validatePublicUrl('pijilo.ge').toString()).toBe('https://pijilo.ge/');
  });

  it('checks the resolved address at connect time (a name pointing at the machine itself is refused)', async () => {
    await expect(guardedFetch('http://localhost./', { accept: 'html' })).rejects.toThrow(/private/);
  });

  it('the website endpoint refuses private targets', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'ssrf@test.dev', password: 'password123', name: 'T', acceptTerms: true } });
    const cookie = String(reg.headers['set-cookie']).split(';')[0]!;
    const r = await app.inject({ method: 'POST', url: '/api/brand-kits/analyze-website', payload: { url: 'http://169.254.169.254/latest/meta-data' }, headers: { cookie } });
    expect(r.statusCode).toBe(400);
  });
});

describe('brand profile from a website', () => {
  it('extracts only published facts, with sources; respects robots.txt; never claims social media was read', async () => {
    const d = await analyzeWebsite(h.ctx, 'pijilo.example');
    expect(d.name).toBe('PIJILO');
    expect(d.description).toBe('Personalised 3D figurines made from your photos.');
    expect(d.slogan).toBe('Your photo, turned into a figurine');
    expect(d.logoUrl).toBe(`${SITE}/img/pijilo-logo.png`);
    expect(d.colors[0]).toBe('#7C3AED');
    expect(d.colors).toContain('#F59E0B');
    expect(d.fonts).toContain('Noto Sans Georgian');
    expect(d.contact).toMatchObject({ email: 'hello@pijilo.example', phone: '+995555000111' });
    expect(d.products).toEqual([expect.objectContaining({ name: 'Couple figurine', price: '180 GEL', sourceUrl: `${SITE}/products/couple-figurine`, confidence: 0.9 })]);
    expect(d.imageUrls.map((i) => i.url)).toContain(`${SITE}/img/hero-figurine.jpg`);
    // Robots.txt: the staff page is not read.
    expect(d.pages.find((p) => p.url.includes('/private'))).toMatchObject({ status: 'skipped' });
    expect(d.pages.filter((p) => p.status === 'read').map((p) => new URL(p.url).pathname).sort()).toEqual(['/', '/about', '/contact', '/products/couple-figurine']);
    // Social profiles are listed, with an honest note that they were not analysed.
    expect(Object.keys(d.social).sort()).toEqual(['facebook', 'instagram', 'tiktok']);
    expect(d.socialNotes.every((n) => /not read automatically/i.test(n.note))).toBe(true);
    // Every fact has a source and waits for the user's review; the invented award is gone.
    expect(d.facts.length).toBeGreaterThan(0);
    expect(d.facts.every((x) => x.status === 'pending' && x.sourceUrl?.startsWith(SITE))).toBe(true);
    expect(d.facts.map((x) => x.text)).toContain('Figurines are 3D printed and painted by hand');
    expect(d.facts.some((x) => /award/i.test(x.text))).toBe(false);
    expect(d.summarySource).toBe('llm');
  });

  it('imports a brand image from the site as a normal upload (rights confirmed, content checked)', async () => {
    const u = await h.makeUser();
    await expect(importBrandImage(h.ctx, u, `${SITE}/img/hero-figurine.jpg`, { rightsConfirmed: false })).rejects.toThrow(/confirm/);
    const r = await importBrandImage(h.ctx, u, `${SITE}/img/hero-figurine.jpg`, { rightsConfirmed: true });
    expect(r.asset).toMatchObject({ mediaType: 'image', mimeType: 'image/png' });
    expect((r.asset.source as { importedFrom: string }).importedFrom).toBe(`${SITE}/img/hero-figurine.jpg`);
    expect((await importBrandImage(h.ctx, u, `${SITE}/img/hero-figurine.jpg`, { rightsConfirmed: true })).deduplicated).toBe(true);
  });
});

describe('creative director with the brand and product catalog', () => {
  it('uses only approved facts and the selected product’s own media; proposes three distinct concepts', async () => {
    const u = await h.makeUser(undefined, 'user', 10_000);
    const up = (name: string) => storeAsset(h.ctx, { userId: u.id, kind: 'upload', mediaType: 'video', filePath: f(name), mimeType: 'video/mp4', originalName: name });
    const mine = await up('only.mp4');
    const otherProductVideo = await up('other.mp4');
    const kit = await saveBrandKit(h.ctx, u, {
      name: 'PIJILO',
      knowledge: {
        facts: [
          { id: 'f1', text: 'Painted by hand in Tbilisi', kind: 'about', sourceUrl: `${SITE}/about`, confidence: 0.9, status: 'approved' },
          { id: 'f2', text: 'Free delivery worldwide', kind: 'claim', sourceUrl: null, confidence: 0.4, status: 'rejected' },
          { id: 'f3', text: 'Ships in 2 days', kind: 'claim', sourceUrl: null, confidence: 0.5, status: 'pending' },
        ],
        sources: [{ url: SITE, kind: 'website', fetchedAt: new Date().toISOString(), status: 'read' }],
      },
    });
    const couple = await saveProduct(h.ctx, u, kit.id, { name: 'Couple figurine', claims: ['Made from one photo'], price: '180 GEL', mediaAssetIds: [mine.id] });
    await saveProduct(h.ctx, u, kit.id, { name: 'Pet figurine', mediaAssetIds: [otherProductVideo.id] });

    prompts.length = 0;
    const c = await createCampaign(h.ctx, u, { request: 'A premium 15 second ad for the couple figurine', productId: couple.id, lengthSec: 15, voiceover: false, music: 'none' });
    await h.drain(200);
    const view = await getCampaign(h.ctx, u, c.id);
    expect(view.campaign.status).toBe('planned');
    // Only this product's footage was analysed.
    expect(new Set(view.segments.map((s) => s.assetId))).toEqual(new Set([mine.id]));
    expect(view.campaign.brandKitId).toBe(kit.id);

    const concepts = (view.campaign.concepts ?? []).map((x) => adConceptSchema.parse(x));
    expect(concepts).toHaveLength(3);
    expect(new Set(concepts.map((x) => x.angle)).size).toBe(3);
    expect(new Set(concepts.map((x) => x.style)).size).toBe(3);
    expect(concepts.filter((x) => x.recommended)).toHaveLength(1);
    expect(concepts[0]!.beats.map((b) => b.beat)).toEqual(['hook', 'interest', 'value', 'payoff', 'cta']);

    // The model was told the approved fact and the product — never the rejected or unreviewed ones.
    const briefPrompts = prompts.join('\n');
    expect(briefPrompts).toContain('Painted by hand in Tbilisi');
    expect(briefPrompts).toContain('Couple figurine');
    expect(briefPrompts).not.toContain('Free delivery worldwide');
    expect(briefPrompts).not.toContain('Ships in 2 days');
    expect(briefPrompts).not.toContain('Pet figurine');

    // 3 s of footage cannot fill 15 s without repeating: the review says so and offers real options…
    const plan = adPlanSchema.parse(view.campaign.plan);
    const review = (view.campaign.review as { diversity: ReturnType<typeof reviewPlanDiversity> }).diversity;
    expect(review.issues.some((i) => i.code === 'insufficient_footage')).toBe(true);
    expect(review.options.map((o) => o.key)).toEqual(['shorter', 'crops', 'more_footage']);
    // …and the planner never shows the same seconds twice: repeats became detail crops.
    expect(review.issues.some((i) => i.code === 'repeated_interval')).toBe(false);
    expect(plan.scenes.length).toBeGreaterThan(1);
    expect(plan.scenes.slice(1).some((s) => s.crop)).toBe(true);
    // Shot language varies.
    expect(new Set(plan.scenes.map((s) => s.camera)).size).toBeGreaterThan(1);

    // Another concept re-plans with its own style.
    const social = concepts.find((x) => x.angle === 'high_energy_social')!;
    await chooseConcept(h.ctx, u, c.id, social.key);
    await h.drain(100);
    const v2 = await getCampaign(h.ctx, u, c.id);
    expect(adPlanSchema.parse(v2.campaign.plan).conceptKey).toBe(social.key);
    expect((v2.campaign.concepts ?? []).length).toBe(3); // concepts are reused, not regenerated

    // "Make the shorter ad" re-cuts to the length the footage supports.
    const shorter = (v2.campaign.review as { diversity: ReturnType<typeof reviewPlanDiversity> }).diversity.options.find((o) => o.key === 'shorter')!;
    await applyReviewOption(h.ctx, u, c.id, 'shorter');
    await h.drain(100);
    const v3 = await getCampaign(h.ctx, u, c.id);
    const total = adPlanSchema.parse(v3.campaign.plan).scenes.reduce((s, x) => s + x.durationSec, 0);
    expect((v3.campaign.brief as { lengthSec: number }).lengthSec).toBe(shorter.lengthSec);
    expect(Math.abs(total - shorter.lengthSec!)).toBeLessThan(shorter.lengthSec! * 0.35);

    // The budget can be changed on the campaign; the estimate reflects it at once.
    const b = await setBudget(h.ctx, u, c.id, 300);
    expect(b.estimate).toMatchObject({ budget: 300, assembleWithinBudget: true, enhanceWithinBudget: true });
    expect(((await getCampaign(h.ctx, u, c.id)).campaign.brief as { budgetCredits: number }).budgetCredits).toBe(300);
    expect((await setBudget(h.ctx, u, c.id, null)).estimate).toMatchObject({ budget: null });
  }, 180_000);
});

describe('shot diversity checker', () => {
  const segs = [
    { id: 's1', assetId: 'a', startSec: 0, endSec: 4, duplicateOf: null, metrics: { motion: 0.2 }, scores: { product: 0.8 } },
    { id: 's2', assetId: 'b', startSec: 0, endSec: 4, duplicateOf: null, metrics: { motion: 0.2 }, scores: { product: 0.7 } },
  ];
  const scene = (id: string, segmentId: string, extra: Partial<AdPlan['scenes'][number]> = {}) => adPlanSchema.shape.scenes.element.parse({ id, segmentId: segmentId === 's1' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002', inSec: 0, durationSec: 2, ...extra });
  const withIds = segs.map((s, i) => ({ ...s, id: `00000000-0000-4000-8000-00000000000${i + 1}` }));

  it('flags the same seconds shown twice, unless the reuse is a visibly different crop', () => {
    const repeat = reviewPlanDiversity({ scenes: [scene('a', 's1', { role: 'hook' }), scene('b', 's2'), scene('c', 's1', { role: 'reveal' })] }, withIds, 6);
    expect(repeat.issues.find((i) => i.code === 'repeated_interval')?.sceneIndexes).toEqual([0, 2]);
    const cropped = reviewPlanDiversity({ scenes: [scene('a', 's1', { role: 'hook' }), scene('b', 's2'), scene('c', 's1', { role: 'reveal', crop: { x: 0.4, y: 0.4, scale: 1.7 } })] }, withIds, 6);
    expect(cropped.issues.some((i) => i.code === 'repeated_interval')).toBe(false);
    expect(cropped.score).toBeGreaterThan(repeat.score);
  });
});
