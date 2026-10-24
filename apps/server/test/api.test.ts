import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app';
import { createTestContext, type TestHarness } from './helpers/context';
import { generatePlaceholderImage } from '../src/media/ffmpeg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let h: TestHarness;
let app: FastifyInstance;

type Session = { cookie: string; id: string };

async function register(email: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password123', name: 'Tester', acceptTerms: true } });
  expect(res.statusCode).toBe(201);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return { cookie, id: res.json().user.id };
}

const call = (s: Session | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: s ? { cookie: s.cookie } : {} });

async function upload(s: Session, file: string, type: string, fields: Record<string, string> = { rightsConfirmed: 'true' }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set('file', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
  const req = new Request('http://local/upload', { method: 'POST', body: fd });
  return app.inject({ method: 'POST', url: '/api/assets', payload: Buffer.from(await req.arrayBuffer()), headers: { cookie: s.cookie, 'content-type': req.headers.get('content-type')! } });
}

beforeAll(async () => {
  h = await createTestContext();
  app = await buildApp(h.ctx);
});
afterAll(async () => {
  await app.close();
  await h.close();
});

describe('HTTP API', () => {
  it('auth: register, me, logout, login, rejects bad passwords', async () => {
    const s = await register('alice@test.dev');
    const me = await call(s, 'GET', '/api/auth/me');
    expect(me.json().user.email).toBe('alice@test.dev');
    expect(me.json().wallet.balance).toBe(300);
    expect((await call(null, 'POST', '/api/auth/register', { email: 'alice@test.dev', password: 'password123', name: 'x', acceptTerms: true })).statusCode).toBe(409);
    expect((await call(null, 'POST', '/api/auth/login', { email: 'alice@test.dev', password: 'wrong-password1' })).statusCode).toBe(401);
    expect((await call(null, 'POST', '/api/auth/register', { email: 'weak@test.dev', password: 'short', name: 'x', acceptTerms: true })).statusCode).toBe(422);
    await call(s, 'POST', '/api/auth/logout');
    expect((await call(s, 'GET', '/api/auth/me')).json().user).toBeNull();
    expect((await call(null, 'POST', '/api/auth/login', { email: 'alice@test.dev', password: 'password123' })).statusCode).toBe(200);
  });

  it('requires authentication and blocks cross-origin writes', async () => {
    expect((await call(null, 'GET', '/api/projects')).statusCode).toBe(401);
    const s = await register('csrf@test.dev');
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'x' }, headers: { cookie: s.cookie, origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
  });

  it('exposes system status and an honest model catalog', async () => {
    const st = (await call(null, 'GET', '/api/system/status')).json();
    expect(st.liveGenerationEnabled).toBe(false);
    expect(st.aiDirector).toBe('offline');
    const models = (await call(null, 'GET', '/api/models')).json().models;
    expect(models.find((m: { key: string }) => m.key === 'google:veo-3.1-generate-preview').status).toBe('discontinued');
    expect(models.every((m: { configured: boolean }) => !m.configured)).toBe(true);
    expect((await call(null, 'GET', '/api/templates')).json().templates.length).toBe(19);
  });

  it('generation lifecycle with signed, range-capable media URLs', async () => {
    const s = await register('gen@test.dev');
    const est = await call(s, 'POST', '/api/generations/estimate', { spec: { prompt: 'Neon city flythrough at night', durationSec: 5 } });
    expect(est.statusCode).toBe(200);
    expect(est.json().estimate.ok).toBe(true);
    const created = await call(s, 'POST', '/api/generations', { spec: { prompt: 'Neon city flythrough at night', durationSec: 5, enhancePrompt: true }, idempotencyKey: 'http-gen-1' });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().job.id;
    expect(created.json().job.isFixture).toBe(true);
    await h.drain();
    const detail = (await call(s, 'GET', `/api/generations/${jobId}`)).json();
    expect(detail.job.status).toBe('completed');
    expect(detail.job.enhancedPrompt).toContain('Neon city');
    const url: string = detail.job.outputUrl;
    expect(url).toMatch(/^\/api\/media\//);
    const media = await app.inject({ method: 'GET', url });
    expect(media.statusCode).toBe(200);
    expect(media.headers['content-type']).toBe('video/mp4');
    const ranged = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-99' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.length).toBe(100);
    const tampered = await app.inject({ method: 'GET', url: url.replace(/sig=[^&]+/, 'sig=forged') });
    expect(tampered.statusCode).toBe(403);
    const other = await register('other@test.dev');
    expect((await call(other, 'GET', `/api/generations/${jobId}`)).statusCode).toBe(404);
  });

  it('a finished clip appears in the project timeline and asset library', async () => {
    const s = await register('timeline@test.dev');
    const project = (await call(s, 'POST', '/api/projects', { title: 'Clip project', kind: 'quick' })).json().project;
    await call(s, 'POST', '/api/generations', { spec: { prompt: 'Waves crashing on black sand', durationSec: 5, enhancePrompt: false }, projectId: project.id, idempotencyKey: 'timeline-gen-1' });
    await h.drain();
    const tl = (await call(s, 'GET', `/api/projects/${project.id}/timeline`)).json();
    expect(tl.timeline.clips).toHaveLength(1);
    const lib = (await call(s, 'GET', `/api/assets?projectId=${project.id}&mediaType=video`)).json().assets;
    expect(lib).toHaveLength(1);
    expect(lib[0].thumbnailUrl).toBeTruthy();
  });

  it('uploads validate type by content and require rights confirmation', async () => {
    const s = await register('upload@test.dev');
    const img = path.join(os.tmpdir(), `fc-up-${process.pid}.jpg`);
    await generatePlaceholderImage(img, { width: 320, height: 320, title: 'Upload' });
    const ok = await upload(s, img, 'image/jpeg');
    expect(ok.statusCode).toBe(201);
    expect(ok.json().asset.mediaType).toBe('image');
    expect((await upload(s, img, 'image/jpeg', {})).statusCode).toBe(400);
    const fake = path.join(os.tmpdir(), `fc-fake-${process.pid}.jpg`);
    fs.writeFileSync(fake, '<script>alert(1)</script>');
    expect((await upload(s, fake, 'image/jpeg')).statusCode).toBe(400);
    const char = await call(s, 'POST', '/api/characters', { name: 'Nino', description: 'Lead', clothing: 'red coat', referenceAssetIds: [ok.json().asset.id] });
    expect(char.statusCode).toBe(201);
    const list = (await call(s, 'GET', '/api/characters')).json().characters;
    expect(list[0].references).toHaveLength(1);
  });

  it('admin endpoints are restricted and connected to data', async () => {
    const s = await register('notadmin@test.dev');
    expect((await call(s, 'GET', '/api/admin/overview')).statusCode).toBe(403);
    const a = await register('boss@test.dev');
    await h.setRole(a.id, 'admin');
    const ov = await call(a, 'GET', '/api/admin/overview');
    expect(ov.statusCode).toBe(200);
    expect(ov.json().overview.users.total).toBeGreaterThan(1);
    expect(ov.json().planMargins.every((p: { belowMinimum: boolean }) => !p.belowMinimum)).toBe(true);
    const dis = await call(a, 'PATCH', '/api/admin/models/ltx:ltx-2-3-fast', { enabled: false });
    expect(dis.json().model.enabled).toBe(false);
    const models = (await call(s, 'GET', '/api/models')).json().models;
    expect(models.find((m: { key: string }) => m.key === 'ltx:ltx-2-3-fast').routable).toBe(false);
    await call(a, 'PATCH', '/api/admin/models/ltx:ltx-2-3-fast', { enabled: true });
    const cfg = await call(a, 'PUT', '/api/admin/config/pricing', { markup: 0.7 });
    expect(cfg.json().value.markup).toBe(0.7);
    await call(a, 'PUT', '/api/admin/config/pricing', { markup: 0.6 });
    const adj = await call(a, 'POST', `/api/admin/users/${s.id}/credits`, { amount: 50, reason: 'support goodwill', idempotencyKey: 'adj-123456' });
    expect(adj.json().applied).toBe(true);
    expect((await call(s, 'GET', '/api/auth/me')).json().wallet.balance).toBe(350);
    const audit = (await call(a, 'GET', '/api/admin/audit')).json().entries;
    expect(audit.some((e: { action: string }) => e.action === 'admin.credits.adjust')).toBe(true);
  });

  it('AI Director offline planner and the movie pipeline end-to-end', async () => {
    const s = await register('director@test.dev');
    const concepts = (await call(s, 'POST', '/api/director/concepts', { idea: 'A cozy coffee shop in Tbilisi', durationSec: 15 })).json();
    expect(concepts.source).toBe('offline');
    expect(concepts.concepts).toHaveLength(3);
    const copy = (await call(s, 'POST', '/api/director/social-copy', { topic: 'Handmade ceramic mugs' })).json();
    expect(copy.hashtags.length).toBeGreaterThan(2);

    const mv = await call(s, 'POST', '/api/movies', { brief: { idea: 'A detective investigates a mysterious abandoned city', lengthSec: 30, quality: 'balanced', aspectRatio: '16:9' }, idempotencyKey: 'movie-http-1' });
    expect(mv.statusCode).toBe(201);
    const { projectId } = mv.json();
    await h.drain();
    const movie = (await call(s, 'GET', `/api/movies/${projectId}`)).json();
    expect(movie.planJob.status).toBe('completed');
    expect(movie.scenes.length).toBeGreaterThan(1);
    expect(movie.characters[0].name).toMatch(/Detective/);
    const shotId = movie.scenes[0].shots[0].id;
    const patched = await call(s, 'PATCH', `/api/shots/${shotId}`, { prompt: 'Wide aerial shot of a ruined neon city at dawn', durationSec: 4 });
    expect(patched.json().shot.durationSec).toBe(4);

    const est = (await call(s, 'POST', `/api/movies/${projectId}/estimate`, {})).json().estimate;
    expect(est.ok).toBe(true);
    expect(est.shots.length).toBeGreaterThan(2);
    const gen = await call(s, 'POST', `/api/movies/${projectId}/generate`, { approvedCredits: est.totalCredits, idempotencyKey: 'movie-gen-1' });
    expect(gen.statusCode).toBe(200);
    await h.drain(200);
    const done = (await call(s, 'GET', `/api/movies/${projectId}`)).json();
    expect(done.shotJobs.every((j: { status: string }) => j.status === 'completed')).toBe(true);
    expect(done.movieJob.status).toBe('completed');
    expect(done.movieJob.isFixture).toBe(true);
    expect(done.renderJob.outputUrl).toBeTruthy();

    // Resuming: nothing left to generate.
    expect((await call(s, 'POST', `/api/movies/${projectId}/generate`, { approvedCredits: 0, idempotencyKey: 'movie-gen-2' })).statusCode).toBe(400);

    // Editor: load assembled timeline, trim a clip, save, version history, export.
    const tl = (await call(s, 'GET', `/api/projects/${projectId}/timeline`)).json();
    expect(tl.timeline.clips.length).toBe(est.shots.length);
    tl.timeline.clips[0].outSec = 2;
    tl.timeline.texts = [{ id: 't1', text: 'THE CITY', startSec: 0, endSec: 2, position: 'center' }];
    expect((await call(s, 'PUT', `/api/projects/${projectId}/timeline`, { timeline: tl.timeline, label: 'trimmed' })).json().version).toBe(2);
    expect((await call(s, 'GET', `/api/projects/${projectId}/versions`)).json().versions).toHaveLength(2);
    const render = await call(s, 'POST', `/api/projects/${projectId}/render`, { timeline: tl.timeline, preset: 'youtube', idempotencyKey: 'export-1x' });
    expect(render.statusCode).toBe(200);
    await h.drain();
    const job = (await call(s, 'GET', `/api/generations/${render.json().job.id}`)).json().job;
    expect(job.status).toBe('completed');
    expect(job.isFixture).toBe(true);
  }, 300_000);

  it('billing: sandbox checkout grants credits exactly once', async () => {
    const s = await register('buyer@test.dev');
    const plans = (await call(s, 'GET', '/api/billing/plans')).json();
    expect(plans.plans.map((p: { key: string }) => p.key)).toEqual(['free', 'creator', 'pro', 'studio']);
    const co = (await call(s, 'POST', '/api/billing/checkout', { kind: 'credits', productKey: 'pack-1000', idempotencyKey: 'buy-000001' })).json();
    expect(co.checkoutUrl).toContain('/app/billing/sandbox');
    await call(s, 'POST', '/api/billing/sandbox/complete', { paymentId: co.paymentId, outcome: 'success' });
    const again = (await call(s, 'POST', '/api/billing/sandbox/complete', { paymentId: co.paymentId, outcome: 'success' })).json();
    expect(again.applied).toBe(false);
    expect((await call(s, 'GET', '/api/auth/me')).json().wallet.balance).toBe(1300);
    const sub = (await call(s, 'POST', '/api/billing/checkout', { kind: 'subscription', productKey: 'pro', idempotencyKey: 'sub-000001' })).json();
    await call(s, 'POST', '/api/billing/sandbox/complete', { paymentId: sub.paymentId, outcome: 'success' });
    const me = (await call(s, 'GET', '/api/auth/me')).json();
    expect(me.plan.key).toBe('pro');
    expect(me.wallet.balance).toBe(6300);
  });
});
