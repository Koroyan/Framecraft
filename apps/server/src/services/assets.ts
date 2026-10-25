import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { assets } from '../db/schema';
import { probe, thumbnail } from '../media/ffmpeg';
import { notFound } from '../lib/errors';
import { streamToFile } from '../storage/storage';
import type { OutputRef } from '../providers/video/types';

export type Asset = typeof assets.$inferSelect;
type AssetKind = Asset['kind'];
type MediaType = Asset['mediaType'];

export const ALLOWED_UPLOADS: Record<string, MediaType> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'video/x-m4v': 'video',
  'video/x-matroska': 'video',
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/aac': 'audio',
  'audio/mp4': 'audio',
  'audio/ogg': 'audio',
  'text/plain': 'text',
  'application/x-subrip': 'text',
};

const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-m4v': '.m4v', 'video/x-matroska': '.mkv', 'image/heic': '.heic', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/aac': '.aac' };

export const tmpFile = (ext = '') => path.join(os.tmpdir(), `fc-${crypto.randomUUID()}${ext}`);

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Check magic bytes so a renamed file cannot masquerade as an image/video. */
export async function sniffMime(file: string): Promise<string | undefined> {
  const fh = await fsp.open(file, 'r');
  const buf = Buffer.alloc(64);
  await fh.read(buf, 0, 64, 0);
  await fh.close();
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (buf.subarray(4, 8).toString() === 'ftyp') {
    const brand = buf.subarray(8, 12).toString();
    if (brand.startsWith('M4A')) return 'audio/mp4';
    if (brand.startsWith('qt')) return 'video/quicktime';
    if (brand.startsWith('M4V')) return 'video/x-m4v';
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (brand === 'avif' || brand === 'avis') return undefined;
    return 'video/mp4';
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return buf.includes(Buffer.from('matroska')) ? 'video/x-matroska' : 'video/webm';
  if (buf.subarray(0, 3).toString() === 'ID3' || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buf.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  return undefined;
}

/** Prepared representations of a video master (see media/prepare.ts). */
export type MediaPrep = {
  status: 'processing' | 'ready' | 'failed';
  /** Browser-playable proxy (absent when the master already plays everywhere). */
  proxyKey?: string;
  proxy?: { width: number; height: number; sizeBytes: number; fps: number };
  /** Technical properties of the master. */
  media?: Record<string, unknown>;
  error?: string;
};
export const prepOf = (a: Pick<Asset, 'source'>) => (a.source as { prep?: MediaPrep } | null)?.prep;

export async function storeAsset(
  ctx: AppContext,
  p: {
    userId: string;
    projectId?: string | null;
    kind: AssetKind;
    mediaType: MediaType;
    filePath: string;
    mimeType: string;
    originalName?: string;
    source?: Record<string, unknown>;
    isFixture?: boolean;
    makeThumbnail?: boolean;
  },
): Promise<Asset> {
  const id = crypto.randomUUID();
  const ext = EXT[p.mimeType] ?? path.extname(p.filePath) ?? '';
  const key = `u/${p.userId}/${id}/${p.kind}${ext}`;
  let meta: { width?: number; height?: number; durationMs?: number; hasAudio?: boolean } = {};
  if (p.mediaType !== 'text') {
    try {
      const pr = await probe(p.filePath);
      meta = { width: pr.width, height: pr.height, durationMs: p.mediaType === 'image' ? undefined : Math.round(pr.durationSec * 1000), hasAudio: pr.hasAudio };
    } catch {
      /* unknown format — keep without metadata */
    }
  }
  const sha = await sha256File(p.filePath);
  const { sizeBytes } = await ctx.storage.putFile(key, p.filePath, p.mimeType);

  let thumbnailAssetId: string | undefined;
  if (p.makeThumbnail !== false && p.mediaType === 'video') {
    const thumbPath = tmpFile('.jpg');
    try {
      await thumbnail(p.filePath, thumbPath);
      const t = await storeAsset(ctx, { ...p, kind: 'thumbnail', mediaType: 'image', filePath: thumbPath, mimeType: 'image/jpeg', makeThumbnail: false, originalName: undefined });
      thumbnailAssetId = t.id;
    } catch (err) {
      ctx.log.warn('thumbnail failed', (err as Error).message);
    } finally {
      await fsp.rm(thumbPath, { force: true });
    }
  }

  const [row] = await ctx.db
    .insert(assets)
    .values({
      id,
      userId: p.userId,
      projectId: p.projectId ?? null,
      kind: p.kind,
      mediaType: p.mediaType,
      storageKey: key,
      mimeType: p.mimeType,
      sizeBytes,
      width: meta.width,
      height: meta.height,
      durationMs: meta.durationMs,
      hasAudio: meta.hasAudio,
      sha256: sha,
      originalName: p.originalName?.slice(0, 200),
      thumbnailAssetId,
      source: p.source ?? {},
      isFixture: p.isFixture ?? false,
    })
    .returning();
  return row!;
}

export async function storeBuffer(ctx: AppContext, p: Omit<Parameters<typeof storeAsset>[1], 'filePath'> & { data: Buffer; ext: string }): Promise<Asset> {
  const file = tmpFile(p.ext);
  await fsp.writeFile(file, p.data);
  try {
    return await storeAsset(ctx, { ...p, filePath: file });
  } finally {
    await fsp.rm(file, { force: true });
  }
}

/** Attach a thumbnail to an existing video asset (without duplicating the video). */
export async function ensureThumbnail(ctx: AppContext, a: Asset): Promise<Asset> {
  if (a.thumbnailAssetId || a.mediaType !== 'video') return a;
  const src = await downloadAssetToTemp(ctx, a);
  const thumbPath = tmpFile('.jpg');
  try {
    await thumbnail(src, thumbPath);
    const t = await storeAsset(ctx, { userId: a.userId, projectId: a.projectId, kind: 'thumbnail', mediaType: 'image', filePath: thumbPath, mimeType: 'image/jpeg', isFixture: a.isFixture, makeThumbnail: false });
    const [updated] = await ctx.db.update(assets).set({ thumbnailAssetId: t.id }).where(eq(assets.id, a.id)).returning();
    return updated!;
  } catch (err) {
    ctx.log.warn('thumbnail failed', (err as Error).message);
    return a;
  } finally {
    await Promise.all([fsp.rm(src, { force: true }), fsp.rm(thumbPath, { force: true })]);
  }
}

/** Fetch an asset the user owns, or 404 (never reveals other users' assets). */
export async function getOwnedAsset(ctx: AppContext, userId: string, assetId: string): Promise<Asset> {
  const [a] = await ctx.db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.userId, userId), isNull(assets.deletedAt)));
  if (!a) throw notFound('Asset');
  return a;
}

/**
 * Browser URL. Videos with an editing proxy (HEVC, MOV, 4K, HDR…) play from the proxy; `download`
 * and `master` always give the untouched original.
 */
export async function assetUrl(ctx: AppContext, a: Pick<Asset, 'storageKey' | 'mimeType' | 'kind'> & { source?: Asset['source'] }, opts: { download?: boolean; expiresSec?: number; master?: boolean } = {}): Promise<string> {
  const ext = EXT[a.mimeType] ?? '';
  const proxyKey = !opts.download && !opts.master && a.source ? prepOf(a as Pick<Asset, 'source'>)?.proxyKey : undefined;
  if (proxyKey) return ctx.storage.signedUrl(proxyKey, { expiresSec: opts.expiresSec ?? 6 * 3600 });
  return ctx.storage.signedUrl(a.storageKey, { expiresSec: opts.expiresSec ?? 6 * 3600, download: opts.download ? `framecraft-${a.kind}${ext}` : undefined });
}

/** URL a provider can read: a presigned HTTPS URL with S3, or an inline data URI for local storage. */
export async function providerInputUrl(ctx: AppContext, a: Asset): Promise<string> {
  if (ctx.storage.publicUrls) return ctx.storage.signedUrl(a.storageKey, { expiresSec: 6 * 3600 });
  if (a.sizeBytes > 15 * 1024 * 1024) throw new Error('Input file too large to inline; configure S3/R2 storage so providers can fetch it');
  const buf = await ctx.storage.getBuffer(a.storageKey);
  return `data:${a.mimeType};base64,${buf.toString('base64')}`;
}

/** Local copy for FFmpeg. `prefer: 'proxy'` takes the lighter editing proxy (same timeline) when there is one. */
export async function downloadAssetToTemp(ctx: AppContext, a: Asset, opts: { prefer?: 'master' | 'proxy' } = {}): Promise<string> {
  const proxyKey = opts.prefer === 'proxy' ? prepOf(a)?.proxyKey : undefined;
  const file = tmpFile(proxyKey ? '.mp4' : (EXT[a.mimeType] ?? ''));
  await ctx.storage.getToFile(proxyKey ?? a.storageKey, file);
  return file;
}

/** Download a provider output (URL, inline base64 or local fixture path) to a temp file. */
export async function fetchProviderOutput(ctx: AppContext, out: OutputRef, maxBytes = 1024 ** 3): Promise<string> {
  const file = tmpFile('.mp4');
  if (out.localPath) {
    await fsp.copyFile(out.localPath, file);
    return file;
  }
  if (out.inlineBase64) {
    await fsp.writeFile(file, Buffer.from(out.inlineBase64, 'base64'));
    return file;
  }
  if (!out.url) throw new Error('Provider output has no URL');
  const u = new URL(out.url);
  if (u.protocol !== 'https:' && !(ctx.env.isTest && u.protocol === 'http:')) throw new Error('Refusing to download provider output over an insecure URL');
  const res = await ctx.fetch(out.url, { headers: out.headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);
  await streamToFile(res.body, file, maxBytes);
  return file;
}
