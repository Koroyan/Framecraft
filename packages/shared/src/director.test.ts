import { describe, expect, it } from 'vitest';
import { anchorKeyFor, charactersIn, directorOpSchema, quickDirect, sequenceOf, storyOrder, timelineSchema, type DirectorQuickContext, type QuickShot } from './index';

const A = '00000000-0000-4000-8000-00000000000a';
const S1 = '10000000-0000-4000-8000-000000000001';
const S2 = '10000000-0000-4000-8000-000000000002';
const S3 = '10000000-0000-4000-8000-000000000003';
const P1 = '10000000-0000-4000-8000-0000000000f1';
const P2 = '10000000-0000-4000-8000-0000000000f2';
const SC1 = '20000000-0000-4000-8000-000000000001';
const SC2 = '20000000-0000-4000-8000-000000000002';
const ROBOT = '30000000-0000-4000-8000-000000000001';
const DOG = '30000000-0000-4000-8000-000000000002';

const movie = () =>
  sequenceOf(
    timelineSchema.parse({
      clips: [
        { id: 'c1', assetId: A, shotId: S1, inSec: 0, outSec: 4 },
        { id: 'c2', assetId: A, shotId: S2, inSec: 0, outSec: 5 },
        { id: 'c3', assetId: A, shotId: S3, inSec: 0, outSec: 6 },
      ],
    }),
  );

describe('story order', () => {
  // Script: S1, P1 (planned), S2 | S3, P2 (planned)
  const shots = [
    { id: S1, sceneIndex: 0, index: 0, generated: true },
    { id: P1, sceneIndex: 0, index: 1, generated: false },
    { id: S2, sceneIndex: 0, index: 2, generated: true },
    { id: S3, sceneIndex: 1, index: 0, generated: true },
    { id: P2, sceneIndex: 1, index: 1, generated: false },
  ];

  it('puts planned shots right after the shot before them in the script', () => {
    expect(storyOrder(movie(), shots).map((e) => (e.planned ? `plan:${e.shotId === P1 ? 'P1' : 'P2'}` : e.key))).toEqual([S1, 'plan:P1', S2, S3, 'plan:P2']);
    expect(anchorKeyFor(P1, movie(), shots)).toBe(S1);
  });

  it('a planned first shot sits at the start; a moved anchor takes its planned shot along', () => {
    const first = [{ id: P1, sceneIndex: 0, index: 0, generated: false }, ...shots.filter((s) => s.id !== P1)];
    expect(storyOrder(movie(), first)[0]).toMatchObject({ shotId: P1, planned: true });
    expect(anchorKeyFor(P1, movie(), first)).toBeNull();
    // The movie plays S2, S1, S3 now: P1 still follows S1.
    const seq = movie();
    const reordered = [seq[1]!, seq[0]!, seq[2]!];
    expect(storyOrder(reordered, shots).map((e) => e.shotId)).toEqual([S2, S1, P1, S3, P2]);
  });

  it('generated shots taken out of the movie are not in the chain', () => {
    const out = storyOrder(movie().filter((n) => n.shotId !== S2), shots.map((s) => (s.id === S2 ? { ...s } : s)));
    expect(out.map((e) => e.shotId)).not.toContain(S2);
  });
});

const characters = [
  { id: ROBOT, name: 'Bolt', description: 'A small blue robot with round eyes' },
  { id: DOG, name: 'Pepper', description: 'A playful spotted dog' },
];
const shot = (id: string, number: number, generated: boolean, sceneId = SC1): QuickShot => ({ id, sceneId, number, generated, durationSec: 5, characterIds: [ROBOT], description: 'Bolt cooks soup' });
const at = (s: QuickShot, extra: Partial<DirectorQuickContext> = {}): DirectorQuickContext => ({ scope: { kind: 'shot', shotId: s.id }, shot: s, characters, ...extra });

describe('quick director (EN / KA / RU)', () => {
  it('finds characters by name or by what they are', () => {
    expect(charactersIn('Make the robot jump', characters)).toEqual([ROBOT]);
    expect(charactersIn('Pepper barks at Bolt', characters)).toEqual([ROBOT, DOG]);
    expect(charactersIn('a sunset over the sea', characters)).toEqual([]);
  });

  it('adds a close-up after the shot, with the right cast and framing', () => {
    const r = quickDirect('Add a close-up showing the robot looking surprised', at(shot(S1, 1, true)))!;
    expect(r.ops).toHaveLength(1);
    const op = directorOpSchema.parse(r.ops[0]);
    expect(op).toMatchObject({ op: 'shot.insert', sceneId: SC1, afterShotId: S1, shot: { description: 'Close-up showing the robot looking surprised', camera: 'close_up', shotType: 'close-up', characterIds: [ROBOT], durationSec: 4 } });
  });

  it('inserts between two shots from the connection, in Georgian and Russian too', () => {
    const edge: DirectorQuickContext = { scope: { kind: 'edge', fromShotId: S2, toShotId: S3 }, prev: shot(S2, 2, true), next: shot(S3, 3, true, SC2), characters };
    const ka = quickDirect('დაამატე ახლო ხედი, როგორ ეღიმება რობოტს', edge)!;
    expect(ka.ops[0]).toMatchObject({ op: 'shot.insert', sceneId: SC1, afterShotId: S2, shot: { camera: 'close_up' } });
    expect(ka.reply).toMatch(/უფასო/);
    // "between these" is about where, not what: it is not part of the description.
    expect(quickDirect('Add a close-up between these showing the robot surprised', edge)!.ops[0]).toMatchObject({ shot: { description: 'Close-up showing the robot surprised' } });
    expect(quickDirect('Add a shot after items fall', edge)!.ops[0]).toMatchObject({ shot: { description: 'Shot after items fall' } });
    const ru = quickDirect('Добавь крупный план: Pepper смеётся', edge)!;
    expect(ru.ops[0]).toMatchObject({ op: 'shot.insert', afterShotId: S2, shot: { characterIds: [DOG] } });
  });

  it('several shots or questions go to the AI Director', () => {
    expect(quickDirect('Add two shots showing the environment', { scope: { kind: 'scene', sceneId: SC1 }, sceneLastShotId: S2, characters })).toBeNull();
    expect(quickDirect('Can you add a shot here?', at(shot(S1, 1, true)))).toBeNull();
    expect(quickDirect('Make the character smile', at(shot(S1, 1, true)))).toBeNull();
  });

  it('camera: a planned shot gets the generation preset, footage gets a free digital move', () => {
    expect(quickDirect('Make the camera slowly zoom in', at(shot(P1, 0, false)))!.ops).toEqual([{ op: 'shot.update', shotId: P1, patch: { camera: 'dolly_in' } }]);
    expect(quickDirect('Make the camera slowly zoom in', at(shot(S2, 2, true)))!.ops).toEqual([{ op: 'timeline', plan: { op: 'camera', shot: 2, preset: 'push_in', intensity: 0.35 } }]);
    // An orbit cannot be faked on finished footage: re-plan and regenerate (paid).
    const orbit = quickDirect('orbit around the robot', at(shot(S2, 2, true)))!;
    expect(orbit.ops.map((o) => o.op)).toEqual(['shot.update', 'shot.generate']);
    expect(quickDirect('კამერა ნელა მიუახლოვდეს', at(shot(P1, 0, false)))!.ops[0]).toMatchObject({ patch: { camera: 'dolly_in' } });
  });

  it('length: plan for planned shots, a free trim for footage, regeneration to make footage longer', () => {
    expect(quickDirect('make it 3 seconds', at(shot(P1, 0, false)))!.ops).toEqual([{ op: 'shot.update', shotId: P1, patch: { durationSec: 3 } }]);
    expect(quickDirect('make it shorter', at(shot(S1, 1, true)))!.ops).toEqual([{ op: 'timeline', plan: { op: 'trim', shot: 1, durationSec: 3 } }]);
    expect(quickDirect('сделай длиннее', at(shot(S1, 1, true)))!.ops.map((o) => o.op)).toEqual(['shot.update', 'shot.generate']);
  });

  it('dialogue, removal, generation and continuation', () => {
    expect(quickDirect('Pepper says “Let me taste it!”', at(shot(P1, 0, false)))!.ops[0]).toEqual({ op: 'shot.update', shotId: P1, patch: { dialogue: [{ speaker: 'Pepper', line: 'Let me taste it!', characterId: DOG }] } });
    expect(quickDirect('delete this shot', at(shot(S1, 1, true)))!.ops).toEqual([{ op: 'shot.remove', shotId: S1 }]);
    expect(quickDirect('Generate this shot', at(shot(P1, 0, false)))!.ops).toEqual([{ op: 'shot.generate', shotIds: [P1] }]);
    const cont = quickDirect('Generate a continuation', at(shot(S1, 1, true)))!;
    expect(cont.ops[0]).toMatchObject({ op: 'shot.insert', afterShotId: S1, shot: { continueFrom: S1, characterIds: [ROBOT], description: 'Continues: Bolt cooks soup' } });
    expect(cont.ops[1]).toEqual({ op: 'shot.generate', shotIds: ['new1'] });
  });

  it('a connection between finished shots: transition or colour match (free)', () => {
    const edge: DirectorQuickContext = { scope: { kind: 'edge', fromShotId: S1, toShotId: S2 }, prev: shot(S1, 1, true), next: shot(S2, 2, true), characters };
    expect(quickDirect('add a dissolve', edge)!.ops).toEqual([{ op: 'timeline', plan: { op: 'transition', shot: 1, type: 'dissolve', durationSec: 0.6 } }]);
    expect(quickDirect('match the lighting', edge)!.ops).toEqual([{ op: 'timeline', plan: { op: 'match_color', shot: 2, fromShot: 1 } }]);
  });
});

describe('cartoons', () => {
  it('the creation hub recognises a cartoon (also for a brand) in EN / KA / RU', async () => {
    const { guessIntent } = await import('./index');
    expect(guessIntent('Create a funny 60-second cartoon about a small robot who wants to become a chef')).toMatchObject({ flow: 'cartoon', durationSec: 60, aspect: '16:9' });
    expect(guessIntent('ანიმაციური რეკლამა ჩვენი საცხობის მასკოტით')?.flow).toBe('cartoon');
    expect(guessIntent('мультфильм про собаку')?.flow).toBe('cartoon');
    expect(guessIntent('A 20-second ad for my candles')?.flow).toBe('ad');
  });

  it('original styles only: protected characters are recognised, stills follow the style', async () => {
    const { cartoonIdea, protectedCharacterIn, stillLook, composePrompt } = await import('./index');
    expect(protectedCharacterIn('Pikachu bakes a cake')).toBe('Pikachu');
    expect(protectedCharacterIn('A small blue robot bakes a cake')).toBeNull();
    expect(stillLook('cartoon_clay')).toBe('clay stop-motion photograph');
    expect(stillLook('cinematic')).toBe('photorealistic cinematic');
    const idea = cartoonIdea({ idea: 'A robot learns to cook', style: 'cartoon_2d', audience: 'kids', voices: 'narration' }, [{ name: 'Bolt', description: 'a small blue robot' }]);
    expect(idea).toContain('traditional 2D hand-drawn animation');
    expect(idea).toContain('A narrator tells the story');
    expect(idea).toContain('Bolt — a small blue robot');
    // The style reaches every generation prompt like the other style presets.
    expect(composePrompt('A robot stirs soup', { style: 'cartoon_kids' })).toContain("children's educational cartoon");
  });
});
