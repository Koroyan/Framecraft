import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

/*
 * Fetching user-supplied URLs (brand websites) without SSRF: http(s) on standard ports only, no
 * credentials in the URL, every resolved address must be public (checked at connect time, so DNS
 * rebinding cannot swap in a private address after validation), redirects re-checked one by one,
 * strict size and time limits, and only the expected content types.
 */

export type SafeResponse = { url: string; status: number; contentType: string; body: Buffer };
export type PageFetcher = (url: string, opts?: { accept?: 'html' | 'image' | 'text'; maxBytes?: number }) => Promise<SafeResponse>;

export class FetchBlocked extends Error {}

function v4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return !v4Private(ip);
  if (!net.isIPv6(ip)) return false;
  const x = ip.toLowerCase();
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return !v4Private(mapped[1]!);
  return !(x === '::' || x === '::1' || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('ff') || x.startsWith('64:ff9b') || x.startsWith('2001:db8'));
}

/** Normalise and validate a user-supplied URL (adds https:// when missing). */
export function validatePublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new FetchBlocked('This is not a valid web address');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FetchBlocked('Only http(s) addresses can be read');
  if (u.username || u.password) throw new FetchBlocked('Addresses with credentials are not allowed');
  if (u.port && !['80', '443'].includes(u.port)) throw new FetchBlocked('Only standard web ports are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isPublicAddress(host)) throw new FetchBlocked('Private network addresses are not allowed');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new FetchBlocked('Private network addresses are not allowed');
  u.hash = '';
  return u;
}

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, family: 0 }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (!list.length || bad) return callback(new FetchBlocked(`${hostname} resolves to a private address`) as NodeJS.ErrnoException, '', 4);
    const first = list[0]!;
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, first.address, first.family);
  });
};

const ACCEPT: Record<'html' | 'image' | 'text', RegExp> = { html: /^(text\/html|application\/xhtml\+xml)/i, image: /^image\/(jpeg|png|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon)/i, text: /^text\/plain/i };

function once(u: URL, maxBytes: number, timeoutMs: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', lookup: guardedLookup, timeout: timeoutMs, headers: { 'User-Agent': 'FramecraftBrandReader/1.0 (+brand profile import on the owner\'s request)', Accept: 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5', 'Accept-Encoding': 'identity' } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new FetchBlocked('The page is too large to read'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new FetchBlocked('The site took too long to answer')));
    req.on('error', reject);
    req.end();
  });
}

/** Production fetcher: guarded GET with manual, re-validated redirects. */
export const guardedFetch: PageFetcher = async (raw, opts = {}) => {
  let u = validatePublicUrl(raw);
  const maxBytes = opts.maxBytes ?? 3 * 1024 * 1024;
  for (let hop = 0; hop < 5; hop++) {
    const r = await once(u, maxBytes, 12_000);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      u = validatePublicUrl(new URL(String(r.headers.location), u).toString());
      continue;
    }
    const contentType = String(r.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (r.status < 400 && opts.accept && !ACCEPT[opts.accept].test(contentType)) throw new FetchBlocked(`Unexpected content type ${contentType || 'unknown'}`);
    return { url: u.toString(), status: r.status, contentType, body: r.body };
  }
  throw new FetchBlocked('Too many redirects');
};
