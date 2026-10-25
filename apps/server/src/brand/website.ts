import crypto from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context';
import type { BrandFact } from '../db/schema';
import { FetchBlocked, validatePublicUrl, type PageFetcher } from './safe-fetch';

/*
 * Brand intelligence from a public website. We read at most a handful of same-site pages the
 * owner points us to (home, about, products, contact — robots.txt respected), extract only what is
 * actually published (structured data, meta tags, headings, links, colours, fonts, images), and
 * return a DRAFT profile: every fact carries its source page and a confidence, and nothing is
 * saved until the user reviews it. An optional AI pass may summarise, strictly from the page text.
 * Social profiles are never scraped: platforms require the owner's authorization (OAuth) for that.
 */

export type WebsiteDraft = {
  url: string;
  pages: { url: string; title: string; status: 'read' | 'skipped' | 'failed'; note?: string }[];
  name: string | null;
  description: string | null;
  slogan: string | null;
  industry: string | null;
  audienceSuggestions: string[];
  products: { name: string; description: string; price: string; url: string | null; imageUrls: string[]; sourceUrl: string; confidence: number }[];
  social: Record<string, string>;
  contact: { email?: string; phone?: string; address?: string };
  colors: string[];
  fonts: string[];
  logoUrl: string | null;
  imageUrls: { url: string; alt: string; sourceUrl: string }[];
  facts: BrandFact[];
  socialNotes: { platform: string; url: string; note: string }[];
  summarySource: 'llm' | 'offline';
};

const SOCIAL: Record<string, RegExp> = {
  instagram: /^https?:\/\/(www\.)?instagram\.com\/[^/?#]+/i,
  facebook: /^https?:\/\/(www\.|m\.)?facebook\.com\/[^?#]+/i,
  tiktok: /^https?:\/\/(www\.)?tiktok\.com\/@[^/?#]+/i,
  youtube: /^https?:\/\/(www\.)?youtube\.com\/(@|channel\/|c\/|user\/)[^/?#]+/i,
  x: /^https?:\/\/(www\.)?(x|twitter)\.com\/[^/?#]+/i,
  linkedin: /^https?:\/\/(www\.)?linkedin\.com\/(company|in)\/[^/?#]+/i,
  pinterest: /^https?:\/\/(www\.)?pinterest\.[a-z.]+\/[^/?#]+/i,
};

const SOCIAL_NOTE = 'Not read automatically: this platform only shares an account’s posts and videos with the owner’s authorization through its official API, which is not connected. Upload your videos and photos here, or paste captions you want reused.';

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const clean = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag: string, name: string) => decode(tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find((x) => x !== undefined) ?? '');

function metaContent(html: string, key: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if ([attr(tag, 'property'), attr(tag, 'name'), attr(tag, 'itemprop')].some((v) => v.toLowerCase() === key.toLowerCase())) {
      const c = attr(tag, 'content').trim();
      if (c) return c;
    }
  }
  return null;
}

type JsonLd = Record<string, unknown>;
function jsonLd(html: string): JsonLd[] {
  const out: JsonLd[] = [];
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]!.trim()) as unknown;
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          const o = v as JsonLd;
          if (o['@graph']) walk(o['@graph']);
          if (o['@type']) out.push(o);
        }
      };
      walk(data);
    } catch {
      /* malformed block — ignore */
    }
  }
  return out;
}
const types = (o: JsonLd) => [o['@type']].flat().map(String);
const str = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? str(v[0]) : v && typeof v === 'object' ? str((v as JsonLd).url ?? (v as JsonLd).name ?? '') : '');

function visibleText(html: string) {
  return clean(html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<(nav|footer)[\s\S]*?<\/\1>/gi, ' '));
}

/** Hex colours used in the page's own CSS, most frequent first (greys/near-white/near-black left out). */
function brandColors(html: string, themeColor: string | null): string[] {
  const counts = new Map<string, number>();
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n') + [...html.matchAll(/style\s*=\s*"([^"]*)"/gi)].map((m) => m[1]).join(';');
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    let h = m[1]!.toLowerCase();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 24 && (max > 225 || max < 40 || max - min < 12)) continue; // greys, white, black
    counts.set(`#${h.toUpperCase()}`, (counts.get(`#${h.toUpperCase()}`) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const theme = themeColor && /^#[0-9a-f]{6}$/i.test(themeColor) ? [themeColor.toUpperCase()] : [];
  return [...new Set([...theme, ...ranked])].slice(0, 6);
}

function fonts(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'>\s]+)/gi)) for (const f of decode(m[1]!).matchAll(/family=([^:&]+)/g)) out.add(decodeURIComponent(f[1]!.replace(/\+/g, ' ')));
  for (const m of html.matchAll(/font-family\s*:\s*([^;}"]+)/gi)) {
    const first = m[1]!.split(',')[0]!.replace(/["']/g, '').trim();
    if (first && !/^(inherit|initial|sans-serif|serif|monospace|system-ui|-apple-system|var\()/i.test(first)) out.add(first);
  }
  return [...out].slice(0, 4);
}

/** Minimal robots.txt check for our user agent / "*". */
async function robotsAllows(fetcher: PageFetcher, origin: string): Promise<(path: string) => boolean> {
  try {
    const r = await fetcher(`${origin}/robots.txt`, { accept: 'text', maxBytes: 200_000 });
    if (r.status >= 400) return () => true;
    const rules: string[] = [];
    let applies = false;
    for (const line of r.body.toString('utf8').split(/\r?\n/)) {
      const [k, ...rest] = line.split(':');
      const v = rest.join(':').trim();
      if (/^user-agent$/i.test(k!.trim())) applies = v === '*' || /framecraft/i.test(v);
      else if (applies && /^disallow$/i.test(k!.trim()) && v) rules.push(v);
    }
    return (p) => !rules.some((r) => p.startsWith(r));
  } catch {
    return () => true;
  }
}

const PRIORITY = /(about|story|o-nas|o_nas|о-нас|about-us|shop|store|product|products|catalog|collection|collections|gallery|contact|kontakt|ჩვენ|შესახებ|პროდუქ|კატალოგ|კონტაქტ|магазин|каталог|контакт|товар)/i;

const summarySchema = z.object({
  description: z.string(),
  industry: z.string(),
  audience: z.array(z.string()).max(5),
  facts: z.array(z.object({ text: z.string(), kind: z.enum(['about', 'product', 'claim', 'audience', 'contact', 'price', 'other']), quote: z.string(), page: z.number().int() })).max(25),
});

const SUMMARY_SYSTEM = `You extract a brand profile from website text for an advertising tool. Use ONLY the supplied page text. Every fact must be supported by a short verbatim quote from that page (quote ≤ 20 words, copied exactly). Never infer awards, prices, guarantees, numbers or claims that are not written. audience: who the site itself says it serves (empty if not stated). Keep facts short and in the site's language.`;

export async function analyzeWebsite(ctx: AppContext, raw: string, opts: { fetcher?: PageFetcher; maxPages?: number; useAi?: boolean } = {}): Promise<WebsiteDraft> {
  const fetcher = opts.fetcher ?? ctx.webFetch;
  const start = validatePublicUrl(raw);
  const origin = start.origin;
  const allowed = await robotsAllows(fetcher, origin);
  const draft: WebsiteDraft = { url: start.toString(), pages: [], name: null, description: null, slogan: null, industry: null, audienceSuggestions: [], products: [], social: {}, contact: {}, colors: [], fonts: [], logoUrl: null, imageUrls: [], facts: [], socialNotes: [], summarySource: 'offline' };
  const fact = (text: string, kind: BrandFact['kind'], sourceUrl: string, confidence: number) => {
    const t = text.trim().slice(0, 500);
    if (t && !draft.facts.some((f) => f.text.toLowerCase() === t.toLowerCase())) draft.facts.push({ id: crypto.randomUUID().slice(0, 12), text: t, kind, sourceUrl, confidence, status: 'pending' });
  };
  const queue: string[] = [start.toString()];
  const seen = new Set<string>();
  const texts: { url: string; text: string }[] = [];
  const maxPages = opts.maxPages ?? 6;

  while (queue.length && draft.pages.length < maxPages) {
    const url = queue.shift()!;
    const key = url.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const path = new URL(url).pathname;
    if (!allowed(path)) {
      draft.pages.push({ url, title: '', status: 'skipped', note: 'Disallowed by the site’s robots.txt' });
      continue;
    }
    let html: string;
    let finalUrl = url;
    try {
      const r = await fetcher(url, { accept: 'html' });
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      html = r.body.toString('utf8');
      finalUrl = r.url;
      if (new URL(finalUrl).origin !== origin && draft.pages.length) throw new Error('Redirected to another site');
    } catch (err) {
      draft.pages.push({ url, title: '', status: 'failed', note: err instanceof FetchBlocked ? err.message : (err as Error).message.slice(0, 120) });
      continue;
    }
    const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    draft.pages.push({ url: finalUrl, title, status: 'read' });
    const first = draft.pages.filter((p) => p.status === 'read').length === 1;
    const abs = (h: string) => {
      try {
        return new URL(h, finalUrl).toString();
      } catch {
        return null;
      }
    };

    // Structured data is the most reliable source.
    for (const o of jsonLd(html)) {
      const t = types(o);
      if (t.some((x) => /Organization|LocalBusiness|Store|Brand/i.test(x))) {
        draft.name ??= str(o.name) || null;
        if (str(o.description)) fact(str(o.description), 'about', finalUrl, 0.9);
        if (str(o.logo)) draft.logoUrl ??= abs(str(o.logo));
        if (str(o.slogan)) draft.slogan ??= str(o.slogan);
        for (const s of [o.sameAs].flat().map(str)) for (const [k, re] of Object.entries(SOCIAL)) if (re.test(s)) draft.social[k] ??= s;
        if (str(o.email)) draft.contact.email ??= str(o.email).replace(/^mailto:/, '');
        if (str(o.telephone)) draft.contact.phone ??= str(o.telephone);
        const addr = o.address as JsonLd | undefined;
        if (addr && typeof addr === 'object') draft.contact.address ??= [addr.streetAddress, addr.addressLocality, addr.addressCountry].map(str).filter(Boolean).join(', ') || undefined;
      }
      if (t.some((x) => /^Product$/i.test(x))) {
        const offers = [o.offers].flat()[0] as JsonLd | undefined;
        const price = offers ? [str(offers.price), str(offers.priceCurrency)].filter(Boolean).join(' ') : '';
        const name = str(o.name);
        if (name && !draft.products.some((p) => p.name === name))
          draft.products.push({ name: name.slice(0, 120), description: str(o.description).slice(0, 600), price, url: abs(str(o.url) || finalUrl), imageUrls: [o.image].flat().map(str).map(abs).filter((x): x is string => Boolean(x)).slice(0, 4), sourceUrl: finalUrl, confidence: 0.9 });
        if (price) fact(`${name}: ${price}`, 'price', finalUrl, 0.9);
      }
    }
    const siteName = metaContent(html, 'og:site_name');
    if (first) {
      draft.name ??= siteName ?? (title.split(/[|–—-]/)[0]?.trim() || null);
      draft.description ??= metaContent(html, 'description') ?? metaContent(html, 'og:description');
      if (draft.description) fact(draft.description, 'about', finalUrl, 0.8);
      draft.colors = brandColors(html, metaContent(html, 'theme-color'));
      draft.fonts = fonts(html);
      if (!draft.logoUrl) {
        const logoImg = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]).find((t) => /logo/i.test(attr(t, 'src') + attr(t, 'alt') + attr(t, 'class')));
        const icon = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((t) => /apple-touch-icon|icon/i.test(attr(t, 'rel')));
        draft.logoUrl = (logoImg && abs(attr(logoImg, 'src'))) || (icon && abs(attr(icon, 'href'))) || null;
      }
    }
    const og = metaContent(html, 'og:image');
    if (og && abs(og)) draft.imageUrls.push({ url: abs(og)!, alt: metaContent(html, 'og:title') ?? title, sourceUrl: finalUrl });
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
      const src = attr(m[0], 'src') || attr(m[0], 'data-src');
      const u = src && !src.startsWith('data:') && abs(src);
      const w = Number(attr(m[0], 'width')) || 0;
      if (!u || /\.svg(\?|$)/i.test(u) || /logo|icon|sprite|pixel|avatar/i.test(u) || (w && w < 200)) continue;
      if (!draft.imageUrls.some((x) => x.url === u)) draft.imageUrls.push({ url: u, alt: attr(m[0], 'alt').slice(0, 160), sourceUrl: finalUrl });
    }
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = decode(m[1]!);
      if (/^mailto:/i.test(href)) draft.contact.email ??= href.slice(7).split('?')[0];
      else if (/^tel:/i.test(href)) draft.contact.phone ??= href.slice(4);
      else {
        const u = abs(href);
        if (!u) continue;
        for (const [k, re] of Object.entries(SOCIAL)) if (re.test(u)) draft.social[k] ??= u.split('?')[0]!;
        const same = new URL(u).origin === origin;
        if (same && PRIORITY.test(new URL(u).pathname + ' ' + clean(m[2]!)) && !seen.has(u.replace(/\/$/, '')) && !queue.includes(u) && !/\.(jpe?g|png|webp|pdf|zip)$/i.test(u)) queue.push(u.split('#')[0]!);
      }
    }
    const h1 = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
    if (first && h1 && h1.length <= 120) draft.slogan ??= h1;
    texts.push({ url: finalUrl, text: visibleText(html).slice(0, 6000) });
  }
  draft.imageUrls = draft.imageUrls.slice(0, 24);
  draft.socialNotes = Object.entries(draft.social).map(([platform, url]) => ({ platform, url, note: SOCIAL_NOTE }));

  // Optional AI summary — grounded: a fact is kept only when its quote really is on the page.
  if (opts.useAi !== false && texts.length) {
    const res = await ctx.director.converse(
      { system: SUMMARY_SYSTEM, prompt: texts.map((t, i) => `PAGE ${i + 1} (${t.url}):\n${t.text}`).join('\n\n').slice(0, 24_000), schema: summarySchema, tier: 'fast', maxTokens: 3000 },
      () => ({ description: '', industry: '', audience: [], facts: [] }),
    );
    if (res.source === 'llm') {
      draft.summarySource = 'llm';
      draft.industry = res.industry.trim().slice(0, 120) || null;
      draft.audienceSuggestions = res.audience.map((a) => a.slice(0, 160));
      if (!draft.description && res.description) draft.description = res.description.slice(0, 600);
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      for (const f of res.facts) {
        const page = texts[f.page - 1];
        if (!page || !f.quote.trim() || !norm(page.text).includes(norm(f.quote))) continue; // unsupported → dropped
        fact(f.text, f.kind, page.url, 0.6);
      }
    }
  }
  return draft;
}
