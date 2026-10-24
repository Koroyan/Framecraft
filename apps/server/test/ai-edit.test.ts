import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { timelineSchema } from '@framecraft/shared';
import { createTestContext, type TestHarness } from './helpers/context';
import { createMockFetch } from './helpers/mock-fetch';
import { ffmpeg, probe } from '../src/media/ffmpeg';
import { storeAsset, downloadAssetToTemp, type Asset } from '../src/services/assets';
import { assets, editOperations, projects, scenes, shotComments, shots } from '../src/db/schema';
import { getWallet } from '../src/billing/wallet';
import { getTimeline, saveTimeline } from '../src/editor/editor';
import { projectShots } from '../src/editing/versions';
import { acceptAiEdit, createAiEdit, estimateAiEdit, rejectAiEdit } from '../src/editing/ai-edit';
import { addComment } from '../src/editing/comments';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-aiedit-'));
const f = (n: string) => path.join(dir, n);
let green: Buffer;

async function pixel(video: string, t: number, x: number, y: number) {
  const p = await probe(video);
  const out = f(`px-${Math.random().toString(36).slice(2)}.rgb`);
  await ffmpeg(['-ss', String(t), '-i', video, '-frames:v', '1', '-vf', `crop=2:2:${Math.floor((((p.width ?? 4) - 2) * x) / 2) * 2}:${Math.floor((((p.height ?? 4) - 2) * y) / 2) * 2},format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', out]);
  const b = fs.readFileSync(out);
  return [b[0]!, b[1]!, b[2]!] as const;
}
const isRed = ([r, g, b]: readonly number[]) => r! > 180 && g! < 70 && b! < 70;
const isGreen = ([r, g, b]: readonly number[]) => g! > 180 && r! < 70 && b! < 70;

beforeAll(async () => {
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=6:r=24', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('red.mp4')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=4:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('blue.mp4')]);
  // What the "model" returns: a 4 s window, fully green, smaller and at another frame rate.
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x00FF00:s=480x270:d=4:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('green.mp4')]);
  green = fs.readFileSync(f('green.mp4'));
}, 120_000);

describe('localized AI edit (comment → fix → compare → accept)', () => {
  let h: TestHarness;
  const mock = createMockFetch();
  let fail = false;
  beforeAll(async () => {
    const RW = 'https://api.dev.runwayml.com/v1';
    let n = 0;
    mock
      .on('POST', `${RW}/video_to_video`, () => ({ json: { id: `edit-${++n}` } }))
      .on('GET', new RegExp(`${RW}/tasks/`), (c) => ({ json: fail ? { id: 'x', status: 'FAILED', failure: 'Content moderation' } : { id: c.url.split('/tasks/')[1], status: 'SUCCEEDED', output: ['https://cdn.runway.test/edited.mp4'] } }))
      .on('GET', 'https://cdn.runway.test/edited.mp4', () => ({ bytes: green }));
    h = await createTestContext({ env: { LIVE_GENERATION_ENABLED: 'true', RUNWAYML_API_SECRET: 'rw_test_key', DEV_FIXTURES_ENABLED: 'false' }, fetch: mock.fetch });
  });
  afterAll(() => h.close());

  it('edits only the selected seconds and area, keeps audio and other shots, and switches only on accept', async () => {
    const u = await h.makeUser(undefined, 'user', 5000);
    const [project] = await h.ctx.db.insert(projects).values({ userId: u.id, kind: 'movie', title: 'Edit test', aspectRatio: '16:9' }).returning();
    const [scene] = await h.ctx.db.insert(scenes).values({ projectId: project!.id, index: 0, title: 'One' }).returning();
    const red = await storeAsset(h.ctx, { userId: u.id, projectId: project!.id, kind: 'generated', mediaType: 'video', filePath: f('red.mp4'), mimeType: 'video/mp4' });
    const blue = await storeAsset(h.ctx, { userId: u.id, projectId: project!.id, kind: 'generated', mediaType: 'video', filePath: f('blue.mp4'), mimeType: 'video/mp4' });
    const [s1] = await h.ctx.db.insert(shots).values({ projectId: project!.id, sceneId: scene!.id, index: 0, description: 'Hero waves', durationSec: 6, currentAssetId: red.id, status: 'ready' }).returning();
    const [s2] = await h.ctx.db.insert(shots).values({ projectId: project!.id, sceneId: scene!.id, index: 1, description: 'Sky', durationSec: 4, currentAssetId: blue.id, status: 'ready' }).returning();

    // Versions are recorded for existing shots (V1 = what the movie uses).
    const list = await projectShots(h.ctx, u, project!.id);
    expect(list.shots.map((s) => s.versions.length)).toEqual([1, 1]);
    const v1 = list.shots[0]!.versions[0]!;
    const t0 = await getTimeline(h.ctx, u, project!.id);
    await saveTimeline(h.ctx, u, project!.id, timelineSchema.parse({ ...t0.timeline, clips: [{ id: 'c1', assetId: red.id, shotId: s1!.id, versionId: v1.id, inSec: 0, outSec: 6 }, { id: 'c2', assetId: blue.id, shotId: s2!.id, inSec: 0, outSec: 4 }] }));

    // Comment on 2.2–3.4 s with a box over the bottom-right, then "Fix with AI".
    const mask = { rects: [{ x: 0.55, y: 0.55, w: 0.4, h: 0.4, ellipse: false, subtract: false }], polygons: [], strokes: [], feather: 0, invert: false };
    const comment = await addComment(h.ctx, u, s1!.id, { text: 'Fix the hand anatomy', startSec: 2.2, endSec: 3.4, mask, referenceAssetIds: [] });
    const est = await estimateAiEdit(h.ctx, u, { shotId: s1!.id, mode: 'fix', instruction: 'Fix the hand anatomy', startSec: 2.2, endSec: 3.4, mask, referenceAssetIds: [] });
    expect(est).toMatchObject({ available: true, windowStart: 1, windowEnd: 5, seconds: 4, whole: false });
    expect(est.credits).toBeGreaterThan(0);
    const before = await getWallet(h.ctx.db, u.id);

    const { operation } = await createAiEdit(h.ctx, u, { shotId: s1!.id, mode: 'fix', instruction: 'Fix the hand anatomy', startSec: 2.2, endSec: 3.4, mask, referenceAssetIds: [], commentId: comment.id, idempotencyKey: 'edit-test-0001' });
    await h.drain(60);

    // The request: only the 4 s window, inline, with a prompt that names the change and what to keep.
    const call = mock.calls.find((c) => c.url.endsWith('/video_to_video'))!;
    const body = call.body as { model: string; videoUri: string; promptText: string };
    expect(body.model).toBe('aleph2');
    expect(body.videoUri.startsWith('data:video/mp4;base64,')).toBe(true);
    expect(body.promptText).toMatch(/Fix the hand anatomy/);
    expect(body.promptText).toMatch(/bottom-right/);
    expect(body.promptText).toMatch(/Keep everything else/);

    const [op] = await h.ctx.db.select().from(editOperations).where(eq(editOperations.id, operation.id));
    expect(op!.status).toBe('ready');
    const [c] = await h.ctx.db.select().from(shotComments).where(eq(shotComments.id, comment.id));
    expect(c!.status).toBe('ready_for_review');
    // Not active yet: the movie still uses V1.
    expect((await h.ctx.db.select().from(shots).where(eq(shots.id, s1!.id)))[0]!.currentAssetId).toBe(red.id);
    expect((await getWallet(h.ctx.db, u.id)).available).toBe(before.available - est.credits);

    // The result: same length, original audio, green only inside the box during 2.2–3.4 s.
    const after = await projectShots(h.ctx, u, project!.id);
    const v2 = after.shots[0]!.versions.find((v) => v.id === op!.resultVersionId)!;
    expect(v2).toMatchObject({ number: 2, source: 'ai_edit', parentVersionId: v1.id });
    const [resultAsset] = await h.ctx.db.select().from(assets).where(eq(assets.id, v2.assetId));
    const file = await downloadAssetToTemp(h.ctx, resultAsset as Asset);
    const p = await probe(file);
    expect(Math.abs(p.durationSec - 6)).toBeLessThan(0.15);
    expect(p.hasAudio).toBe(true);
    expect(isRed(await pixel(file, 1.0, 0.8, 0.8))).toBe(true); // before the range
    expect(isGreen(await pixel(file, 2.8, 0.8, 0.8))).toBe(true); // inside range and mask
    expect(isRed(await pixel(file, 2.8, 0.1, 0.1))).toBe(true); // inside range, outside mask
    expect(isRed(await pixel(file, 4.4, 0.8, 0.8))).toBe(true); // after the range

    // Accept: shot 1 now uses V2 everywhere; shot 2 is untouched.
    await acceptAiEdit(h.ctx, u, operation.id);
    expect((await h.ctx.db.select().from(shots).where(eq(shots.id, s1!.id)))[0]!.currentAssetId).toBe(v2.assetId);
    const tl = (await getTimeline(h.ctx, u, project!.id)).timeline;
    expect(tl.clips.find((x) => x.id === 'c1')).toMatchObject({ assetId: v2.assetId, versionId: v2.id, inSec: 0, outSec: 6 });
    expect(tl.clips.find((x) => x.id === 'c2')).toMatchObject({ assetId: blue.id, inSec: 0, outSec: 4 });
    expect((await h.ctx.db.select().from(shots).where(eq(shots.id, s2!.id)))[0]!.currentAssetId).toBe(blue.id);
    expect((await h.ctx.db.select().from(shotComments).where(eq(shotComments.id, comment.id)))[0]!.status).toBe('accepted');

    // A failed edit returns the credits and never changes the active version.
    fail = true;
    const wallet = await getWallet(h.ctx.db, u.id);
    const bad = await createAiEdit(h.ctx, u, { shotId: s1!.id, mode: 'relight', instruction: 'Golden hour light', startSec: 0, endSec: 1, referenceAssetIds: [], idempotencyKey: 'edit-test-0002' });
    await h.drain(30);
    fail = false;
    const [badOp] = await h.ctx.db.select().from(editOperations).where(eq(editOperations.id, bad.operation.id));
    expect(badOp!.status).toBe('failed');
    expect(badOp!.error?.message).toMatch(/moderation/);
    expect((await getWallet(h.ctx.db, u.id)).available).toBe(wallet.available);
    expect((await h.ctx.db.select().from(shots).where(eq(shots.id, s1!.id)))[0]!.currentAssetId).toBe(v2.assetId);
    await expect(rejectAiEdit(h.ctx, u, bad.operation.id)).rejects.toThrow();
  }, 240_000);

  it('whole-shot modes are limited to what the model accepts, and other users cannot edit the shot', async () => {
    const u = await h.makeUser(undefined, 'user', 1000);
    const other = await h.makeUser();
    const [project] = await h.ctx.db.insert(projects).values({ userId: u.id, kind: 'movie', title: 'Scope', aspectRatio: '16:9' }).returning();
    const [scene] = await h.ctx.db.insert(scenes).values({ projectId: project!.id, index: 0, title: 'One' }).returning();
    const red = await storeAsset(h.ctx, { userId: u.id, projectId: project!.id, kind: 'generated', mediaType: 'video', filePath: f('red.mp4'), mimeType: 'video/mp4' });
    const [s] = await h.ctx.db.insert(shots).values({ projectId: project!.id, sceneId: scene!.id, index: 0, durationSec: 6, currentAssetId: red.id, status: 'ready' }).returning();
    const est = await estimateAiEdit(h.ctx, u, { shotId: s!.id, mode: 'camera_remix', instruction: 'Low angle view', startSec: 0, endSec: 1, referenceAssetIds: [] });
    expect(est).toMatchObject({ whole: true, windowStart: 0, windowEnd: 6, rangeStart: 0, rangeEnd: 6 });
    await expect(estimateAiEdit(h.ctx, other, { shotId: s!.id, mode: 'fix', instruction: 'x fix', startSec: 0, endSec: 1, referenceAssetIds: [] })).rejects.toThrow(/not found/i);
  }, 60_000);
});
