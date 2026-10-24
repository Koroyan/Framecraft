import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { VIDEO_MODELS } from '../src/catalog/video-models';
import { RunwayProvider } from '../src/providers/video/runway';
import { LtxProvider } from '../src/providers/video/ltx';
import { FalProvider, verifyFalWebhookSignature, falAppPath } from '../src/providers/video/fal';
import { GoogleProvider } from '../src/providers/video/google';
import { ReplicateProvider } from '../src/providers/video/replicate';
import { ProviderError, type ProviderVideoRequest } from '../src/providers/video/types';
import { createMockFetch } from './helpers/mock-fetch';

const model = (key: string) => VIDEO_MODELS.find((m) => m.key === key)!;
const req = (key: string, over: Partial<ProviderVideoRequest> = {}): ProviderVideoRequest => ({
  model: model(key),
  mode: 'text-to-video',
  prompt: 'A futuristic car driving through Tokyo at night',
  aspectRatio: '9:16',
  resolution: model(key).capabilities.resolutions[0]!,
  durationSec: model(key).capabilities.durations.allowed?.[0] ?? 5,
  audio: false,
  ...over,
});
const IMG = 'data:image/png;base64,iVBORw0KGgo=';

describe('Runway adapter (mocked HTTP contract)', () => {
  it('submits text_to_video with the documented headers and fields', async () => {
    const m = createMockFetch().on('POST', 'https://api.dev.runwayml.com/v1/text_to_video', () => ({ json: { id: 'task-1' } }));
    const p = new RunwayProvider('key_test', m.fetch);
    const r = await p.submitGeneration(req('runway:veo3.1', { durationSec: 8, audio: true, negativePrompt: 'blur' }), { idempotencyKey: 'k1' });
    expect(r.externalId).toBe('task-1');
    const call = m.calls[0]!;
    expect(call.headers.authorization).toBe('Bearer key_test');
    expect(call.headers['x-runway-version']).toBe('2024-11-06');
    expect(call.body).toMatchObject({ model: 'veo3.1', promptText: expect.any(String), ratio: '720:1280', duration: 8, audio: true, negativePrompt: 'blur' });
  });

  it('sends first/last keyframes as positioned promptImage entries', () => {
    const p = new RunwayProvider('k');
    const { url, body } = p.buildPayload(req('runway:kling3.0_standard', { mode: 'first-last-frame', image: IMG, endImage: IMG, durationSec: 5 }));
    expect(url).toMatch(/image_to_video$/);
    expect(body.promptImage).toEqual([
      { uri: IMG, position: 'first' },
      { uri: IMG, position: 'last' },
    ]);
  });

  // Shapes confirmed against the live API's validation errors (2026-10-22).
  it('sends reference photos where each Runway model accepts them', () => {
    const p = new RunwayProvider('k');
    const seedance = p.buildPayload(req('runway:seedance2_5', { mode: 'reference-to-video', references: [IMG], durationSec: 5 }));
    expect(seedance.url).toMatch(/image_to_video$/);
    expect(seedance.body.promptImage).toEqual([{ uri: IMG }]);
    const omni = p.buildPayload(req('runway:gemini_omni_flash_1.1', { mode: 'reference-to-video', references: [IMG], durationSec: 5 }));
    expect(omni.url).toMatch(/text_to_video$/);
    expect(omni.body.references).toEqual([{ uri: IMG }]);
    // Kling O3 on Runway takes first/last frames only.
    expect(model('runway:klingO3_pro').capabilities.modes).not.toContain('reference-to-video');
  });

  it('only offers 8-second Veo 3.1 clips at 1080p', () => {
    for (const key of ['runway:veo3.1', 'runway:veo3.1_fast']) expect(model(key).capabilities.durationsByResolution?.['1080p']).toEqual([8]);
  });

  it('uses aspect strings and resolution values for MiniMax H3', () => {
    const { body } = new RunwayProvider('k').buildPayload(req('runway:hailuo3', { durationSec: 6 }));
    expect(body).toMatchObject({ ratio: '9:16', resolution: '768p' });
  });

  it('uses auto_* ratios for Wan keyframe requests', () => {
    const { body } = new RunwayProvider('k').buildPayload(req('runway:wan3', { mode: 'first-last-frame', image: IMG, endImage: IMG, resolution: '720p' }));
    expect(body.ratio).toBe('auto_720p');
  });

  it('maps task states, progress, outputs and realized cost', async () => {
    const m = createMockFetch()
      .on('GET', 'https://api.dev.runwayml.com/v1/tasks/a', () => ({ json: { id: 'a', status: 'RUNNING', progress: 0.4 } }))
      .on('GET', 'https://api.dev.runwayml.com/v1/tasks/b', () => ({ json: { id: 'b', status: 'SUCCEEDED', output: ['https://cdn/x.mp4'], cost: { credits: 80 } } }))
      .on('GET', 'https://api.dev.runwayml.com/v1/tasks/c', () => ({ json: { id: 'c', status: 'FAILED', failureCode: 'SAFETY.INPUT.TEXT', failure: 'nope' } }));
    const p = new RunwayProvider('k', m.fetch);
    expect(await p.getGenerationStatus('a')).toMatchObject({ state: 'running', progress: 0.4 });
    const done = await p.getGenerationStatus('b');
    expect(done.state).toBe('succeeded');
    expect(done.costUsd).toBeCloseTo(0.8);
    expect(p.retrieveOutput(done)[0]!.url).toBe('https://cdn/x.mp4');
    const failed = await p.getGenerationStatus('c');
    expect(failed.error).toMatchObject({ code: 'content_policy', retryable: false, providerRefunds: false });
  });

  it('normalizes HTTP errors (429 retryable, 401 auth)', async () => {
    const m = createMockFetch().on('POST', 'https://api.dev.runwayml.com/v1/text_to_video', () => ({ status: 429, json: { error: 'slow down' } }));
    const p = new RunwayProvider('k', m.fetch);
    await expect(p.submitGeneration(req('runway:gen4.5', { durationSec: 5 }), { idempotencyKey: 'x' })).rejects.toMatchObject({ normalized: { code: 'rate_limited', retryable: true } });
    const m2 = createMockFetch().on('POST', 'https://api.dev.runwayml.com/v1/text_to_video', () => ({ status: 401, json: {} }));
    await expect(new RunwayProvider('k', m2.fetch).submitGeneration(req('runway:gen4.5', { durationSec: 5 }), { idempotencyKey: 'x' })).rejects.toMatchObject({ normalized: { code: 'auth' } });
  });

  it('rejects requests the model cannot fulfil before any HTTP call', async () => {
    const m = createMockFetch();
    const p = new RunwayProvider('k', m.fetch);
    await expect(p.submitGeneration(req('runway:gen4_turbo'), { idempotencyKey: 'x' })).rejects.toBeInstanceOf(ProviderError);
    expect(m.calls).toHaveLength(0);
  });

  it('refuses to call the API without credentials', async () => {
    const m = createMockFetch();
    await expect(new RunwayProvider(undefined, m.fetch).submitGeneration(req('runway:gen4.5', { durationSec: 5 }), { idempotencyKey: 'x' })).rejects.toMatchObject({ normalized: { code: 'auth' } });
    expect(m.calls).toHaveLength(0);
  });

  it('cancels via DELETE /v1/tasks/{id}', async () => {
    const m = createMockFetch().on('DELETE', 'https://api.dev.runwayml.com/v1/tasks/t', () => ({ status: 204, text: '' }));
    expect(await new RunwayProvider('k', m.fetch).cancelGeneration('t')).toBe(true);
  });
});

describe('LTX adapter (mocked HTTP contract)', () => {
  it('builds the documented text-to-video body with a real camera_motion', async () => {
    const m = createMockFetch().on('POST', 'https://api.ltx.io/v2/text-to-video', () => ({ status: 202, json: { id: 'j1', created_at: 'now' } }));
    const p = new LtxProvider('ltx_key', m.fetch);
    const r = await p.submitGeneration(req('ltx:ltx-2-3-fast', { durationSec: 8, resolution: '1080p', audio: true, camera: 'dolly_in' }), { idempotencyKey: 'k' });
    expect(r.externalId).toBe('text-to-video:j1');
    expect(m.calls[0]!.headers.authorization).toBe('Bearer ltx_key');
    expect(m.calls[0]!.body).toEqual({ prompt: expect.any(String), model: 'ltx-2-3-fast', duration: 8, resolution: '1080x1920', fps: 24, generate_audio: true, camera_motion: 'dolly_in' });
  });

  it('keeps unsupported camera presets out of the API parameters', () => {
    const { body } = new LtxProvider('k').buildPayload(req('ltx:ltx-2-5-pro', { durationSec: 6, camera: 'orbit' }));
    expect(body.camera_motion).toBeUndefined();
  });

  it('sends duration null together with last_frame_uri', () => {
    const { url, body } = new LtxProvider('k').buildPayload(req('ltx:ltx-2-5-fast', { mode: 'first-last-frame', image: IMG, endImage: IMG, durationSec: 6 }));
    expect(url).toMatch(/image-to-video$/);
    expect(body).toMatchObject({ duration: null, image_uri: IMG, last_frame_uri: IMG });
    expect('duration' in body).toBe(true);
  });

  it('polls the endpoint-specific status URL and maps results', async () => {
    const m = createMockFetch()
      .on('GET', 'https://api.ltx.io/v2/image-to-video/j2', () => ({ json: { id: 'j2', status: 'completed', result: { video_url: 'https://storage/v.mp4' } } }))
      .on('GET', 'https://api.ltx.io/v2/text-to-video/j3', () => ({ json: { id: 'j3', status: 'failed', error: { message: 'safety filter', type: 'safety' } } }));
    const p = new LtxProvider('k', m.fetch);
    expect((await p.getGenerationStatus('image-to-video:j2')).outputs![0]!.url).toBe('https://storage/v.mp4');
    expect((await p.getGenerationStatus('text-to-video:j3')).error!.code).toBe('content_policy');
  });
});

describe('fal.ai adapter (mocked HTTP contract)', () => {
  it('uses Key auth, queue URL and model-specific input names', async () => {
    const m = createMockFetch().on('POST', 'https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video', () => ({ json: { request_id: 'r1' } }));
    const p = new FalProvider('fal_key', m.fetch);
    await p.submitGeneration(req('fal:kling-v3-pro-i2v', { mode: 'image-to-video', image: IMG, durationSec: 5, audio: true }), { idempotencyKey: 'k', webhookUrl: 'https://app/hooks/fal' });
    const call = m.calls[0]!;
    expect(call.headers.authorization).toBe('Key fal_key');
    expect(call.url).toContain('fal_webhook=https%3A%2F%2Fapp%2Fhooks%2Ffal');
    expect(call.body).toMatchObject({ start_image_url: IMG, duration: '5', generate_audio: true });
  });

  it('routes Kling text-to-video to its own endpoint with aspect_ratio and no image fields', () => {
    const { url, body } = new FalProvider('k').buildPayload(req('fal:kling-v3-standard-i2v', { mode: 'text-to-video', durationSec: 10, audio: false }));
    expect(url).toBe('https://queue.fal.run/fal-ai/kling-video/v3/standard/text-to-video');
    expect(body).toEqual({ prompt: expect.any(String), duration: '10', aspect_ratio: '9:16', generate_audio: false });
    const i2v = new FalProvider('k').buildPayload(req('fal:kling-v3-pro-i2v', { mode: 'image-to-video', image: IMG, durationSec: 5 }));
    expect(i2v.url).toMatch(/v3\/pro\/image-to-video$/);
    expect(i2v.body).not.toHaveProperty('aspect_ratio');
  });

  it('prices Kling on fal with the verified audio on/off rates', () => {
    const p = new FalProvider('k');
    expect(p.estimateCost(req('fal:kling-v3-standard-i2v', { mode: 'text-to-video', durationSec: 10, audio: false })).usd).toBeCloseTo(0.84);
    expect(p.estimateCost(req('fal:kling-v3-standard-i2v', { mode: 'text-to-video', durationSec: 10, audio: true })).usd).toBeCloseTo(1.26);
    expect(p.estimateCost(req('fal:kling-v3-pro-i2v', { mode: 'text-to-video', durationSec: 10, audio: false })).usd).toBeCloseTo(1.12);
  });

  it('polls owner/app status URLs and fetches the result on completion', async () => {
    const m = createMockFetch()
      .on('GET', 'https://queue.fal.run/alibaba/wan-3.0/requests/r9/status', () => ({ json: { status: 'COMPLETED' } }))
      .on('GET', 'https://queue.fal.run/alibaba/wan-3.0/requests/r9', () => ({ json: { video: { url: 'https://fal.media/v.mp4' } } }));
    const s = await new FalProvider('k', m.fetch).getGenerationStatus('r9', model('fal:wan-3.0'));
    expect(s.state).toBe('succeeded');
    expect(s.outputs![0]!.url).toBe('https://fal.media/v.mp4');
    expect(falAppPath('fal-ai/kling-video/v3/pro/image-to-video')).toBe('fal-ai/kling-video');
  });

  it('verifies Ed25519 webhook signatures and rejects tampering or stale timestamps', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
    const body = Buffer.from(JSON.stringify({ request_id: 'r', status: 'OK' }));
    const ts = String(Math.floor(Date.now() / 1000));
    const msg = ['r', 'u', ts, crypto.createHash('sha256').update(body).digest('hex')].join('\n');
    const sig = crypto.sign(null, Buffer.from(msg), privateKey).toString('hex');
    const headers = { 'x-fal-webhook-request-id': 'r', 'x-fal-webhook-user-id': 'u', 'x-fal-webhook-timestamp': ts, 'x-fal-webhook-signature': sig };
    const keys = [{ kty: 'OKP', crv: 'Ed25519', x: jwk.x }];
    expect(verifyFalWebhookSignature(headers, body, keys)).toBe(true);
    expect(verifyFalWebhookSignature(headers, Buffer.from('tampered'), keys)).toBe(false);
    expect(verifyFalWebhookSignature(headers, body, keys, Number(ts) + 1000)).toBe(false);
  });
});

describe('Google & Replicate adapters (mocked HTTP contract)', () => {
  it('Veo: predictLongRunning body and operation polling with key-authenticated download', async () => {
    const veo = { ...model('google:veo-3.1-generate-preview'), status: 'active' as const };
    const m = createMockFetch()
      .on('POST', /predictLongRunning$/, () => ({ json: { name: 'operations/op1' } }))
      .on('GET', 'https://generativelanguage.googleapis.com/v1beta/operations/op1', () => ({
        json: { name: 'operations/op1', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://g/v' } }] } } },
      }));
    const p = new GoogleProvider('g_key', m.fetch);
    const r = await p.submitGeneration({ ...req('google:veo-3.1-generate-preview', { durationSec: 8, audio: true }), model: veo }, { idempotencyKey: 'k' });
    expect(m.calls[0]!.headers['x-goog-api-key']).toBe('g_key');
    expect(m.calls[0]!.body).toMatchObject({ instances: [{ prompt: expect.any(String) }], parameters: { aspectRatio: '9:16', durationSeconds: '8' } });
    const s = await p.getGenerationStatus(r.externalId);
    expect(s.outputs![0]).toMatchObject({ url: 'https://g/v', headers: { 'x-goog-api-key': 'g_key' } });
  });

  it('Replicate: predictions API with status mapping', async () => {
    const custom = { ...model('runway:wan3'), key: 'replicate:test', provider: 'replicate' as const, providerModelId: 'owner/video-model' };
    const m = createMockFetch()
      .on('POST', 'https://api.replicate.com/v1/models/owner/video-model/predictions', () => ({ json: { id: 'p1', status: 'starting' } }))
      .on('GET', 'https://api.replicate.com/v1/predictions/p1', () => ({ json: { id: 'p1', status: 'succeeded', output: 'https://r/v.mp4' } }));
    const p = new ReplicateProvider('r_key', m.fetch);
    const r = await p.submitGeneration({ ...req('runway:wan3'), model: custom }, { idempotencyKey: 'k' });
    expect(r.externalId).toBe('p1');
    expect((await p.getGenerationStatus('p1', custom)).outputs![0]!.url).toBe('https://r/v.mp4');
  });
});

describe('catalog integrity', () => {
  it('every model has pricing for each supported resolution', () => {
    for (const m of VIDEO_MODELS) {
      for (const r of m.capabilities.resolutions) {
        expect(m.pricing.some((p) => p.resolution === r), `${m.key} ${r}`).toBe(true);
      }
    }
  });
  it('every Runway model declares endpoints for each mode it supports', () => {
    for (const m of VIDEO_MODELS.filter((x) => x.provider === 'runway')) {
      const eps = (m.providerOptions as { endpoints: Record<string, string> }).endpoints;
      for (const mode of m.capabilities.modes) expect(eps[mode], `${m.key} ${mode}`).toBeDefined();
    }
  });
  it('unique keys', () => {
    expect(new Set(VIDEO_MODELS.map((m) => m.key)).size).toBe(VIDEO_MODELS.length);
  });
});
