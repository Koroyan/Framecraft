import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/http/app';
import { createTestContext, type TestHarness } from './helpers/context';
import { ffmpeg, probe } from '../src/media/ffmpeg';
import { fitToProviderLimits, needsProxy } from '../src/media/prepare';
import { assets } from '../src/db/schema';
import { prepareAiInput } from '../src/services/uploads';
import type { Asset } from '../src/services/assets';

/*
 * Large media uploads: resumable chunks, real file-type sniffing, deduplication, quota, the
 * untouched master + browser proxy (MOV, portrait rotation, MKV, HDR), and provider-sized AI inputs.
 * Real FFmpeg, no providers.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-up-'));
const f = (n: string) => path.join(dir, n);

beforeAll(async () => {
  // ~2.5 MB 720p H.264 MP4 with sound (3 chunks of 1 MB).
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=4:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-b:v', '5M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('small.mp4')]);
  // iPhone-style portrait: landscape frames in a MOV plus a 90° rotation.
  // (The rotation is only written on a stream copy.)
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=1280x720:d=3:r=30', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('raw.mov')]);
  await ffmpeg(['-i', f('raw.mov'), '-c', 'copy', '-metadata:s:v:0', 'rotate=90', f('IMG_6641.MOV')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=2:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('clip.mkv')]);
  // 10-bit PQ (HDR10-like) footage.
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=2:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', f('hdr.mp4')]);
  // A 1080p clip with plenty of detail for the size-budget test.
  await ffmpeg(['-f', 'lavfi', '-i', 'mandelbrot=s=1920x1080:r=30', '-t', '8', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', f('detail.mp4')]);
}, 180_000);

let h: TestHarness;
let app: FastifyInstance;
type Session = { cookie: string; id: string };

async function register(email: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password123', name: 'Tester', acceptTerms: true } });
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, id: res.json().user.id };
}
const call = (s: Session, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie } });
const chunk = (s: Session, id: string, offset: number, data: Buffer) => app.inject({ method: 'PUT', url: `/api/uploads/${id}/chunk?offset=${offset}`, payload: data, headers: { cookie: s.cookie, 'content-type': 'application/octet-stream' } });

/** Upload a whole file in chunks the way the web client does. */
async function uploadFile(s: Session, file: string, name = path.basename(file)) {
  const data = fs.readFileSync(file);
  const start = await call(s, 'POST', '/api/uploads', { filename: name, sizeBytes: data.length, fingerprint: `${name}:${data.length}:1`, rightsConfirmed: true });
  expect([200, 201]).toContain(start.statusCode);
  const { session } = start.json();
  for (let off = session.receivedBytes; off < data.length; off += session.chunkSize) expect((await chunk(s, session.id, off, data.subarray(off, off + session.chunkSize))).statusCode).toBe(200);
  const done = await call(s, 'POST', `/api/uploads/${session.id}/complete`);
  expect(done.statusCode).toBe(201);
  return done.json() as { asset: Asset & { url: string; masterUrl: string; prep: { status: string } | null }; deduplicated: boolean };
}

const row = async (id: string) => (await h.ctx.db.select().from(assets).where(eq(assets.id, id)))[0]!;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  h = await createTestContext({ env: { UPLOAD_CHUNK_MB: '1', STORAGE_QUOTA_MB: '60' } });
  app = await buildApp(h.ctx);
});
afterAll(async () => {
  await app.close();
  await h.close();
});

describe('resumable chunked uploads', () => {
  it('resumes after an interruption, ignores repeated chunks, rejects gaps, keeps the master byte for byte', async () => {
    const s = await register('chunks@test.dev');
    const data = fs.readFileSync(f('small.mp4'));
    expect(data.length).toBeGreaterThan(2 * 1024 * 1024);
    const body = { filename: 'small.mp4', sizeBytes: data.length, fingerprint: 'small.mp4:1', rightsConfirmed: true };
    const first = (await call(s, 'POST', '/api/uploads', body)).json().session;
    const size = first.chunkSize;
    expect(size).toBe(1024 * 1024);
    expect((await chunk(s, first.id, 0, data.subarray(0, size))).statusCode).toBe(200);
    // The connection drops; the page reloads and asks again for the same file → same session, resumes at 1 MB.
    const again = await call(s, 'POST', '/api/uploads', body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ resumed: true, session: { id: first.id, receivedBytes: size } });
    // A retried chunk is a no-op; a chunk past the current offset is refused.
    expect((await chunk(s, first.id, 0, data.subarray(0, size))).json().session.receivedBytes).toBe(size);
    expect((await chunk(s, first.id, 2 * size, data.subarray(2 * size, 3 * size))).statusCode).toBe(409);
    // Completing early is refused.
    expect((await call(s, 'POST', `/api/uploads/${first.id}/complete`)).statusCode).toBe(400);
    for (let off = size; off < data.length; off += size) await chunk(s, first.id, off, data.subarray(off, off + size));
    const done = await call(s, 'POST', `/api/uploads/${first.id}/complete`);
    expect(done.statusCode).toBe(201);
    const asset = done.json().asset;
    expect(asset.mimeType).toBe('video/mp4');
    expect(asset.width).toBe(1280);
    expect(sha(await h.ctx.storage.getBuffer((await row(asset.id)).storageKey))).toBe(sha(data));
    // A browser-ready H.264/AAC MP4 needs no proxy.
    await h.drain();
    const prepared = await row(asset.id);
    expect((prepared.source as { prep: { status: string; proxyKey?: string } }).prep).toMatchObject({ status: 'ready' });
    expect((prepared.source as { prep: { proxyKey?: string } }).prep.proxyKey).toBeUndefined();
    // Uploading the same file again stores nothing new.
    const dup = await uploadFile(s, f('small.mp4'), 'copy.mp4');
    expect(dup.deduplicated).toBe(true);
    expect(dup.asset.id).toBe(asset.id);
  }, 120_000);

  it('cancels an upload and removes its temp data; enforces the size and storage limits', async () => {
    const s = await register('limits@test.dev');
    const r = (await call(s, 'POST', '/api/uploads', { filename: 'a.mp4', sizeBytes: 5000, fingerprint: 'a', rightsConfirmed: true })).json().session;
    expect((await call(s, 'DELETE', `/api/uploads/${r.id}`)).statusCode).toBe(200);
    expect((await chunk(s, r.id, 0, Buffer.alloc(100))).statusCode).toBe(409);
    // 60 MB quota in this test.
    const big = await call(s, 'POST', '/api/uploads', { filename: 'huge.mov', sizeBytes: 3 * 1024 ** 3, fingerprint: 'huge', rightsConfirmed: true });
    expect(big.statusCode).toBe(400);
    expect(big.json().error.message).toMatch(/storage/i);
    expect((await call(s, 'POST', '/api/uploads', { filename: 'x.mp4', sizeBytes: 10, fingerprint: 'x', rightsConfirmed: false })).statusCode).toBe(400);
    // Renamed junk is rejected by its content, not its name.
    const junk = Buffer.from('this is not a video at all, just text pretending to be one');
    const j = (await call(s, 'POST', '/api/uploads', { filename: 'fake.mov', sizeBytes: junk.length, fingerprint: 'fake', rightsConfirmed: true })).json().session;
    await chunk(s, j.id, 0, junk);
    const bad = await call(s, 'POST', `/api/uploads/${j.id}/complete`);
    expect(bad.statusCode).toBe(400);
  });

  it('portrait iPhone MOV: stored untouched, shown upright, edited from an H.264 proxy', async () => {
    const s = await register('iphone@test.dev');
    const meta = await probe(f('IMG_6641.MOV'));
    expect(meta.rotation === 90 || meta.rotation === 270).toBe(true);
    expect([meta.width, meta.height]).toEqual([720, 1280]);
    const { asset } = await uploadFile(s, f('IMG_6641.MOV'));
    expect(asset.mimeType).toBe('video/quicktime');
    expect(asset.prep?.status).toBe('processing');
    expect([asset.width, asset.height]).toEqual([720, 1280]);
    await h.drain();
    const a = await row(asset.id);
    const prep = (a.source as { prep: { status: string; proxyKey: string; proxy: { width: number; height: number }; media: { rotation: number; codec: string } } }).prep;
    expect(prep.status).toBe('ready');
    expect(prep.proxy).toMatchObject({ width: 720, height: 1280 });
    expect(prep.media.codec).toBe('h264');
    // The master is the original MOV; the proxy is a separate upright MP4 of the same length, with sound.
    expect(sha(await h.ctx.storage.getBuffer(a.storageKey))).toBe(sha(fs.readFileSync(f('IMG_6641.MOV'))));
    const proxyFile = f('proxy-out.mp4');
    await h.ctx.storage.getToFile(prep.proxyKey, proxyFile);
    const pm = await probe(proxyFile);
    expect(pm).toMatchObject({ width: 720, height: 1280, rotation: 0, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true });
    expect(Math.abs(pm.durationSec - meta.durationSec)).toBeLessThan(0.15);
    // The browser plays the proxy; downloads and exports use the master.
    const info = (await call(s, 'GET', `/api/assets/${asset.id}/prep`)).json().asset;
    expect(info.url).toContain('proxy.mp4');
    expect(info.masterUrl).not.toContain('proxy.mp4');
    const served = await app.inject({ method: 'GET', url: info.url.replace(/^https?:\/\/[^/]+/, '') });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('video/mp4');
  }, 120_000);

  it('MKV and HDR footage get browser-safe SDR proxies', async () => {
    const s = await register('formats@test.dev');
    const mkv = await uploadFile(s, f('clip.mkv'));
    expect(mkv.asset.mimeType).toBe('video/x-matroska');
    const hdrMeta = await probe(f('hdr.mp4'));
    expect(hdrMeta.hdr).toBe(true);
    const hdr = await uploadFile(s, f('hdr.mp4'));
    await h.drain();
    for (const id of [mkv.asset.id, hdr.asset.id]) {
      const prep = ((await row(id)).source as { prep: { status: string; proxyKey: string } }).prep;
      expect(prep.status).toBe('ready');
      const out = f(`p-${id}.mp4`);
      await h.ctx.storage.getToFile(prep.proxyKey, out);
      const pm = await probe(out);
      expect(pm.videoCodec).toBe('h264');
      expect(pm.pixFmt).toBe('yuv420p');
      expect(pm.hdr).toBe(false);
    }
  }, 120_000);
});

describe('AI-compatible inputs', () => {
  it('fits a provider byte limit without touching the master; longer sources are marked partial', async () => {
    const meta = await probe(f('detail.mp4'));
    const src = fs.statSync(f('detail.mp4')).size;
    expect(src).toBeGreaterThan(3 * 1024 * 1024);
    const limit = 1024 * 1024;
    const r = await fitToProviderLimits(f('detail.mp4'), f('ai1.mp4'), { maxBytes: limit, maxDurationSec: 30, maxLongSide: 1920, audio: false });
    expect(r.bytes).toBeLessThanOrEqual(limit);
    expect(r.partial).toBe(false);
    expect(Math.abs(r.durationSec - meta.durationSec)).toBeLessThan(0.1);
    // A 4 s model limit: only 4 s are used, and the caller is told.
    const p = await fitToProviderLimits(f('detail.mp4'), f('ai2.mp4'), { maxBytes: limit, maxDurationSec: 4, maxLongSide: 1280, audio: false }, { startSec: 2 });
    expect(p).toMatchObject({ partial: true, startSec: 2, durationSec: 4 });
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1280);
    expect(Math.abs((await probe(f('ai2.mp4'))).durationSec - 4)).toBeLessThan(0.15);
    // Impossible budgets fail clearly instead of producing garbage.
    await expect(fitToProviderLimits(f('detail.mp4'), f('ai3.mp4'), { maxBytes: 20_000, maxDurationSec: 30, maxLongSide: 1280, audio: false })).rejects.toThrow(/shorter part/);
  }, 120_000);

  it('caches the prepared input per range and limit next to the master', async () => {
    const s = await register('aiinput@test.dev');
    const { asset } = await uploadFile(s, f('detail.mp4'));
    const a = await row(asset.id);
    const first = await prepareAiInput(h.ctx, a, 'runway:aleph2:inline', { startSec: 1, durationSec: 5 });
    expect(first.cached).toBe(false);
    expect(first.bytes).toBeLessThanOrEqual(5 * 1024 * 1024 * 0.74);
    const second = await prepareAiInput(h.ctx, await row(asset.id), 'runway:aleph2:inline', { startSec: 1, durationSec: 5 });
    expect(second).toMatchObject({ cached: true, key: first.key });
    expect(sha(await h.ctx.storage.getBuffer(a.storageKey))).toBe(sha(fs.readFileSync(f('detail.mp4'))));
    // Deleting the media removes the master and everything prepared from it.
    expect((await call(s, 'DELETE', `/api/assets/${asset.id}`)).statusCode).toBe(200);
    expect(await h.ctx.storage.stat(a.storageKey)).toBeNull();
    expect(await h.ctx.storage.stat(first.key)).toBeNull();
  }, 120_000);

  it('knows which sources a browser can play as they are', () => {
    const base = { durationSec: 5, hasVideo: true, hasAudio: true, width: 1920, height: 1080, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', bitRate: 8_000_000 };
    expect(needsProxy(base, 'video/mp4', 5_000_000)).toBe(false);
    expect(needsProxy({ ...base, videoCodec: 'hevc' }, 'video/mp4', 5_000_000)).toBe(true);
    expect(needsProxy({ ...base, width: 3840, height: 2160 }, 'video/mp4', 5_000_000)).toBe(true);
    expect(needsProxy(base, 'video/quicktime', 5_000_000)).toBe(true);
    expect(needsProxy({ ...base, vfr: true }, 'video/mp4', 5_000_000)).toBe(true);
  });
});
