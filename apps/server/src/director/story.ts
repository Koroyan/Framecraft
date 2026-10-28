import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  CAMERA_KEYS,
  CAMERA_PRESETS,
  CARTOON_STYLES,
  describeDirectorOp,
  directorOpSchema,
  directorScopeSchema,
  isPaidDirectorOp,
  STYLE_PRESETS,
  sequenceOf,
  timelineSchema,
  type DirectorEstimate,
  type DirectorItem,
  type DirectorOp,
  type DirectorReply,
  type DirectorRequest,
  type DirectorScope,
  type SequenceNode,
  type Timeline,
} from '@framecraft/shared';
import type { AppContext } from '../context';
import { assets, characters, locations, projectVersions, scenes, shots, shotVersions } from '../db/schema';
import { AppError, badRequest, configurationRequired, notFound } from '../lib/errors';
import type { SessionLike } from '../generation/service';
import { ownedProject } from '../editing/versions';
import { aiEditRequestSchema, createAiEdit, estimateAiEdit } from '../editing/ai-edit';
import { grabFrame } from '../editing/comments';
import { estimateImage } from '../images/images';
import { estimateShotRegeneration, regenerateShot, storyboardShots } from '../movie/movie';

/*
 * The AI Director inside the story graph and storyboard. It reads the whole story (scenes, shots,
 * cast, places, the movie as it plays) and turns a request into explicit operations within the
 * scope the user picked: one shot, one scene, the gap between two shots, or the whole project.
 * It never applies anything itself — free operations are applied by `applyDirectorOps` when the
 * user says so (and can be undone); paid ones run through `runDirectorOp` only with an approved price.
 */

type ShotRow = typeof shots.$inferSelect;
type SceneRow = typeof scenes.$inferSelect;
type CharacterRow = typeof characters.$inferSelect;

type Story = Awaited<ReturnType<typeof loadStory>>;

async function loadStory(ctx: AppContext, user: SessionLike, projectId: string, timelineInput?: unknown) {
  const project = await ownedProject(ctx, user, projectId);
  const sceneRows = await ctx.db.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(asc(scenes.index));
  const shotRows = await ctx.db.select().from(shots).where(eq(shots.projectId, projectId));
  const sceneIndex = new Map(sceneRows.map((s, i) => [s.id, i]));
  const ordered = [...shotRows].sort((a, b) => (sceneIndex.get(a.sceneId) ?? 0) - (sceneIndex.get(b.sceneId) ?? 0) || a.index - b.index);
  const versionRows = await ctx.db.select({ shotId: shotVersions.shotId, id: shotVersions.id }).from(shotVersions).where(eq(shotVersions.projectId, projectId));
  const generated = new Set([...versionRows.map((v) => v.shotId), ...shotRows.filter((s) => s.currentAssetId).map((s) => s.id)]);
  const cast = [...new Set(shotRows.flatMap((s) => s.characterIds))];
  const charRows = await ctx.db
    .select()
    .from(characters)
    .where(and(eq(characters.userId, project.userId), cast.length ? or(eq(characters.projectId, projectId), inArray(characters.id, cast)) : eq(characters.projectId, projectId)));
  const locRows = await ctx.db.select().from(locations).where(eq(locations.projectId, projectId));
  let timeline: Timeline | null = null;
  if (timelineInput) timeline = timelineSchema.parse(timelineInput);
  else {
    const [latest] = await ctx.db.select().from(projectVersions).where(eq(projectVersions.projectId, projectId)).orderBy(desc(projectVersions.version)).limit(1);
    if (latest) timeline = timelineSchema.parse(latest.timeline);
  }
  const seq: SequenceNode[] = timeline ? sequenceOf(timeline) : [];
  return { project, scenes: sceneRows, shots: ordered, generated, characters: charRows, locations: locRows, timeline, seq };
}

const shotLabel = (story: Story, id: string) => {
  const i = story.shots.findIndex((s) => s.id === id);
  if (i < 0) return id.startsWith('new') ? `the new shot (${id})` : 'a shot';
  const s = story.shots[i]!;
  const scene = story.scenes.findIndex((x) => x.id === s.sceneId) + 1;
  return `Scene ${scene} · shot ${s.index + 1}`;
};
const namesFor = (story: Story) => ({
  movieShot: (n: number) => {
    const node = story.seq[n - 1];
    return node?.shotId ? shotLabel(story, node.shotId) : `clip ${n}`;
  },
  shot: (id: string) => shotLabel(story, id),
  scene: (id: string) => {
    const i = story.scenes.findIndex((x) => x.id === id);
    return i < 0 ? 'a new scene' : `Scene ${i + 1} (${story.scenes[i]!.title})`;
  },
  character: (id: string) => story.characters.find((c) => c.id === id)?.name ?? 'someone',
});

// ------------------------------------------------------------------ prompt engineering (deterministic)

const lookStyle = (style?: string) => CARTOON_STYLES.find((s) => s.key === style)?.prompt ?? STYLE_PRESETS.find((s) => s.key === style)?.prompt ?? '';
const characterLine = (c: CharacterRow) => {
  const look = Object.values(c.appearance ?? {}).filter(Boolean).join(', ');
  return `${c.name}: ${[c.description, look].filter(Boolean).join('; ')}${c.clothing ? `; wearing ${c.clothing}` : ''}`;
};

/**
 * A complete, self-contained generation prompt for a new shot, written from its description, its
 * cast (appearance repeated word for word, as the screenplay does), the scene's place and the
 * film's style — so a short request like "close-up of the robot, surprised" generates consistently.
 */
export function composeShotPrompt(p: { description: string; shotType?: string | null; camera?: string | null; cast: CharacterRow[]; place?: { name: string; description: string } | null; style?: string; previous?: string | null }) {
  const framing = [p.shotType ? `${p.shotType} shot` : '', CAMERA_PRESETS.find((c) => c.key === p.camera)?.prompt ?? ''].filter(Boolean).join(', ');
  return [
    p.description.trim().replace(/\.?$/, '.'),
    framing && `${framing.charAt(0).toUpperCase()}${framing.slice(1)}.`,
    p.cast.length ? `Characters — ${p.cast.map(characterLine).join(' | ')}.` : '',
    p.place ? `Setting: ${p.place.name} — ${p.place.description}.` : '',
    p.previous ? `Continuity: same characters, place, light and colour as the previous shot (${p.previous.slice(0, 160)}).` : '',
    lookStyle(p.style) && `Look: ${lookStyle(p.style)}.`,
    'No on-screen text.',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 3900);
}

// ------------------------------------------------------------------ scope

function sceneOf(story: Story, shotId: string) {
  return story.shots.find((s) => s.id === shotId)?.sceneId;
}

/** Why an operation is outside the user's scope (null = allowed). Unknown ids are rejected earlier. */
function outOfScope(story: Story, scope: DirectorScope, op: DirectorOp, refs: Set<string>): string | null {
  if (scope.kind === 'project') return null;
  const isRef = (id: string | null | undefined) => Boolean(id && refs.has(id));
  const scopeShot = scope.kind === 'shot' ? story.shots.find((s) => s.id === scope.shotId) : undefined;
  const sceneId = scope.kind === 'scene' ? scope.sceneId : scopeShot?.sceneId;
  const inScope = (id: string) => {
    if (isRef(id)) return true;
    if (scope.kind === 'shot') return id === scope.shotId;
    if (scope.kind === 'scene') return sceneOf(story, id) === scope.sceneId;
    return false; // edge: only the new shots it creates
  };
  const tooWide = scope.kind === 'shot' ? 'Outside this shot — ask on the scene or the whole project to allow it.' : scope.kind === 'scene' ? 'Outside this scene — ask on the whole project to allow it.' : 'Outside this connection — ask on a shot or the whole project.';
  switch (op.op) {
    case 'shot.update':
    case 'shot.remove':
    case 'shot.move':
    case 'shot.ai_edit':
      return inScope(op.shotId) ? null : tooWide;
    case 'storyboard.generate':
    case 'shot.generate':
      return op.shotIds.every(inScope) ? null : tooWide;
    case 'shot.insert': {
      if (scope.kind === 'edge') {
        const ok = scope.fromShotId ? op.afterShotId === scope.fromShotId || isRef(op.afterShotId) : op.afterShotId === null && op.sceneId === (scope.toShotId ? sceneOf(story, scope.toShotId) : undefined);
        return ok ? null : 'A new shot here must go between the two connected shots.';
      }
      if (op.sceneId !== sceneId) return tooWide;
      if (scope.kind === 'shot') {
        const inScene = story.shots.filter((s) => s.sceneId === sceneId);
        const before = inScene[inScene.findIndex((s) => s.id === scope.shotId) - 1];
        return op.afterShotId === scope.shotId || isRef(op.afterShotId) || op.afterShotId === (before?.id ?? null) ? null : 'New shots from here go right before or after this shot.';
      }
      return null;
    }
    case 'scene.update':
      return scope.kind === 'scene' && op.sceneId === scope.sceneId ? null : tooWide;
    case 'character.update':
      return 'This changes the character in every shot they appear in — ask on the whole project, or change only this shot.';
    case 'timeline': {
      const p = op.plan;
      if (!('shot' in p)) return tooWide;
      const node = story.seq[p.shot - 1];
      if (!node?.shotId) return tooWide;
      if (scope.kind === 'edge') return node.shotId === scope.fromShotId || node.shotId === scope.toShotId ? null : tooWide;
      return inScope(node.shotId) ? null : tooWide;
    }
  }
}

/** Every id an operation names must belong to this project (refs must be created earlier in the plan). */
function idsKnown(story: Story, op: DirectorOp, refs: Set<string>): boolean {
  const shot = (id: string | null) => id === null || refs.has(id) || story.shots.some((s) => s.id === id);
  const scene = (id: string) => story.scenes.some((s) => s.id === id);
  const castOk = (ids: string[]) => ids.every((id) => story.characters.some((c) => c.id === id));
  switch (op.op) {
    case 'shot.update':
      return shot(op.shotId) && castOk(op.patch.characterIds ?? []);
    case 'shot.insert':
      return scene(op.sceneId) && shot(op.afterShotId) && castOk(op.shot.characterIds) && (!op.shot.continueFrom || shot(op.shot.continueFrom));
    case 'shot.remove':
    case 'shot.ai_edit':
      return shot(op.shotId);
    case 'shot.move':
      return shot(op.shotId) && scene(op.sceneId) && shot(op.afterShotId);
    case 'scene.update':
      return scene(op.sceneId);
    case 'character.update':
      return story.characters.some((c) => c.id === op.characterId);
    case 'storyboard.generate':
    case 'shot.generate':
      return op.shotIds.every(shot);
    case 'timeline':
      return !('shot' in op.plan) || Boolean(story.seq[op.plan.shot - 1]);
  }
}

// ------------------------------------------------------------------ prices

/** Price of one paid operation (free to ask). Shots that do not exist yet are priced after they are added. */
export async function estimateDirectorOp(ctx: AppContext, user: SessionLike, story: Story, op: DirectorOp): Promise<{ estimate: DirectorEstimate | null; blocked?: string }> {
  if (op.op === 'storyboard.generate') {
    const img = await estimateImage(ctx, true);
    if (!img.available) return { estimate: null, blocked: 'Storyboard frames need live image generation, which is not set up on this server.' };
    const n = op.shotIds.length;
    return { estimate: { credits: img.credits * n, model: img.modelKey, notes: [`${n} still image${n === 1 ? '' : 's'} — a storyboard, not video.`] } };
  }
  if (op.op === 'shot.generate') {
    if (op.shotIds.some((id) => id.startsWith('new'))) return { estimate: null };
    let credits = 0;
    for (const id of op.shotIds) credits += await estimateShotRegeneration(ctx, user, id);
    return { estimate: { credits, notes: [`${op.shotIds.length} shot${op.shotIds.length === 1 ? '' : 's'} generated with the model the Director picks for each (shown in the shot editor).`] } };
  }
  if (op.op === 'shot.ai_edit') {
    const shot = story.shots.find((s) => s.id === op.shotId);
    if (!shot || !story.generated.has(shot.id)) return { estimate: null, blocked: 'This shot has no video yet — generate it first.' };
    try {
      const e = await estimateAiEdit(ctx, user, { shotId: op.shotId, mode: op.mode, instruction: op.instruction, startSec: op.startSec ?? 0, endSec: op.endSec ?? shot.durationSec, mask: null, referenceAssetIds: [] });
      if (!e.available && !e.fixture) return { estimate: null, blocked: 'AI video editing is not set up on this server.' };
      return { estimate: { credits: e.credits, model: e.model, notes: e.notes.filter(Boolean) } };
    } catch (err) {
      return { estimate: null, blocked: (err as Error).message };
    }
  }
  return { estimate: null };
}

// ------------------------------------------------------------------ planning

const OP_NAMES = ['shot.update', 'shot.insert', 'shot.remove', 'shot.move', 'scene.update', 'character.update', 'storyboard.generate', 'shot.generate', 'shot.ai_edit', 'timeline'] as const;

// Flat shape for the model (every field optional); each operation is validated after.
const modelOpSchema = z.object({
  op: z.enum(OP_NAMES),
  ref: z.string().optional(),
  shotId: z.string().optional(),
  shotIds: z.array(z.string()).optional(),
  sceneId: z.string().optional(),
  afterShotId: z.string().nullable().optional(),
  characterId: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  durationSec: z.number().optional(),
  camera: z.string().optional(),
  shotType: z.string().optional(),
  characterIds: z.array(z.string()).optional(),
  dialogue: z.array(z.object({ speaker: z.string(), line: z.string() })).optional(),
  continueFrom: z.string().optional(),
  title: z.string().optional(),
  synopsis: z.string().optional(),
  clothing: z.string().optional(),
  appearance: z.string().optional(),
  mode: z.string().optional(),
  instruction: z.string().optional(),
  startSec: z.number().optional(),
  endSec: z.number().optional(),
  timeline: z.record(z.string(), z.unknown()).optional(),
  why: z.string().optional(),
});
type ModelOp = z.infer<typeof modelOpSchema>;
const replySchema = z.object({ reply: z.string(), operations: z.array(modelOpSchema).max(16) });

const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

function fromModel(m: ModelOp): unknown {
  const camera = m.camera && (CAMERA_KEYS as string[]).includes(m.camera) ? m.camera : undefined;
  const durationSec = m.durationSec !== undefined ? Math.min(30, Math.max(2, Math.round(m.durationSec))) : undefined;
  switch (m.op) {
    case 'shot.update':
      return { op: m.op, shotId: m.shotId, patch: clean({ description: m.description, prompt: m.prompt, durationSec, camera, shotType: m.shotType, characterIds: m.characterIds, dialogue: m.dialogue }) };
    case 'shot.insert':
      return { op: m.op, ref: m.ref ?? 'new1', sceneId: m.sceneId, afterShotId: m.afterShotId ?? null, shot: clean({ description: m.description, prompt: m.prompt ?? '', durationSec: durationSec ?? 5, camera, shotType: m.shotType, characterIds: m.characterIds ?? [], dialogue: m.dialogue ?? [], continueFrom: m.continueFrom }) };
    case 'shot.remove':
      return { op: m.op, shotId: m.shotId };
    case 'shot.move':
      return { op: m.op, shotId: m.shotId, sceneId: m.sceneId, afterShotId: m.afterShotId ?? null };
    case 'scene.update':
      return clean({ op: m.op, sceneId: m.sceneId, title: m.title, synopsis: m.synopsis });
    case 'character.update':
      return { op: m.op, characterId: m.characterId, patch: clean({ description: m.description, clothing: m.clothing, appearance: m.appearance ? { distinguishing: m.appearance } : undefined }) };
    case 'storyboard.generate':
    case 'shot.generate':
      return { op: m.op, shotIds: m.shotIds ?? (m.shotId ? [m.shotId] : []) };
    case 'shot.ai_edit':
      return clean({ op: m.op, shotId: m.shotId, mode: m.mode, instruction: m.instruction, startSec: m.startSec, endSec: m.endSec });
    case 'timeline':
      return { op: m.op, plan: m.timeline };
  }
}

const SYSTEM = `You are the AI Director inside Framecraft, an AI filmmaking studio. The user is looking at their story as a graph/storyboard of scenes and shots and asks you for a change. Turn it into a short explicit plan of operations. Nothing runs until the user approves it.
Operations (use the exact ids from Context; never invent ids):
- shot.update{shotId, description?, prompt?, durationSec 2–30?, camera?, shotType?, characterIds?, dialogue?[{speaker,line}]} — edits a shot's plan (free). For a shot that already has video this only changes the plan; add shot.generate or shot.ai_edit if the picture itself must change.
- shot.insert{ref "new1"/"new2"…, sceneId, afterShotId (null = first in the scene), description, prompt?, durationSec, camera?, shotType?, characterIds, dialogue?, continueFrom? (a generated shot's id: the new shot starts from its last frame)} — a new planned shot (free). Reuse the cast's ids so their approved look carries over.
- shot.remove{shotId} — planned shots are deleted, generated ones only leave the movie (free).
- shot.move{shotId, sceneId, afterShotId} — reorder (free).
- scene.update{sceneId, title?, synopsis?} (free). character.update{characterId, description?, clothing?, appearance?} (free, but it changes the character everywhere — only when the user asks for the character itself to change).
- storyboard.generate{shotIds} — paid still frames (a cheap draft). shot.generate{shotIds} — paid video generation. shot.ai_edit{shotId, mode: fix|replace|remove|add|restyle|relight|background|motion|enhance|reframe|camera_remix, instruction (English, precise, say what must stay unchanged), startSec?, endSec?} — paid change of a generated shot's pixels, only that shot.
- timeline{timeline:{op:"transition",shot,type:cut|fade|dissolve|wipeleft|wiperight|slideup|circleopen|fadeblack,durationSec} | {op:"match_color",shot,fromShot} | {op:"camera",shot,preset:static|push_in|pull_out|pan_left|pan_right|tilt_up|tilt_down|dolly|zoom_to|handheld|tracking,intensity} | {op:"trim",shot,durationSec} | {op:"speed",shot,speed}} — free edits of finished footage; "shot" is the movie number (#) in Context.
Camera presets for planned shots: ${CAMERA_KEYS.join(', ')}.
Rules: stay inside the Scope given in Context — never touch other shots, scenes or characters unless the scope is the whole project. Prefer free operations; use paid ones only when new pixels are needed. For planned shots, write prompts that are self-contained for a video model (characters' appearance and clothing, place, light, camera, action; no on-screen text). Keep characters consistent: reuse their ids and descriptions. Do not depict real public figures or existing trademarked characters.
Reply in the user's language in 1–3 sentences saying what the plan does and what stays unchanged. If the request is unclear, ask one short question and return no operations.`;

function contextFor(story: Story, input: DirectorRequest): string {
  const movieNo = new Map(story.seq.flatMap((n, i) => (n.shotId ? [[n.shotId, i + 1] as const] : [])));
  const lines: string[] = [`Project: "${story.project.title}" (${story.project.aspectRatio}, ${story.project.kind}). Style: ${(story.project.settings as { brief?: { style?: string } }).brief?.style ?? 'not set'}.`];
  lines.push('Cast:', ...(story.characters.length ? story.characters.map((c) => `- ${c.id} ${characterLine(c)}`) : ['- (none yet)']));
  for (const [i, sc] of story.scenes.entries()) {
    const place = story.locations.find((l) => l.id === sc.locationId);
    lines.push(`Scene ${i + 1} id ${sc.id}: "${sc.title}"${place ? ` at ${place.name}` : ''} — ${sc.synopsis.slice(0, 200)}`);
    for (const s of story.shots.filter((x) => x.sceneId === sc.id)) {
      const cast = s.characterIds.map((id) => story.characters.find((c) => c.id === id)?.name).filter(Boolean).join(', ');
      lines.push(
        `  - shot ${s.id} (scene ${i + 1} · shot ${s.index + 1}${movieNo.has(s.id) ? `, movie #${movieNo.get(s.id)}` : ''}) ${s.durationSec}s, ${story.generated.has(s.id) ? 'has video' : 'planned (no video yet)'}${s.camera ? `, camera ${s.camera}` : ''}${cast ? `, cast: ${cast}` : ''}: ${s.description.slice(0, 160)}${s.dialogue.length ? ` | lines: ${s.dialogue.map((d) => `${d.speaker}: "${d.line.slice(0, 80)}"`).join(' / ')}` : ''}`,
      );
    }
  }
  const sc = input.scope;
  lines.push(
    sc.kind === 'project'
      ? 'Scope: the whole project.'
      : sc.kind === 'scene'
        ? `Scope: ONLY scene id ${sc.sceneId} and its shots.`
        : sc.kind === 'shot'
          ? `Scope: ONLY shot id ${sc.shotId}${sc.startSec !== undefined ? `, from ${sc.startSec.toFixed(1)} s to ${(sc.endSec ?? sc.startSec + 1).toFixed(1)} s of it` : ''}. New shots may go right before or after it.`
          : `Scope: ONLY the connection between shot ${sc.fromShotId ?? 'FILM START'} and shot ${sc.toShotId ?? 'the end'} — new shots go between them (afterShotId = ${sc.fromShotId ?? 'null'}), transitions/colour matches between those two.`,
  );
  if (input.history.length) lines.push('Conversation so far:', ...input.history.map((h) => `${h.role}: ${h.text}`));
  lines.push(`User: ${input.message}`);
  return lines.join('\n');
}

/** Without the AI service: turn the request into the one direct edit it most likely means, and say so. */
function offlinePlan(story: Story, input: DirectorRequest): { reply: string; operations: ModelOp[] } {
  const ka = /[Ⴀ-ჿ]/.test(input.message);
  const ru = /[Ѐ-ӿ]/.test(input.message);
  const say = (en: string, k: string, r: string) => (ka ? k : ru ? r : en);
  const sc = input.scope;
  if (sc.kind !== 'shot') {
    return { reply: say('The AI Director service is not configured on this server, so I can only handle simple requests here (add a shot, camera, length, a line, a transition). Ask on a single shot, or edit the cards directly.', 'AI Director-ის სერვისი ამ სერვერზე არ არის ჩართული, ამიტომ აქ მხოლოდ მარტივ თხოვნებს ვასრულებ (კადრის დამატება, კამერა, ხანგრძლივობა, რეპლიკა, გადასვლა). მთხოვე ცალკე კადრზე ან შეცვალე ბარათები პირდაპირ.', 'Сервис AI Director на этом сервере не настроен, поэтому здесь я выполняю только простые запросы (добавить кадр, камера, длина, реплика, переход). Спросите на отдельном кадре или измените карточки напрямую.'), operations: [] };
  }
  const shot = story.shots.find((s) => s.id === sc.shotId);
  if (!shot) return { reply: 'Shot not found.', operations: [] };
  const t = input.message.toLowerCase();
  if (story.generated.has(shot.id)) {
    const mode = /(background|ფონ|фон)/.test(t) ? 'background' : /(light|lighting|განათ|свет)/.test(t) ? 'relight' : /(remove|erase|delete|წაშალე|მოაშორე|убери|удали)/.test(t) ? 'remove' : /(fix|hand|finger|face|glitch|გაასწორ|ხელ|исправ|рук)/.test(t) ? 'fix' : /(wave|jump|run|walk|smile|laugh|dance|nod|ხტ|იცინ|გაიღიმ|დაუქნი|прыг|улыб|смеё|бег|маш)/.test(t) ? 'motion' : /(add|დაამატე|добав)/.test(t) ? 'add' : 'restyle';
    return {
      reply: say('The AI Director service is not configured, so I turned your words directly into an AI edit of this shot only. Check the instruction and the price before approving.', 'AI Director-ის სერვისი არ არის ჩართული, ამიტომ შენი სიტყვები პირდაპირ ამ კადრის AI რედაქტირებად ვაქციე (მხოლოდ ეს კადრი). დადასტურებამდე შეამოწმე ინსტრუქცია და ფასი.', 'Сервис AI Director не настроен, поэтому я превратил ваши слова прямо в AI-правку только этого кадра. Проверьте инструкцию и цену перед подтверждением.'),
      operations: [{ op: 'shot.ai_edit', shotId: shot.id, mode, instruction: `${input.message.trim()} Keep everything else in the shot unchanged.`.slice(0, 900), startSec: sc.startSec, endSec: sc.endSec }],
    };
  }
  return {
    reply: say('The AI Director service is not configured, so I added your request to this planned shot’s prompt. It takes effect when the shot is generated.', 'AI Director-ის სერვისი არ არის ჩართული, ამიტომ შენი თხოვნა ამ დაგეგმილი კადრის prompt-ს დავუმატე. გენერაციისას გაითვალისწინებს.', 'Сервис AI Director не настроен, поэтому я добавил ваш запрос в промпт этого запланированного кадра. Он учтётся при генерации.'),
    operations: [{ op: 'shot.update', shotId: shot.id, prompt: `${shot.prompt} Revision: ${input.message.trim()}`.slice(0, 3900) }],
  };
}

export async function directorPlan(ctx: AppContext, user: SessionLike, projectId: string, input: DirectorRequest): Promise<DirectorReply> {
  const story = await loadStory(ctx, user, projectId, input.timeline);
  checkScopeIds(story, input.scope);
  const res = await ctx.director.converse({ system: SYSTEM, prompt: contextFor(story, input), schema: replySchema, tier: 'smart', maxTokens: 4000 }, () => offlinePlan(story, input));
  const items: DirectorItem[] = [];
  const refs = new Set<string>();
  const names = namesFor(story);
  for (const raw of res.operations) {
    const parsed = directorOpSchema.safeParse(fromModel(raw));
    if (!parsed.success) continue;
    const op = parsed.data;
    if (!idsKnown(story, op, refs)) continue;
    if (op.op === 'shot.insert') refs.add(op.ref);
    const paid = isPaidDirectorOp(op);
    const summary = describeDirectorOp(op, names);
    const blocked = outOfScope(story, input.scope, op, refs) ?? (op.op === 'timeline' && !story.timeline ? 'The movie has no footage yet.' : null);
    if (blocked) {
      items.push({ op, paid, summary, blocked });
      continue;
    }
    const price = paid ? await estimateDirectorOp(ctx, user, story, op) : { estimate: null };
    items.push({ op, paid, summary, estimate: price.estimate, ...(price.blocked ? { blocked: price.blocked } : {}) });
  }
  return { reply: res.reply, items, offline: res.source === 'offline' };
}

function checkScopeIds(story: Story, scope: DirectorScope) {
  const shot = (id: string | null) => id === null || story.shots.some((s) => s.id === id);
  if (scope.kind === 'scene' && !story.scenes.some((s) => s.id === scope.sceneId)) throw notFound('Scene');
  if (scope.kind === 'shot' && !shot(scope.shotId)) throw notFound('Shot');
  if (scope.kind === 'edge' && (!shot(scope.fromShotId) || !shot(scope.toShotId))) throw notFound('Shot');
}

// ------------------------------------------------------------------ applying free operations

export const applyRequestSchema = z.object({ ops: z.array(directorOpSchema).min(1).max(30), scope: directorScopeSchema.default({ kind: 'project' }) });

/**
 * Apply free story operations in one transaction. Returns the ids of new shots (by ref), the
 * operations that undo it, and generated shots that should leave the movie (the editor takes them
 * off the timeline; their takes stay in the project).
 */
export async function applyDirectorOps(ctx: AppContext, user: SessionLike, projectId: string, input: z.infer<typeof applyRequestSchema>) {
  const story = await loadStory(ctx, user, projectId);
  checkScopeIds(story, input.scope);
  const refs = new Set<string>();
  for (const op of input.ops) {
    if (isPaidDirectorOp(op)) throw badRequest('Paid steps run only after you approve their price.');
    if (op.op === 'timeline') throw badRequest('Timeline edits are applied in the editor.');
    if (!idsKnown(story, op, refs)) throw notFound('Shot, scene or character');
    if (op.op === 'shot.insert') refs.add(op.ref);
    const why = outOfScope(story, input.scope, op, refs);
    if (why) throw badRequest(why);
  }
  const brief = (story.project.settings as { brief?: { style?: string } }).brief;
  const created: Record<string, string> = {};
  const undo: DirectorOp[] = [];
  const leaveMovie: string[] = [];
  const continueFrames: { shotId: string; fromShotId: string }[] = [];
  const resolve = (id: string) => created[id] ?? id;

  await ctx.db.transaction(async (tx) => {
    const sceneShots = async (sceneId: string) => tx.select().from(shots).where(eq(shots.sceneId, sceneId)).orderBy(asc(shots.index));
    const writeOrder = async (list: ShotRow[], sceneId: string) => {
      for (const [i, s] of list.entries()) if (s.index !== i || s.sceneId !== sceneId) await tx.update(shots).set({ index: i, sceneId, updatedAt: new Date() }).where(eq(shots.id, s.id));
    };
    const one = async (id: string) => {
      const [s] = await tx.select().from(shots).where(and(eq(shots.id, id), eq(shots.projectId, projectId)));
      if (!s) throw notFound('Shot');
      return s;
    };
    for (const op of input.ops) {
      switch (op.op) {
        case 'shot.insert': {
          const after = op.afterShotId ? await one(resolve(op.afterShotId)) : null;
          const sceneId = after?.sceneId ?? op.sceneId;
          const at = after ? after.index + 1 : 0;
          await tx.update(shots).set({ index: sql`${shots.index} + 1` }).where(and(eq(shots.sceneId, sceneId), gte(shots.index, at)));
          const scene = story.scenes.find((s) => s.id === sceneId) as SceneRow | undefined;
          const place = scene?.locationId ? story.locations.find((l) => l.id === scene.locationId) : null;
          const cast = story.characters.filter((c) => op.shot.characterIds.includes(c.id));
          const prompt = op.shot.prompt || composeShotPrompt({ description: op.shot.description, shotType: op.shot.shotType, camera: op.shot.camera, cast, place, style: brief?.style, previous: after?.description });
          const [row] = await tx
            .insert(shots)
            .values({ projectId, sceneId, index: at, description: op.shot.description, prompt, durationSec: op.shot.durationSec, camera: op.shot.camera ?? null, shotType: op.shot.shotType ?? null, characterIds: op.shot.characterIds, dialogue: op.shot.dialogue, status: 'planned' })
            .returning();
          created[op.ref] = row!.id;
          if (op.shot.continueFrom) continueFrames.push({ shotId: row!.id, fromShotId: resolve(op.shot.continueFrom) });
          undo.unshift({ op: 'shot.remove', shotId: row!.id });
          break;
        }
        case 'shot.update': {
          const s = await one(resolve(op.shotId));
          const before = Object.fromEntries(Object.keys(op.patch).map((k) => [k, (s as Record<string, unknown>)[k]]));
          await tx.update(shots).set({ ...op.patch, updatedAt: new Date() }).where(eq(shots.id, s.id));
          undo.unshift({ op: 'shot.update', shotId: s.id, patch: before as never });
          break;
        }
        case 'shot.remove': {
          const s = await one(resolve(op.shotId));
          if (story.generated.has(s.id)) {
            // Generated takes are never deleted here: the shot only leaves the movie.
            leaveMovie.push(s.id);
            break;
          }
          const list = await sceneShots(s.sceneId);
          const prev = list[list.findIndex((x) => x.id === s.id) - 1];
          await tx.delete(shots).where(eq(shots.id, s.id));
          await writeOrder(list.filter((x) => x.id !== s.id), s.sceneId);
          undo.unshift({ op: 'shot.insert', ref: 'new1', sceneId: s.sceneId, afterShotId: prev?.id ?? null, shot: { description: s.description, prompt: s.prompt, durationSec: Math.min(30, Math.max(2, s.durationSec)), camera: (CAMERA_KEYS as string[]).includes(s.camera ?? '') ? (s.camera as never) : undefined, shotType: s.shotType ?? undefined, characterIds: s.characterIds, dialogue: s.dialogue } });
          break;
        }
        case 'shot.move': {
          const s = await one(resolve(op.shotId));
          const after = op.afterShotId ? await one(resolve(op.afterShotId)) : null;
          const target = after?.sceneId ?? op.sceneId;
          const from = await sceneShots(s.sceneId);
          const oldPrev = from[from.findIndex((x) => x.id === s.id) - 1];
          const rest = from.filter((x) => x.id !== s.id);
          if (target !== s.sceneId) await writeOrder(rest, s.sceneId);
          const into = target === s.sceneId ? rest : (await sceneShots(target)).filter((x) => x.id !== s.id);
          const at = after ? into.findIndex((x) => x.id === after.id) + 1 : 0;
          into.splice(at, 0, s);
          await writeOrder(into, target);
          undo.unshift({ op: 'shot.move', shotId: s.id, sceneId: s.sceneId, afterShotId: oldPrev?.id ?? null });
          break;
        }
        case 'scene.update': {
          const sc = story.scenes.find((x) => x.id === op.sceneId)!;
          await tx.update(scenes).set(clean({ title: op.title, synopsis: op.synopsis, updatedAt: new Date() })).where(eq(scenes.id, sc.id));
          undo.unshift(clean({ op: 'scene.update' as const, sceneId: sc.id, title: op.title !== undefined ? sc.title : undefined, synopsis: op.synopsis !== undefined ? sc.synopsis : undefined }) as DirectorOp);
          break;
        }
        case 'character.update': {
          const c = story.characters.find((x) => x.id === op.characterId)!;
          await tx.update(characters).set(clean({ description: op.patch.description, clothing: op.patch.clothing, appearance: op.patch.appearance ? { ...c.appearance, ...op.patch.appearance } : undefined, updatedAt: new Date() })).where(and(eq(characters.id, c.id), eq(characters.userId, user.id)));
          undo.unshift({ op: 'character.update', characterId: c.id, patch: clean({ description: op.patch.description !== undefined ? c.description : undefined, clothing: op.patch.clothing !== undefined ? c.clothing : undefined, appearance: op.patch.appearance ? (c.appearance as Record<string, string>) : undefined }) });
          break;
        }
        default:
          break;
      }
    }
  });

  // "Continue the action": the new shot starts from the last frame of the shot it follows (free, exact).
  for (const f of continueFrames) {
    const src = await ctx.db.select().from(shots).where(eq(shots.id, f.fromShotId));
    const versionId = src[0]?.activeVersionId;
    if (!versionId) continue;
    const [v] = await ctx.db.select().from(shotVersions).where(eq(shotVersions.id, versionId));
    const [media] = v ? await ctx.db.select().from(assets).where(eq(assets.id, v.assetId)) : [];
    if (!v || !media) continue;
    const frame = await grabFrame(ctx, user, versionId, Math.max(0, (media.durationMs ?? 0) / 1000 - 0.08));
    if (media.isFixture) await ctx.db.update(assets).set({ isFixture: true }).where(eq(assets.id, frame.id));
    await ctx.db.update(shots).set({ storyboardAssetId: frame.id, status: 'storyboarded', updatedAt: new Date() }).where(eq(shots.id, f.shotId));
  }
  return { created, undo, leaveMovie };
}

// ------------------------------------------------------------------ paid operations

export const estimateRequestSchema = z.object({ ops: z.array(directorOpSchema).min(1).max(20) });
export const runRequestSchema = z.object({ op: directorOpSchema, approvedCredits: z.number().int().min(0), idempotencyKey: z.string().min(8).max(100) });

export async function estimateDirectorOps(ctx: AppContext, user: SessionLike, projectId: string, ops: DirectorOp[]) {
  const story = await loadStory(ctx, user, projectId);
  const out = [];
  for (const op of ops) {
    if (!isPaidDirectorOp(op)) {
      out.push({ estimate: null });
      continue;
    }
    if (!idsKnown(story, op, new Set())) throw notFound('Shot');
    out.push(await estimateDirectorOp(ctx, user, story, op));
  }
  return { estimates: out };
}

/** Run one paid operation the user approved. The price is checked again; nothing runs above it. */
export async function runDirectorOp(ctx: AppContext, user: SessionLike, projectId: string, input: z.infer<typeof runRequestSchema>) {
  const { op } = input;
  if (!isPaidDirectorOp(op)) throw badRequest('Only paid steps run here; free ones are applied directly.');
  const story = await loadStory(ctx, user, projectId);
  if (!idsKnown(story, op, new Set())) throw notFound('Shot');
  const { estimate, blocked } = await estimateDirectorOp(ctx, user, story, op);
  if (blocked) throw configurationRequired(blocked);
  if (!estimate) throw badRequest('This step has no price yet — add the new shot first.');
  if (input.approvedCredits < estimate.credits) throw new AppError('approval_required', `This needs ${estimate.credits} credits. Please approve that amount to start.`, 409, { estimate });
  if (op.op === 'storyboard.generate') return { jobs: await storyboardShots(ctx, user, projectId, op.shotIds, input.idempotencyKey) };
  if (op.op === 'shot.generate') {
    const jobs = [];
    for (const id of op.shotIds) {
      const r = await regenerateShot(ctx, user, id, `${input.idempotencyKey}:${id}`);
      if (r.job) jobs.push(r.job);
    }
    return { jobs };
  }
  if (op.op === 'shot.ai_edit') {
    const shot = story.shots.find((s) => s.id === op.shotId)!;
    const req = aiEditRequestSchema.parse({ shotId: shot.id, versionId: shot.activeVersionId ?? undefined, mode: op.mode, instruction: op.instruction, startSec: op.startSec ?? 0, endSec: Math.max(0.1, op.endSec ?? shot.durationSec), mask: null, idempotencyKey: input.idempotencyKey });
    const { job } = await createAiEdit(ctx, user, req);
    return { jobs: [job] };
  }
  throw badRequest('Unknown step');
}
