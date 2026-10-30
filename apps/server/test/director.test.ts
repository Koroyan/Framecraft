import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { directorRequestSchema, type DirectorOp } from '@framecraft/shared';
import { createTestContext, type TestHarness } from './helpers/context';
import { FakeLlm } from '../src/director/llm';
import { ffmpeg } from '../src/media/ffmpeg';
import { storeAsset } from '../src/services/assets';
import { characters, locations, projects, scenes, shots } from '../src/db/schema';
import { saveTimeline } from '../src/editor/editor';
import { projectShots } from '../src/editing/versions';
import { applyDirectorOps, applyRequestSchema, composeShotPrompt, directorPlan, runDirectorOp } from '../src/director/story';

/*
 * AI Director in the story graph: plans stay inside the chosen scope (shot / scene / connection),
 * unknown ids never reach the user, free steps apply in one transaction and undo exactly, generated
 * takes are never deleted, and paid steps never run without an approved price. The model is fake.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-director-'));
const f = (n: string) => path.join(dir, n);

let next: unknown = { reply: 'ok', operations: [] };
let broken = false;
const llm = new FakeLlm(({ system }) => {
  if (broken) throw new Error('model down');
  if (system.startsWith('You are the AI Director inside Framecraft')) return next;
  return { reply: 'unused', operations: [] };
});

let h: TestHarness;
let user: { id: string; role: 'user' | 'admin' };
let projectId = '';
const ids = { sc1: '', sc2: '', s1: '', s2: '', s3: '', s4: '', bolt: '', pepper: '' };

beforeAll(async () => {
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=320x180:d=3:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('a.mp4')]);
  h = await createTestContext({ llm });
  const u = await h.makeUser(undefined, 'user', 2000);
  user = { id: u.id, role: 'user' };
  const [p] = await h.ctx.db
    .insert(projects)
    .values({ userId: u.id, kind: 'movie', title: 'Robot chef', aspectRatio: '16:9', settings: { brief: { idea: 'A small robot wants to become a chef', style: 'cartoon_3d' } } })
    .returning();
  projectId = p!.id;
  const [sc1] = await h.ctx.db.insert(scenes).values({ projectId, index: 0, title: 'Kitchen', synopsis: 'Bolt tries to cook.' }).returning();
  const [sc2] = await h.ctx.db.insert(scenes).values({ projectId, index: 1, title: 'Tasting', synopsis: 'Pepper tastes.' }).returning();
  const [bolt] = await h.ctx.db.insert(characters).values({ userId: u.id, projectId, name: 'Bolt', description: 'A small blue robot with round eyes', clothing: 'a white chef hat' }).returning();
  const [pepper] = await h.ctx.db.insert(characters).values({ userId: u.id, projectId, name: 'Pepper', description: 'A playful spotted dog' }).returning();
  const video = await storeAsset(h.ctx, { userId: u.id, projectId, kind: 'generated', mediaType: 'video', filePath: f('a.mp4'), mimeType: 'video/mp4' });
  const add = async (sceneId: string, index: number, description: string, generated: boolean) =>
    (await h.ctx.db.insert(shots).values({ projectId, sceneId, index, description, prompt: description, durationSec: 5, characterIds: [bolt!.id], status: generated ? 'ready' : 'planned', currentAssetId: generated ? video.id : null }).returning())[0]!;
  const s1 = await add(sc1!.id, 0, 'Bolt stirs a huge pot', true);
  const s2 = await add(sc1!.id, 1, 'Soup explodes', false);
  const s3 = await add(sc2!.id, 0, 'Pepper sniffs the bowl', true);
  const s4 = await add(sc2!.id, 1, 'Pepper wags happily', false);
  Object.assign(ids, { sc1: sc1!.id, sc2: sc2!.id, s1: s1.id, s2: s2.id, s3: s3.id, s4: s4.id, bolt: bolt!.id, pepper: pepper!.id });
  // The movie plays the two generated shots; versions are created from the current takes.
  await saveTimeline(h.ctx, user, projectId, { aspectRatio: '16:9', clips: [{ id: 'c1', assetId: video.id, shotId: s1.id, inSec: 0, outSec: 3 }, { id: 'c3', assetId: video.id, shotId: s3.id, inSec: 0, outSec: 3 }] } as never);
  await projectShots(h.ctx, user, projectId);
}, 120_000);
afterAll(() => h.close());

const ask = (message: string, scope: unknown) => directorPlan(h.ctx, user, projectId, directorRequestSchema.parse({ message, scope }));

describe('AI Director plans', () => {
  it('keeps a shot request on that shot, drops unknown ids and prices nothing that is free', async () => {
    next = {
      reply: 'Done',
      operations: [
        { op: 'shot.update', shotId: ids.s1, camera: 'dolly_in', description: 'Bolt stirs, camera pushing in' },
        { op: 'shot.update', shotId: ids.s3, description: 'should be blocked' },
        { op: 'shot.insert', ref: 'new1', sceneId: ids.sc1, afterShotId: ids.s1, description: 'Close-up: Bolt looks surprised', durationSec: 4, camera: 'close_up', characterIds: [ids.bolt] },
        { op: 'timeline', timeline: { op: 'transition', shot: 1, type: 'dissolve', durationSec: 0.5 } },
        { op: 'shot.update', shotId: '99999999-9999-4999-8999-999999999999', description: 'unknown shot' },
        { op: 'character.update', characterId: ids.bolt, description: 'A small red robot' },
      ],
    };
    const r = await ask('Make the robot look surprised', { kind: 'shot', shotId: ids.s1 });
    expect(r.offline).toBe(false);
    expect(llm.calls.at(-1)!.prompt).toContain(`Scope: ONLY shot id ${ids.s1}`);
    expect(llm.calls.at(-1)!.prompt).toContain('A small blue robot with round eyes');
    const ops = r.items.map((i) => [i.op.op, i.blocked ? 'blocked' : 'ok']);
    expect(ops).toEqual([
      ['shot.update', 'ok'],
      ['shot.update', 'blocked'],
      ['shot.insert', 'ok'],
      ['timeline', 'ok'],
      ['character.update', 'blocked'],
    ]);
    expect(r.items[2]!.summary).toMatch(/New shot after Scene 1 · shot 1: “Close-up: Bolt looks surprised” · 4 s · Close-Up · Bolt/);
    expect(r.items.every((i) => !i.paid)).toBe(true);
  });

  it('a connection only allows new shots between its two shots and edits of those two', async () => {
    next = {
      reply: 'Done',
      operations: [
        { op: 'shot.insert', ref: 'new1', sceneId: ids.sc1, afterShotId: ids.s1, description: 'Bolt runs to the table' },
        { op: 'shot.insert', ref: 'new2', sceneId: ids.sc2, afterShotId: ids.s3, description: 'elsewhere' },
        { op: 'timeline', timeline: { op: 'match_color', shot: 2, fromShot: 1 } },
        { op: 'shot.remove', shotId: ids.s3 },
      ],
    };
    const r = await ask('Smooth the continuity', { kind: 'edge', fromShotId: ids.s1, toShotId: ids.s3 });
    expect(r.items.map((i) => Boolean(i.blocked))).toEqual([false, true, false, true]);
  });

  it('character changes are allowed on the whole project, and paid steps carry a price or a reason', async () => {
    next = { reply: 'ok', operations: [{ op: 'character.update', characterId: ids.bolt, description: 'A small red robot with round eyes' }, { op: 'shot.generate', shotIds: [ids.s2] }, { op: 'shot.ai_edit', shotId: ids.s2, mode: 'restyle', instruction: 'make it red' }] };
    const r = await ask('Make Bolt red everywhere', { kind: 'project' });
    expect(r.items[0]).toMatchObject({ paid: false });
    expect(r.items[0]!.blocked).toBeUndefined();
    expect(r.items[1]).toMatchObject({ paid: true });
    expect(r.items[1]!.estimate?.credits ?? r.items[1]!.blocked).toBeDefined();
    // An AI edit needs footage: the planned shot cannot be edited yet.
    expect(r.items[2]).toMatchObject({ paid: true, blocked: 'This shot has no video yet — generate it first.' });
  });

  it('without the AI service: an honest offline answer that becomes one direct edit of this shot', async () => {
    broken = true;
    try {
      const gen = await ask('Make the robot red instead of blue, keep its shape', { kind: 'shot', shotId: ids.s1 });
      expect(gen.offline).toBe(true);
      expect(gen.reply).toMatch(/not configured/);
      expect(gen.items[0]!.op).toMatchObject({ op: 'shot.ai_edit', shotId: ids.s1, mode: 'restyle' });
      const planned = await ask('ცოტა უფრო მხიარული გახადე', { kind: 'shot', shotId: ids.s2 });
      expect(planned.reply).toMatch(/ჩართული/);
      expect(planned.items[0]!.op).toMatchObject({ op: 'shot.update', shotId: ids.s2 });
      expect((planned.items[0]!.op as Extract<DirectorOp, { op: 'shot.update' }>).patch.prompt).toContain('Revision: ცოტა უფრო მხიარული გახადე');
      const whole = await ask('Make the story funnier', { kind: 'project' });
      expect(whole.items).toEqual([]);
    } finally {
      broken = false;
    }
  });
});

describe('applying the Director’s free steps', () => {
  const apply = (ops: unknown[], scope: unknown = { kind: 'project' }) => applyDirectorOps(h.ctx, user, projectId, applyRequestSchema.parse({ ops, scope }));
  const scene1 = async () => (await h.ctx.db.select().from(shots).where(eq(shots.sceneId, ids.sc1)).orderBy(asc(shots.index))).map((s) => s.id);

  it('inserts a planned shot in place with a complete prompt, edits, removes — and undoes exactly', async () => {
    const before = await scene1();
    const r = await apply([
      { op: 'shot.insert', ref: 'new1', sceneId: ids.sc1, afterShotId: ids.s1, shot: { description: 'Close-up: Bolt looks surprised', durationSec: 4, camera: 'close_up', shotType: 'close-up', characterIds: [ids.bolt] } },
      { op: 'shot.update', shotId: ids.s2, patch: { camera: 'orbit', durationSec: 7 } },
      { op: 'shot.remove', shotId: ids.s4 },
    ]);
    const created = r.created.new1!;
    expect(await scene1()).toEqual([ids.s1, created, ids.s2]);
    const [row] = await h.ctx.db.select().from(shots).where(eq(shots.id, created));
    expect(row).toMatchObject({ status: 'planned', durationSec: 4, camera: 'close_up', characterIds: [ids.bolt] });
    // Written for a video model: the cast's look word for word, the framing and the cartoon style.
    expect(row!.prompt).toContain('Bolt: A small blue robot with round eyes; wearing a white chef hat');
    expect(row!.prompt).toContain('intimate close-up shot');
    expect(row!.prompt).toContain('stylized 3D cartoon animation');
    expect((await h.ctx.db.select().from(shots).where(eq(shots.id, ids.s4))).length).toBe(0);

    await apply(r.undo as unknown[]);
    expect(await scene1()).toEqual(before);
    const [s2] = await h.ctx.db.select().from(shots).where(eq(shots.id, ids.s2));
    expect(s2).toMatchObject({ camera: null, durationSec: 5 });
    const scene2 = await h.ctx.db.select().from(shots).where(eq(shots.sceneId, ids.sc2)).orderBy(asc(shots.index));
    expect(scene2.map((s) => s.description)).toEqual(['Pepper sniffs the bowl', 'Pepper wags happily']);
    ids.s4 = scene2[1]!.id;
  });

  it('a generated shot only leaves the movie; its takes are never deleted', async () => {
    const r = await apply([{ op: 'shot.remove', shotId: ids.s3 }]);
    expect(r.leaveMovie).toEqual([ids.s3]);
    expect((await h.ctx.db.select().from(shots).where(eq(shots.id, ids.s3))).length).toBe(1);
  });

  it('moves a shot into another scene and back', async () => {
    const r = await apply([{ op: 'shot.move', shotId: ids.s2, sceneId: ids.sc2, afterShotId: ids.s3 }]);
    expect((await h.ctx.db.select().from(shots).where(eq(shots.sceneId, ids.sc2)).orderBy(asc(shots.index))).map((s) => s.id)).toEqual([ids.s3, ids.s2, ids.s4]);
    await apply(r.undo as unknown[]);
    expect(await scene1()).toEqual([ids.s1, ids.s2]);
  });

  it('continuing a generated shot starts the new one from its last frame (free)', async () => {
    const r = await apply([{ op: 'shot.insert', ref: 'new1', sceneId: ids.sc1, afterShotId: ids.s1, shot: { description: 'Continues: Bolt stirs', characterIds: [ids.bolt], continueFrom: ids.s1 } }], { kind: 'shot', shotId: ids.s1 });
    const [row] = await h.ctx.db.select().from(shots).where(eq(shots.id, r.created.new1!));
    expect(row!.storyboardAssetId).toBeTruthy();
    expect(row!.status).toBe('storyboarded');
    await apply(r.undo as unknown[]);
  });

  it('refuses paid steps, timeline steps, other scopes and other projects’ ids', async () => {
    await expect(apply([{ op: 'shot.generate', shotIds: [ids.s2] }])).rejects.toThrow(/approve their price/);
    await expect(apply([{ op: 'timeline', plan: { op: 'speed', shot: 1, speed: 2 } }])).rejects.toThrow(/editor/);
    await expect(apply([{ op: 'shot.update', shotId: ids.s3, patch: { durationSec: 3 } }], { kind: 'shot', shotId: ids.s1 })).rejects.toThrow(/Outside this shot/);
    await expect(apply([{ op: 'shot.update', shotId: '99999999-9999-4999-8999-999999999999', patch: { durationSec: 3 } }])).rejects.toThrow(/not found/);
    const other = await h.makeUser();
    await expect(applyDirectorOps(h.ctx, { id: other.id, role: 'user' }, projectId, applyRequestSchema.parse({ ops: [{ op: 'shot.remove', shotId: ids.s2 }] }))).rejects.toThrow(/not found/);
  });

  it('a scene takes a saved location: new shots are set there, undo puts the old place back, other people’s places are refused', async () => {
    const [bakery] = await h.ctx.db.insert(locations).values({ userId: user.id, name: 'Moonlight Bakery', description: 'a warm bakery at night' }).returning();
    const r = await apply([{ op: 'scene.update', sceneId: ids.sc1, locationId: bakery!.id }]);
    expect((await h.ctx.db.select().from(scenes).where(eq(scenes.id, ids.sc1)))[0]!.locationId).toBe(bakery!.id);
    const ins = await apply([{ op: 'shot.insert', ref: 'new1', sceneId: ids.sc1, afterShotId: ids.s1, shot: { description: 'Bolt waves', characterIds: [ids.bolt] } }]);
    const [row] = await h.ctx.db.select().from(shots).where(eq(shots.id, ins.created.new1!));
    expect(row!.prompt).toContain('Setting: Moonlight Bakery — a warm bakery at night');
    await apply(ins.undo as unknown[]);
    await apply(r.undo as unknown[]);
    expect((await h.ctx.db.select().from(scenes).where(eq(scenes.id, ids.sc1)))[0]!.locationId).toBeNull();
    const other = await h.makeUser();
    const [theirs] = await h.ctx.db.insert(locations).values({ userId: other.id, name: 'Not yours' }).returning();
    await expect(apply([{ op: 'scene.update', sceneId: ids.sc1, locationId: theirs!.id }])).rejects.toThrow(/not found/);
  });

  it('paid steps never run below their price', async () => {
    const run = runDirectorOp(h.ctx, user, projectId, { op: { op: 'shot.generate', shotIds: [ids.s2] }, approvedCredits: 0, idempotencyKey: 'director-test-1' });
    await expect(run).rejects.toThrow(/(credits|not set up|approve)/);
  });
});

describe('prompt writing', () => {
  it('a short request becomes a complete prompt without inventing anything', () => {
    const p = composeShotPrompt({ description: 'Pepper jumps', camera: 'tracking', cast: [{ name: 'Pepper', description: 'A playful spotted dog', appearance: {}, clothing: '' } as never], place: { name: 'Kitchen', description: 'a tiny bright kitchen' }, style: 'cartoon_2d', previous: 'Bolt stirs a pot' });
    expect(p).toBe('Pepper jumps. Tracking shot following the subject at matching speed. Characters — Pepper: A playful spotted dog. Setting: Kitchen — a tiny bright kitchen. Continuity: same characters, place, light and colour as the previous shot (Bolt stirs a pot). Look: traditional 2D hand-drawn animation, clean ink outlines, flat cel shading, hand-painted backgrounds, lively squash-and-stretch motion. No on-screen text.');
  });
});
