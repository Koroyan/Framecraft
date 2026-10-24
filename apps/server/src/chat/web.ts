import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Read a public web page's text for the Ad Studio (the business's own site, product pages).
 * SSRF guard: http(s) only, every hop must resolve to public addresses, redirects re-checked,
 * short timeout and a size cap. Returns plain text (scripts/styles/markup removed).
 * (The address is checked before the request; production deployments should also block private
 * ranges at the network egress to rule out DNS rebinding.)
 */
const MAX_BYTES = 600_000;
const MAX_REDIRECTS = 3;

function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7)); // IPv4-mapped
  // loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
  return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

async function assertPublic(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) links can be read');
  if (url.username || url.password) throw new Error('Links with credentials are not read');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('That address is not a public website');
}

export function htmlToText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]?.trim();
  const body = html
    .replace(/<head[\s\S]*?<\/head>/i, ' ')
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  return [title && `Title: ${title}`, desc && `Description: ${desc}`, body].filter(Boolean).join('\n');
}

export async function readWebPage(raw: string, opts: { maxChars?: number; fetchImpl?: typeof fetch } = {}): Promise<{ url: string; text: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  // Bare domains ("pijilo.ge/shop") get https://; any other scheme (file:, ftp:, data:…) is refused.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) throw new Error('Only http(s) links can be read');
  let url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'FramecraftAdStudio/1.0 (+reads the page the user shared)', accept: 'text/html,text/plain;q=0.9' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw new Error(`The page answered HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new Error('That link is not a web page');
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      chunks.push(value);
      if (size > MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
    const html = Buffer.concat(chunks).toString('utf8');
    return { url: url.toString(), text: (type.includes('html') ? htmlToText(html) : html).slice(0, opts.maxChars ?? 6000) };
  }
  throw new Error('Too many redirects');
}

/** Links in free text (the user pastes them into the chat). */
export function linksIn(text: string): string[] {
  return [...new Set((text.match(/\bhttps?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+/gi) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, 5);
}
