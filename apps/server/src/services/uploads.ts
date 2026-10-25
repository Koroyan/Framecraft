import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { assets, consents, projects, uploadSessions } from '../db/schema';
import { TERMS_VERSION } from '../auth/auth';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { enqueue, type JobResult, type QueueJob } from '../queue/queue';
import { probe } from '../media/ffmpeg';
import { fitToProviderLimits, makeProxy, needsProxy, type AiInputResult, type ProviderInputLimits } from '../media/prepare';
import { ALLOWED_UPLOADS, assetUrl, downloadAssetToTemp, getOwnedAsset, prepOf, sha256File, sniffMime, storeAsset, tmpFile, type Asset, type MediaPrep } from './assets';
import type { SessionLike } from '../generation/service';

/*
 * Resumable chunked uploads. Large phone videos (4K HEVC MOV, several GB) go up in fixed-size
 * chunks to a temp file — never through one huge request and never fully into memory. A chunk is
 * accepted only at the current offset (a repeated chunk is ignored), so a client can resume after
 * a dropped connection or a page reload. On completion the real file type is sniffed, identical
 * files are deduplicated, the original is stored untouched as the master, and a background job
 * prepares the editing proxy.
 */

const SESSION_TTL_MS = 24 * 3600 * 1000;

const uploadDir = (ctx: AppContext) => path.resolve(ctx.env.STORAGE_LOCAL_DIR, '..', 'uploads');
const partFile = (ctx: AppContext, id: string) => path.join(uploadDir(ctx), `${id}.part`);

export async function storageUsedBytes(ctx: AppContext, userId: string): Promise<number> {
  const [r] = await ctx.db.select({ total: sql<string>`coalesce(sum(${assets.sizeBytes}), 0)` }).from(assets).where(and(eq(assets.userId, userId), isNull(assets.deletedAt)));
  return Number(r?.total ?? 0);
}

async function checkQuota(ctx: AppContext, userId: string, extra: number) {
  const quota = ctx.env.STORAGE_QUOTA_MB * 1024 * 1024;
  if (!quota) return;
  const used = await storageUsedBytes(ctx, userId);
  if (used + extra > quota) throw badRequest(`Not enough storage: ${(used / 1024 ** 3).toFixed(1)} GB of ${(quota / 1024 ** 3).toFixed(0)} GB used. Delete unused media first.`, { usedBytes: used, quotaBytes: quota });
}

const publicSession = (s: typeof uploadSessions.$inferSelect) => ({ id: s.id, filename: s.filename, sizeBytes: s.sizeBytes, receivedBytes: s.receivedBytes, chunkSize: s.chunkSize, status: s.status, assetId: s.assetId, error: s.error });

/** Start (or resume, for the same file) an upload. */
export async function createUploadSession(ctx: AppContext, user: SessionLike, input: { filename: string; sizeBytes: number; fingerprint: string; kind: 'upload' | 'reference'; projectId?: string; rightsConfirmed: boolean; containsPeople: boolean }) {
  if (!input.rightsConfirmed) throw badRequest('Please confirm you own or have permission to use this file.');
  const max = ctx.env.MAX_LARGE_UPLOAD_MB * 1024 * 1024;
  if (input.sizeBytes > max) throw badRequest(`Files must be under ${(ctx.env.MAX_LARGE_UPLOAD_MB / 1024).toFixed(ctx.env.MAX_LARGE_UPLOAD_MB >= 1024 ? 0 : 2)} GB`);
  if (input.sizeBytes <= 0) throw badRequest('The file is empty');
  if (input.projectId) {
    const [p] = await ctx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.userId, user.id)));
    if (!p) throw notFound('Project');
  }
  await sweepExpiredUploads(ctx);
  const [existing] = await ctx.db.select().from(uploadSessions).where(and(eq(uploadSessions.userId, user.id), eq(uploadSessions.fingerprint, input.fingerprint), eq(uploadSessions.sizeBytes, input.sizeBytes), eq(uploadSessions.status, 'uploading')));
  if (existing) {
    // The temp file is the truth (a chunk may have been written but not recorded).
    const onDisk = (await fsp.stat(partFile(ctx, existing.id)).catch(() => null))?.size ?? 0;
    const received = Math.min(onDisk, existing.receivedBytes);
    if (received !== existing.receivedBytes) await ctx.db.update(uploadSessions).set({ receivedBytes: received }).where(eq(uploadSessions.id, existing.id));
    return { session: publicSession({ ...existing, receivedBytes: received }), resumed: true };
  }
  await checkQuota(ctx, user.id, input.sizeBytes);
  const [s] = await ctx.db
    .insert(uploadSessions)
    .values({ userId: user.id, filename: input.filename.slice(0, 200), sizeBytes: input.sizeBytes, chunkSize: ctx.env.UPLOAD_CHUNK_MB * 1024 * 1024, fingerprint: input.fingerprint.slice(0, 300), fields: { kind: input.kind, projectId: input.projectId, rightsConfirmed: true, containsPeople: input.containsPeople }, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .returning();
  await fsp.mkdir(uploadDir(ctx), { recursive: true });
  await fsp.writeFile(partFile(ctx, s!.id), Buffer.alloc(0));
  return { session: publicSession(s!), resumed: false };
}

async function ownedSession(ctx: AppContext, user: SessionLike, id: string) {
  const [s] = await ctx.db.select().from(uploadSessions).where(and(eq(uploadSessions.id, id), eq(uploadSessions.userId, user.id)));
  if (!s) throw notFound('Upload');
  return s;
}

export async function getUploadSession(ctx: AppContext, user: SessionLike, id: string) {
  return publicSession(await ownedSession(ctx, user, id));
}

/** Write one chunk at `offset`. Chunks must arrive in order; an already received chunk is a no-op. */
export async function appendChunk(ctx: AppContext, user: SessionLike, id: string, offset: number, data: Buffer) {
  const s = await ownedSession(ctx, user, id);
  if (s.status !== 'uploading') throw conflict(`This upload is ${s.status}`);
  if (data.length > s.chunkSize) throw badRequest(`Chunks must be at most ${s.chunkSize} bytes`);
  if (offset + data.length > s.sizeBytes) throw badRequest('The chunk goes past the end of the file');
  if (offset + data.length <= s.receivedBytes) return publicSession(s); // retry of a chunk we already have
  if (offset !== s.receivedBytes) throw conflict(`Expected the chunk at byte ${s.receivedBytes}`);
  const fh = await fsp.open(partFile(ctx, id), 'r+').catch(() => null);
  if (!fh) throw conflict('The upload expired; start it again');
  try {
    await fh.write(data, 0, data.length, offset);
  } catch (err) {
    // The offset is unchanged, so the client can resume once space is freed.
    if ((err as NodeJS.ErrnoException).code === 'ENOSPC') throw new AppError('storage_full', 'The server is out of disk space. The upload is paused and can be resumed later.', 507);
    throw err;
  } finally {
    await fh.close();
  }
  // Conditional update: a concurrent duplicate request cannot move the offset twice.
  const [u] = await ctx.db
    .update(uploadSessions)
    .set({ receivedBytes: offset + data.length, updatedAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .where(and(eq(uploadSessions.id, id), eq(uploadSessions.receivedBytes, offset)))
    .returning();
  return publicSession(u ?? (await ownedSession(ctx, user, id)));
}

/** Assemble, verify and store the master; queue the proxy. Identical files are not stored twice. */
export async function completeUpload(ctx: AppContext, user: SessionLike, id: string, ip?: string) {
  const s = await ownedSession(ctx, user, id);
  if (s.status === 'completed' && s.assetId) return { asset: await publicAsset(ctx, await getOwnedAsset(ctx, user.id, s.assetId)), deduplicated: false };
  if (s.status !== 'uploading') throw conflict(`This upload is ${s.status}`);
  if (s.receivedBytes !== s.sizeBytes) throw badRequest(`Upload incomplete: ${s.receivedBytes} of ${s.sizeBytes} bytes received`);
  const [claimed] = await ctx.db.update(uploadSessions).set({ status: 'completing' }).where(and(eq(uploadSessions.id, id), eq(uploadSessions.status, 'uploading'))).returning();
  if (!claimed) throw conflict('This upload is already being completed');
  const file = partFile(ctx, id);
  try {
    if ((await fsp.stat(file)).size !== s.sizeBytes) throw badRequest('The uploaded file is incomplete; upload it again');
    const sniffed = (await sniffMime(file)) ?? (s.filename.toLowerCase().endsWith('.srt') ? 'text/plain' : undefined);
    if (sniffed === 'image/heic') throw badRequest('HEIC photos cannot be decoded on this server. Upload as JPEG (the web uploader converts HEIC automatically in browsers that can open it).');
    const mediaType = sniffed ? ALLOWED_UPLOADS[sniffed] : undefined;
    if (!sniffed || !mediaType) throw badRequest('Unsupported file type. Upload MP4, MOV, M4V, WebM, MKV, JPG, PNG, WebP, MP3, WAV, M4A or SRT.');
    const sha = await sha256File(file);
    const [dup] = await ctx.db.select().from(assets).where(and(eq(assets.userId, user.id), eq(assets.sha256, sha), isNull(assets.deletedAt), sql`${assets.kind} in ('upload','reference')`));
    let asset: Asset;
    let deduplicated = false;
    if (dup) {
      asset = dup;
      deduplicated = true;
    } else {
      if (mediaType === 'video') {
        // Reject files that claim to be video but cannot be decoded, before storing gigabytes.
        const meta = await probe(file).catch(() => null);
        if (!meta?.hasVideo) throw badRequest('This video cannot be read (damaged file or unsupported codec).');
      }
      asset = await storeAsset(ctx, { userId: user.id, projectId: s.fields.projectId, kind: s.fields.kind, mediaType, filePath: file, mimeType: sniffed, originalName: s.filename, source: { uploaded: true, containsPeople: s.fields.containsPeople, ...(mediaType === 'video' ? { prep: { status: 'processing' } satisfies MediaPrep } : {}) } });
      await ctx.db.insert(consents).values({ userId: user.id, kind: s.fields.containsPeople ? 'likeness' : 'copyright', version: TERMS_VERSION, subjectRef: asset.id, ip });
      if (mediaType === 'video') await enqueue(ctx.db, 'media.prepare', { assetId: asset.id }, { queue: 'media', dedupeKey: `media-prepare:${asset.id}`, maxAttempts: 3 });
    }
    await ctx.db.update(uploadSessions).set({ status: 'completed', assetId: asset.id, updatedAt: new Date() }).where(eq(uploadSessions.id, id));
    return { asset: await publicAsset(ctx, asset), deduplicated };
  } catch (err) {
    await ctx.db.update(uploadSessions).set({ status: 'failed', error: (err as Error).message.slice(0, 300) }).where(eq(uploadSessions.id, id));
    throw err;
  } finally {
    await fsp.rm(file, { force: true });
  }
}

export async function cancelUpload(ctx: AppContext, user: SessionLike, id: string) {
  const s = await ownedSession(ctx, user, id);
  if (s.status === 'uploading') {
    await ctx.db.update(uploadSessions).set({ status: 'cancelled' }).where(eq(uploadSessions.id, id));
    await fsp.rm(partFile(ctx, id), { force: true });
  }
  return { ok: true };
}

/** Remove the temp files of uploads that were abandoned. */
export async function sweepExpiredUploads(ctx: AppContext) {
  const stale = await ctx.db.update(uploadSessions).set({ status: 'cancelled' }).where(and(eq(uploadSessions.status, 'uploading'), lt(uploadSessions.expiresAt, new Date()))).returning({ id: uploadSessions.id });
  await Promise.all(stale.map((s) => fsp.rm(partFile(ctx, s.id), { force: true })));
  return stale.length;
}

export async function publicAsset(ctx: AppContext, a: Asset) {
  return { ...a, url: await assetUrl(ctx, a), masterUrl: await assetUrl(ctx, a, { master: true }), downloadUrl: await assetUrl(ctx, a, { download: true }), prep: prepOf(a) ?? null };
}

// ------------------------------------------------------------------ preparation (worker)

const setPrep = async (ctx: AppContext, a: Asset, prep: MediaPrep) => {
  const [row] = await ctx.db.update(assets).set({ source: sql`jsonb_set(${assets.source}, '{prep}', ${JSON.stringify(prep)}::jsonb)` }).where(eq(assets.id, a.id)).returning();
  return row!;
};

/** Inspect the master and, when a browser cannot play it as is, make the editing proxy. */
export async function runPrepareJob(ctx: AppContext, qj: QueueJob): Promise<JobResult> {
  const [a] = await ctx.db.select().from(assets).where(eq(assets.id, String(qj.payload.assetId)));
  if (!a || a.deletedAt || a.mediaType !== 'video') return;
  const src = await downloadAssetToTemp(ctx, a);
  const out = tmpFile('.mp4');
  try {
    const meta = await probe(src);
    const media = { container: meta.formatName, codec: meta.videoCodec, width: meta.width, height: meta.height, rotation: meta.rotation, fps: meta.fps ? Math.round(meta.fps * 100) / 100 : undefined, vfr: meta.vfr, bitRate: meta.bitRate, pixFmt: meta.pixFmt, hdr: meta.hdr, colorTransfer: meta.colorTransfer, audioCodec: meta.audioCodec, audioChannels: meta.audioChannels, durationSec: meta.durationSec, sizeBytes: a.sizeBytes };
    // Fix the stored size for rotated phone footage recorded before display orientation was read.
    if (meta.width && meta.height && (a.width !== meta.width || a.height !== meta.height)) await ctx.db.update(assets).set({ width: meta.width, height: meta.height }).where(eq(assets.id, a.id));
    if (!needsProxy(meta, a.mimeType, a.sizeBytes)) {
      await setPrep(ctx, a, { status: 'ready', media });
      return;
    }
    const proxy = await makeProxy(src, out, meta);
    const proxyKey = a.storageKey.replace(/\/[^/]+$/, '/proxy.mp4');
    await ctx.storage.putFile(proxyKey, out, 'video/mp4');
    await setPrep(ctx, a, { status: 'ready', proxyKey, proxy, media });
  } catch (err) {
    if (qj.attempts < qj.maxAttempts) throw err; // retried with backoff
    await setPrep(ctx, a, { status: 'failed', error: (err as Error).message.split('\n')[0]!.slice(0, 300) });
  } finally {
    await Promise.all([fsp.rm(src, { force: true }), fsp.rm(out, { force: true })]);
  }
}

// ------------------------------------------------------------------ AI-compatible inputs

/** Documented input limits per provider operation (bytes are the provider's, never the upload limit). */
export const PROVIDER_INPUT_LIMITS: Record<string, ProviderInputLimits & { label: string }> = {
  // Runway video_to_video (Aleph): ≤30 s; inline data URI ≤5 MB (base64 grows the file by 4/3).
  'runway:aleph2:inline': { label: 'Runway Aleph (inline upload)', maxBytes: Math.floor(5 * 1024 * 1024 * 0.74), maxDurationSec: 30, maxLongSide: 1280, audio: false },
  // Same model when the input is an HTTPS URL (S3/R2 storage).
  'runway:aleph2:url': { label: 'Runway Aleph (URL)', maxBytes: 32 * 1024 * 1024, maxDurationSec: 30, maxLongSide: 1920, audio: false },
  // Vision/analysis passes only need a light copy.
  analysis: { label: 'Footage analysis', maxBytes: 200 * 1024 * 1024, maxDurationSec: 600, maxLongSide: 960, audio: true },
};

/**
 * An AI-ready copy of part of a master, cached next to it (same part + same limits → reused).
 * The master is untouched; the result says whether only part of the source was used.
 */
export async function prepareAiInput(ctx: AppContext, a: Asset, target: keyof typeof PROVIDER_INPUT_LIMITS | ProviderInputLimits, range: { startSec?: number; durationSec?: number } = {}): Promise<AiInputResult & { key: string; cached: boolean }> {
  if (a.mediaType !== 'video') throw badRequest('Only videos need preparing for the provider');
  const limits = typeof target === 'string' ? PROVIDER_INPUT_LIMITS[target]! : target;
  const sig = crypto.createHash('sha1').update(JSON.stringify([limits.maxBytes, limits.maxDurationSec, limits.maxLongSide, limits.audio, range.startSec ?? 0, range.durationSec ?? null])).digest('hex').slice(0, 12);
  const key = a.storageKey.replace(/\/[^/]+$/, `/ai-${sig}.mp4`);
  const cache = (a.source as { aiInputs?: Record<string, AiInputResult> }).aiInputs?.[sig];
  if (cache && (await ctx.storage.stat(key))) return { ...cache, key, cached: true };
  const src = await downloadAssetToTemp(ctx, a);
  const out = tmpFile('.mp4');
  try {
    const r = await fitToProviderLimits(src, out, limits, range);
    await ctx.storage.putFile(key, out, 'video/mp4');
    await ctx.db.update(assets).set({ source: sql`jsonb_set(${assets.source}, '{aiInputs}', coalesce(${assets.source}->'aiInputs', '{}'::jsonb) || jsonb_build_object(${sig}::text, ${JSON.stringify(r)}::jsonb))` }).where(eq(assets.id, a.id));
    return { ...r, key, cached: false };
  } finally {
    await Promise.all([fsp.rm(src, { force: true }), fsp.rm(out, { force: true })]);
  }
}
