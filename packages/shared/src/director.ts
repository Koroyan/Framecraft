import { z } from 'zod';
import { CAMERA_PRESETS, type CameraKey } from './constants';
import { aiEditModeSchema, planOpSchema, type CameraMove, type PlanOp, type SequenceNode } from './edit';

/*
 * The AI Director's operations on the story itself — scenes, shots and characters — next to the
 * editor's timeline operations. Every operation names the ids it touches; the server checks them
 * against the project and the scope the user chose (one shot, one scene, the gap between two shots,
 * or the whole project) before a plan is shown. Free operations apply together and can be undone;
 * paid ones (storyboard frames, shot generation, AI edits of footage) run only after the user
 * approves their price.
 */

const uuid = z.string().uuid();
/** A shot created earlier in the same plan ("new1"…), or an existing shot. */
export const newRefSchema = z.string().regex(/^new([1-9]|1\d|20)$/);
const shotRef = z.union([uuid, newRefSchema]);

export const CAMERA_KEYS = CAMERA_PRESETS.map((c) => c.key) as [CameraKey, ...CameraKey[]];

const dialogueLineSchema = z.object({ speaker: z.string().trim().min(1).max(60), line: z.string().trim().min(1).max(400), characterId: uuid.optional() });

/** What a planned shot says before it is generated. */
export const shotDraftSchema = z.object({
  description: z.string().trim().min(1).max(500),
  /** Generation prompt; left empty, the server writes it from the description, cast and scene. */
  prompt: z.string().trim().max(4000).default(''),
  durationSec: z.number().int().min(2).max(30).default(5),
  camera: z.enum(CAMERA_KEYS).optional(),
  shotType: z.string().trim().max(40).optional(),
  characterIds: z.array(uuid).max(12).default([]),
  dialogue: z.array(dialogueLineSchema).max(8).default([]),
  /** Start from the last frame of this (generated) shot, so the action continues seamlessly. */
  continueFrom: shotRef.optional(),
});
export type ShotDraft = z.infer<typeof shotDraftSchema>;

const shotPatchSchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    prompt: z.string().trim().min(1).max(4000),
    durationSec: z.number().int().min(2).max(30),
    camera: z.enum(CAMERA_KEYS).nullable(),
    shotType: z.string().trim().max(40).nullable(),
    characterIds: z.array(uuid).max(12),
    dialogue: z.array(dialogueLineSchema).max(8),
    approved: z.boolean(),
  })
  .partial();

export const directorOpSchema = z.discriminatedUnion('op', [
  // Story (free, undoable)
  z.object({ op: z.literal('shot.update'), shotId: shotRef, patch: shotPatchSchema }),
  z.object({ op: z.literal('shot.insert'), ref: newRefSchema, sceneId: uuid, afterShotId: shotRef.nullable(), shot: shotDraftSchema }),
  /** A planned shot is deleted; a generated one only leaves the movie (its takes stay in the project). */
  z.object({ op: z.literal('shot.remove'), shotId: uuid }),
  z.object({ op: z.literal('shot.move'), shotId: uuid, sceneId: uuid, afterShotId: uuid.nullable() }),
  z.object({ op: z.literal('scene.update'), sceneId: uuid, title: z.string().trim().min(1).max(120).optional(), synopsis: z.string().trim().max(2000).optional(), /** The place (a saved location): its reference photos go into every shot of the scene. */ locationId: uuid.nullable().optional() }),
  z.object({ op: z.literal('character.update'), characterId: uuid, patch: z.object({ description: z.string().trim().max(2000), clothing: z.string().trim().max(500), appearance: z.record(z.string(), z.string().max(400)) }).partial() }),
  // Paid (price shown, approval required)
  z.object({ op: z.literal('storyboard.generate'), shotIds: z.array(shotRef).min(1).max(60) }),
  z.object({ op: z.literal('shot.generate'), shotIds: z.array(shotRef).min(1).max(60) }),
  z.object({ op: z.literal('shot.ai_edit'), shotId: uuid, mode: aiEditModeSchema, instruction: z.string().trim().min(3).max(900), startSec: z.number().min(0).optional(), endSec: z.number().min(0).optional() }),
  // The editor's own timeline operations (trim, transition, colour match, digital camera move…)
  z.object({ op: z.literal('timeline'), plan: planOpSchema }),
]);
export type DirectorOp = z.infer<typeof directorOpSchema>;

export const PAID_DIRECTOR_OPS = ['storyboard.generate', 'shot.generate', 'shot.ai_edit'] as const;
export const isPaidDirectorOp = (op: DirectorOp) => (PAID_DIRECTOR_OPS as readonly string[]).includes(op.op);
/** Operations the server applies to the story (the rest are timeline edits or paid jobs). */
export const isStoryOp = (op: DirectorOp) => op.op.startsWith('shot.') || op.op.startsWith('scene.') || op.op.startsWith('character.') ? !isPaidDirectorOp(op) : false;

/** Where the user asked: the whole project, one scene, one shot, or the gap between two shots. */
export const directorScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }),
  z.object({ kind: z.literal('scene'), sceneId: uuid }),
  z.object({ kind: z.literal('shot'), shotId: uuid, startSec: z.number().min(0).optional(), endSec: z.number().min(0).optional() }),
  z.object({ kind: z.literal('edge'), fromShotId: uuid.nullable(), toShotId: uuid.nullable() }),
]);
export type DirectorScope = z.infer<typeof directorScopeSchema>;

export const directorRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  scope: directorScopeSchema.default({ kind: 'project' }),
  /** The editor's current (possibly unsaved) timeline; falls back to the last saved one. */
  timeline: z.unknown().optional(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) })).max(12).default([]),
});
export type DirectorRequest = z.infer<typeof directorRequestSchema>;

export type DirectorEstimate = { credits: number; model?: string | null; notes?: string[] };
export type DirectorItem = { op: DirectorOp; paid: boolean; summary: string; estimate?: DirectorEstimate | null; blocked?: string };
export type DirectorReply = { reply: string; items: DirectorItem[]; offline: boolean };

// ------------------------------------------------------------------ story order

export type StoryShotLite = { id: string; sceneIndex: number; index: number; generated: boolean };
export type StoryEntry = { key: string; shotId?: string; planned: boolean };

/** Shots in script order: scene by scene, then by their place in the scene. */
export const scriptOrder = <T extends Pick<StoryShotLite, 'sceneIndex' | 'index'>>(shots: T[]) => [...shots].sort((a, b) => a.sceneIndex - b.sceneIndex || a.index - b.index);

/**
 * Where a shot that is not in the movie yet belongs: right after the nearest shot before it in the
 * script that is in the movie (null = at the very start). Used to show planned shots in place and
 * to put a newly generated shot into the movie where the story wants it.
 */
export function anchorKeyFor(shotId: string, seq: SequenceNode[], shots: StoryShotLite[]): string | null {
  const ordered = scriptOrder(shots);
  const at = ordered.findIndex((s) => s.id === shotId);
  for (let i = at - 1; i >= 0; i--) {
    const node = seq.find((n) => n.shotId === ordered[i]!.id);
    if (node) return node.key;
  }
  return null;
}

/**
 * The order the storyboard and graph show: the movie as it plays (the timeline), with planned
 * shots — written but not generated yet — in their script position. Generated shots that were
 * taken out of the movie are not part of it.
 */
export function storyOrder(seq: SequenceNode[], shots: StoryShotLite[]): StoryEntry[] {
  const planned = scriptOrder(shots).filter((s) => !s.generated && !seq.some((n) => n.shotId === s.id));
  const after = new Map<string | null, string[]>();
  for (const p of planned) {
    const k = anchorKeyFor(p.id, seq, shots);
    after.set(k, [...(after.get(k) ?? []), p.id]);
  }
  const out: StoryEntry[] = (after.get(null) ?? []).map((id) => ({ key: `plan:${id}`, shotId: id, planned: true }));
  for (const n of seq) {
    out.push({ key: n.key, shotId: n.shotId, planned: false });
    for (const id of after.get(n.key) ?? []) out.push({ key: `plan:${id}`, shotId: id, planned: true });
  }
  return out;
}

// ------------------------------------------------------------------ instant answers

type Lang = 'en' | 'ka' | 'ru';
const langOf = (s: string): Lang => (/[Ⴀ-ჿ]/.test(s) ? 'ka' : /[Ѐ-ӿ]/.test(s) ? 'ru' : 'en');

export type QuickShot = { id: string; sceneId: string; number: number; generated: boolean; durationSec: number; characterIds: string[]; description: string };
export type DirectorQuickContext = {
  scope: DirectorScope;
  /** The shot in scope (shot scope), or the shots on each side of the gap (edge scope). */
  shot?: QuickShot;
  prev?: QuickShot;
  next?: QuickShot;
  /** Scene scope: its last shot (new shots go after it). */
  sceneLastShotId?: string | null;
  characters: { id: string; name: string; description: string }[];
};

const D = {
  insert: /\b(add|insert|put|create)\b/,
  insertKa: /(დაამატე|ჩასვი|შექმენი|ჩაამატე)/,
  insertRu: /(добавь|вставь|создай)/,
  shotWord: /(\bshot\b|close-?up|reaction|establishing|b-?roll|cutaway|wide shot|კადრ|ახლო ხედ|რეაქცი|ზოგადი ხედ|кадр|крупн|план|реакци)/,
  closeUp: /(close-?up|closeup|ახლო ხედ|ახლო კადრ|крупн)/,
  wide: /(establishing|wide|ზოგადი|ფართო|общий план|общ)/,
  reaction: /(reaction|რეაქცი|реакци)/,
  broll: /(b-?roll|cutaway|detail shot|დეტალ|деталь|перебивк)/,
  before: /(before this|before it|წინ |перед этим|перед ним)/,
  sameCast: /(same character|same characters|same cast|იგივე პერსონაჟ|тот же персонаж|те же персонаж)/,
  several: /(\bshots\b|\b(two|three|four|five|several|some)\b|კადრებ|\b(ორი|სამი|ოთხი|რამდენიმე)\b|кадры|кадров|\b(два|две|три|четыре|несколько)\b)/,
  continueWord: /(continu|extend|keep (it )?going|გააგრძელ|გაგრძელებ|продолж)/,
  remove: /(delete|remove)\s+(this\s+|the\s+)?shot|(წაშალე|ამოიღე)\s+(ეს\s+)?კადრი|(удали|убери)\s+(этот\s+)?кадр/,
  generate: /(\bgenerate\b|\banimate\b|\brender\b|make (the |a )?video|დააგენერირე|შექმენი ვიდეო|გააცოცხლე|сгенерируй|оживи|сделай видео)/,
  storyboard: /(storyboard|draw (a |the )?frame|sketch|სტორიბორდ|კადრის სურათ|დახატე|раскадровк|нарисуй кадр)/,
  shorter: /(shorter|მოკლე|короче)/,
  longer: /(longer|გრძელ|длиннее)/,
  seconds: /(\d+(?:[.,]\d+)?)\s*(s\b|sec|second|წამ|сек)/,
  dialogue: /(\bsays?\b|\bline\b|dialogue|ამბობს|თქვას|ეუბნება|говорит|скажет|реплик)/,
  transition: /(transition|dissolve|cross-?fade|\bfade\b|wipe|გადასვლ|ფეიდ|переход|растворени|затухани)/,
  match: /((match|same)\b.*\b(colou?r|light|lighting|look|grade))|((ფერ|განათებ).*(დაამთხვიე|გაუთანაბრე|იგივე))|((подгони|совмести|выровняй).*(цвет|свет))/,
  slowly: /(slow|gentle|subtle|ნელ|ნაზ|медлен|плавн)/,
};

/** Camera words → the generation preset (planned shots) and the digital move (finished footage). */
const CAMERA_WORDS: { re: RegExp; preset: CameraKey; move: CameraMove | null }[] = [
  { re: /(zoom(s|ing)? in|push(es)? in|dolly in|move (the camera )?closer|camera closer|მიუახლოვ|მიაახლოვ|ზუმ ინ|приблиз|наезд)/, preset: 'dolly_in', move: 'push_in' },
  { re: /(zoom(s|ing)? out|pull(s)? (back|out)|dolly out|move (the camera )?(back|away)|მოშორდ|დააშორ|გაადიდე ხედი|отдали|отъезд)/, preset: 'dolly_out', move: 'pull_out' },
  { re: /(pan (to the )?left|პანორამა მარცხნივ|панорама влево)/, preset: 'pan', move: 'pan_left' },
  { re: /(pan (to the )?right|\bpan\b|პანორამა|панорам)/, preset: 'pan', move: 'pan_right' },
  { re: /(tilt up|ზევით დახრა|наклон вверх)/, preset: 'tilt', move: 'tilt_up' },
  { re: /(tilt down|\btilt\b|ქვევით დახრა|наклон вниз)/, preset: 'tilt', move: 'tilt_down' },
  { re: /(orbit|circle around|შემოუარ|облет|вокруг)/, preset: 'orbit', move: null },
  { re: /(handheld|hand-held|shaky|ხელის კამერ|ручн)/, preset: 'handheld', move: 'handheld' },
  { re: /(tracking|follow (the|him|her|it)|გაჰყევ|следуй|сопровожд)/, preset: 'tracking', move: 'tracking' },
  { re: /(crane|from above|ზემოდან|сверху|кран)/, preset: 'crane', move: null },
  { re: /(static|locked|still camera|უძრავ|статичн|неподвиж)/, preset: 'static', move: 'static' },
];

const STOP = new Set(['the', 'and', 'with', 'this', 'that', 'shot', 'after', 'before', 'make', 'showing', 'show', 'looking', 'from', 'into', 'add', 'insert']);

/** Characters named (or described) in the text: "Bolt", "the robot" (when Bolt is "a small blue robot…"). */
export function charactersIn(text: string, characters: DirectorQuickContext['characters']): string[] {
  const s = text.toLowerCase();
  const words = s.split(/[^\p{L}]+/u).filter((w) => w.length >= 4 && !STOP.has(w));
  return characters
    .filter((c) => {
      const name = c.name.toLowerCase().trim();
      if (name && new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(s)) return true;
      const kind = c.description.toLowerCase().split(/[^\p{L}]+/u).slice(0, 8);
      return words.some((w) => kind.includes(w));
    })
    .map((c) => c.id);
}

const REPLY: Record<Lang, { ready: (n: number, paid: boolean) => string; empty: string }> = {
  en: {
    ready: (n, paid) => (paid ? `Here is the plan (${n} step${n === 1 ? '' : 's'}). Free steps apply at once; paid ones show their price and wait for you.` : `Ready: ${n} change${n === 1 ? '' : 's'} — free. Apply below; Undo puts it back.`),
    empty: 'Added an empty shot — click its text on the card to describe what happens.',
  },
  ka: {
    ready: (n, paid) => (paid ? `გეგმა მზადაა (${n} ნაბიჯი). უფასო ნაბიჯები მაშინვე სრულდება, ფასიანები ფასს გაჩვენებს და დაგელოდება.` : `მზადაა: ${n} ცვლილება — უფასო. გამოიყენე ქვემოთ; Undo დააბრუნებს.`),
    empty: 'ცარიელი კადრი დაემატა — დააჭირე ბარათზე ტექსტს და აღწერე, რა ხდება.',
  },
  ru: {
    ready: (n, paid) => (paid ? `План готов (${n} шаг.). Бесплатные шаги применяются сразу, платные покажут цену и подождут вас.` : `Готово: ${n} изм. — бесплатно. Примените ниже; Undo вернёт.`),
    empty: 'Добавлен пустой кадр — нажмите на текст карточки и опишите, что происходит.',
  },
};

/** "Add a close-up showing the robot surprised" → "Close-up showing the robot surprised". */
function shotDescriptionFrom(raw: string): string {
  let d = raw
    .replace(/^\s*(please\s+)?(can you\s+)?(add|insert|put|create)\s+(in\s+)?(a|an|another|one more|one)?\s*/i, '')
    .replace(/^\s*(დაამატე|ჩასვი|შექმენი|ჩაამატე)\s*/u, '')
    .replace(/^\s*(добавь|вставь|создай)\s*/iu, '')
    .replace(/\s*(right\s+)?\b(after|before|between)\s+(this|these|it|them|the two)(\s+shots?)?\b/gi, '')
    .replace(/\s*[.!]\s*$/, '')
    .replace(/\s*(ამის|ამ კადრის)\s+(შემდეგ|წინ)\s*$/u, '')
    .replace(/\s*(после|перед)\s+(этого|этим|ним)(\s+кадр(а|ом))?\s*$/iu, '')
    .trim();
  if (/^(new\s+)?shot\.?$/i.test(d) || /^(ახალი\s+)?კადრი\.?$/u.test(d) || /^(новый\s+)?кадр\.?$/iu.test(d)) d = '';
  return d ? d.charAt(0).toUpperCase() + d.slice(1) : '';
}

/**
 * Common story requests understood on the device (English, Georgian, Russian): free and instant.
 * Anything it is not sure about returns null and goes to the AI Director instead — it never guesses.
 */
export function quickDirect(message: string, ctx: DirectorQuickContext): { reply: string; ops: DirectorOp[] } | null {
  const raw = message.trim();
  if (!raw || raw.length > 200 || raw.includes('?')) return null;
  const lang = langOf(raw);
  const quoted = raw.match(/["“”«»„](.+?)["“”«»]/)?.[1]?.trim();
  const s = ` ${raw.toLowerCase()} `;
  const ops: DirectorOp[] = [];
  const shot = ctx.scope.kind === 'shot' ? ctx.shot : undefined;
  const wantsInsert = (D.insert.test(s) || D.insertKa.test(s) || D.insertRu.test(s)) && D.shotWord.test(s);
  // Several shots at once, or anything with conditions, needs real planning.
  if (wantsInsert && D.several.test(s)) return null;

  // A continuation: a new shot that starts from the last frame of this one (or of the shot before the gap).
  const from = ctx.scope.kind === 'shot' ? shot : ctx.scope.kind === 'edge' ? ctx.prev : undefined;
  if (from && D.continueWord.test(s) && !D.several.test(s)) {
    const said = raw.replace(/^.*?(continu\w*|extend\w*|keep (it )?going|გააგრძელ\S*|გაგრძელებ\S*|продолж\S*)\s*(the action|it|this|ქმედება|действие)?[:,.]?\s*/iu, '').trim();
    ops.push({
      op: 'shot.insert',
      ref: 'new1',
      sceneId: from.sceneId,
      afterShotId: from.id,
      shot: {
        description: said ? said.charAt(0).toUpperCase() + said.slice(1) : `${lang === 'ka' ? 'გაგრძელება' : lang === 'ru' ? 'Продолжение' : 'Continues'}: ${from.description}`.slice(0, 500),
        prompt: '',
        durationSec: 5,
        characterIds: from.characterIds,
        dialogue: [],
        ...(from.generated ? { continueFrom: from.id } : {}),
      },
    });
    if (D.generate.test(s)) ops.push({ op: 'shot.generate', shotIds: ['new1'] });
    return { reply: REPLY[lang].ready(ops.length, ops.some(isPaidDirectorOp)), ops };
  }

  // New shot: after this one, between two shots, or at the end of a scene.
  if (wantsInsert) {
    let sceneId: string | undefined;
    let afterShotId: string | null = null;
    let anchor: QuickShot | undefined;
    if (ctx.scope.kind === 'shot' && shot) {
      sceneId = shot.sceneId;
      if (D.before.test(s)) afterShotId = ctx.prev && ctx.prev.sceneId === shot.sceneId ? ctx.prev.id : null;
      else afterShotId = shot.id;
      anchor = shot;
    } else if (ctx.scope.kind === 'edge') {
      anchor = ctx.prev ?? ctx.next;
      sceneId = anchor?.sceneId;
      afterShotId = ctx.prev?.id ?? null;
    } else if (ctx.scope.kind === 'scene') {
      sceneId = ctx.scope.sceneId;
      afterShotId = ctx.sceneLastShotId ?? null;
    }
    if (!sceneId) return null;
    const description = shotDescriptionFrom(raw);
    const named = charactersIn(raw, ctx.characters);
    const cast = named.length ? named : D.sameCast.test(s) || !description ? (anchor?.characterIds ?? []) : named;
    const closeUp = D.closeUp.test(s) || D.reaction.test(s);
    const sec = raw.match(D.seconds);
    const shotType = closeUp ? 'close-up' : D.wide.test(s) ? 'wide' : D.broll.test(s) ? 'insert' : undefined;
    ops.push({
      op: 'shot.insert',
      ref: 'new1',
      sceneId,
      afterShotId,
      shot: {
        description: description || (lang === 'ka' ? 'ახალი კადრი' : lang === 'ru' ? 'Новый кадр' : 'New shot'),
        prompt: '',
        durationSec: sec ? Math.min(30, Math.max(2, Math.round(Number(sec[1]!.replace(',', '.'))))) : closeUp ? 4 : 5,
        camera: closeUp ? 'close_up' : D.wide.test(s) ? 'wide' : undefined,
        shotType,
        characterIds: cast,
        dialogue: [],
      },
    });
    if (D.storyboard.test(s)) ops.push({ op: 'storyboard.generate', shotIds: ['new1'] });
    if (D.generate.test(s)) ops.push({ op: 'shot.generate', shotIds: ['new1'] });
    return { reply: description ? REPLY[lang].ready(ops.length, ops.some(isPaidDirectorOp)) : REPLY[lang].empty, ops };
  }

  // Edge: transition or colour match between the two shots (finished footage only).
  if (ctx.scope.kind === 'edge' && ctx.prev?.generated && ctx.next?.generated) {
    if (D.match.test(s)) ops.push({ op: 'timeline', plan: { op: 'match_color', shot: ctx.next.number, fromShot: ctx.prev.number } });
    else if (D.transition.test(s)) {
      const type = /(black|შავ|черн)/.test(s) ? 'fadeblack' : /(wipe)/.test(s) ? 'wipeleft' : /(\bfade\b|ფეიდ|затухани)/.test(s) ? 'fade' : 'dissolve';
      ops.push({ op: 'timeline', plan: { op: 'transition', shot: ctx.prev.number, type, durationSec: 0.6 } });
    }
    return ops.length ? { reply: REPLY[lang].ready(ops.length, false), ops } : null;
  }

  if (!shot) return null;

  if (D.remove.test(s)) return { reply: REPLY[lang].ready(1, false), ops: [{ op: 'shot.remove', shotId: shot.id }] };

  // Colour/light matched to the shot before.
  if (D.match.test(s) && ctx.prev?.generated && shot.generated) {
    return { reply: REPLY[lang].ready(1, false), ops: [{ op: 'timeline', plan: { op: 'match_color', shot: shot.number, fromShot: ctx.prev.number } }] };
  }

  // Camera
  const cam = CAMERA_WORDS.find((c) => c.re.test(s));
  if (cam && !D.dialogue.test(s)) {
    const intensity = D.slowly.test(s) ? 0.35 : 0.55;
    if (!shot.generated) ops.push({ op: 'shot.update', shotId: shot.id, patch: { camera: cam.preset } });
    else if (cam.move) ops.push({ op: 'timeline', plan: { op: 'camera', shot: shot.number, preset: cam.move, intensity } });
    else ops.push({ op: 'shot.update', shotId: shot.id, patch: { camera: cam.preset } }, { op: 'shot.generate', shotIds: [shot.id] });
  }

  // Length
  const sec = raw.match(D.seconds);
  if (sec || D.shorter.test(s) || D.longer.test(s)) {
    const want = sec ? Math.round(Number(sec[1]!.replace(',', '.')) * 10) / 10 : D.shorter.test(s) ? Math.max(2, shot.durationSec - 2) : Math.min(30, shot.durationSec + 2);
    if (!shot.generated) ops.push({ op: 'shot.update', shotId: shot.id, patch: { durationSec: Math.min(30, Math.max(2, Math.round(want))) } });
    else if (want < shot.durationSec) ops.push({ op: 'timeline', plan: { op: 'trim', shot: shot.number, durationSec: Math.max(0.2, want) } });
    else ops.push({ op: 'shot.update', shotId: shot.id, patch: { durationSec: Math.min(30, Math.max(2, Math.round(want))) } }, { op: 'shot.generate', shotIds: [shot.id] });
  }

  // A spoken line: "Bolt says “Hello!”"
  if (quoted && D.dialogue.test(s)) {
    const who = charactersIn(raw.replace(quoted, ''), ctx.characters)[0];
    const speaker = ctx.characters.find((c) => c.id === who)?.name ?? (lang === 'ka' ? 'მთხრობელი' : lang === 'ru' ? 'Рассказчик' : 'Narrator');
    ops.push({ op: 'shot.update', shotId: shot.id, patch: { dialogue: [{ speaker, line: quoted.slice(0, 400), ...(who ? { characterId: who } : {}) }] } });
  }

  if (!ops.length) {
    if (D.storyboard.test(s)) ops.push({ op: 'storyboard.generate', shotIds: [shot.id] });
    else if (D.generate.test(s)) ops.push({ op: 'shot.generate', shotIds: [shot.id] });
  }
  if (!ops.length) return null;
  return { reply: REPLY[lang].ready(ops.length, ops.some(isPaidDirectorOp)), ops };
}

/** One line per operation for the plan list (English; names come from the story). */
export function describeDirectorOp(op: DirectorOp, names: { shot: (id: string) => string; scene: (id: string) => string; character: (id: string) => string; /** Movie position (1-based) → the shot's name. */ movieShot?: (n: number) => string }): string {
  const cam = (k?: string | null) => CAMERA_PRESETS.find((c) => c.key === k)?.label ?? k ?? '';
  switch (op.op) {
    case 'shot.update': {
      const p = op.patch;
      const parts = [
        p.description !== undefined && `description → “${p.description.slice(0, 80)}”`,
        p.prompt !== undefined && 'new generation prompt',
        p.durationSec !== undefined && `${p.durationSec} s long`,
        p.camera !== undefined && (p.camera ? `camera: ${cam(p.camera)}` : 'no camera move'),
        p.shotType !== undefined && `framing: ${p.shotType ?? 'auto'}`,
        p.characterIds !== undefined && `cast: ${p.characterIds.map(names.character).join(', ') || 'nobody'}`,
        p.dialogue !== undefined && (p.dialogue.length ? `line: ${p.dialogue.map((d) => `${d.speaker}: “${d.line.slice(0, 60)}”`).join(' · ')}` : 'no dialogue'),
        p.approved !== undefined && (p.approved ? 'approved' : 'not approved'),
      ].filter(Boolean);
      return `${names.shot(op.shotId)}: ${parts.join(', ')}`;
    }
    case 'shot.insert':
      return `New shot ${op.afterShotId ? `after ${names.shot(op.afterShotId)}` : `at the start of ${names.scene(op.sceneId)}`}: “${op.shot.description.slice(0, 90)}” · ${op.shot.durationSec} s${op.shot.camera ? ` · ${cam(op.shot.camera)}` : ''}${op.shot.characterIds.length ? ` · ${op.shot.characterIds.map(names.character).join(', ')}` : ''}`;
    case 'shot.remove':
      return `Take ${names.shot(op.shotId)} out of the movie`;
    case 'shot.move':
      return `Move ${names.shot(op.shotId)} ${op.afterShotId ? `after ${names.shot(op.afterShotId)}` : `to the start of ${names.scene(op.sceneId)}`}`;
    case 'scene.update':
      return `${names.scene(op.sceneId)}: ${[op.title && `title “${op.title}”`, op.synopsis && 'new synopsis', op.locationId !== undefined && (op.locationId ? 'new place' : 'no place')].filter(Boolean).join(', ')}`;
    case 'character.update':
      return `${names.character(op.characterId)}: ${Object.keys(op.patch).join(', ')} updated (affects every shot they appear in)`;
    case 'storyboard.generate':
      return `Draw the storyboard frame of ${op.shotIds.map(names.shot).join(', ')}`;
    case 'shot.generate':
      return `Generate the video of ${op.shotIds.map(names.shot).join(', ')}`;
    case 'shot.ai_edit':
      return `AI edit of ${names.shot(op.shotId)} (${op.mode}${op.startSec !== undefined ? `, ${op.startSec.toFixed(1)}–${(op.endSec ?? op.startSec).toFixed(1)} s` : ''}): ${op.instruction.slice(0, 120)}`;
    case 'timeline':
      return timelineSummary(op.plan, names.movieShot ?? ((n) => `shot ${n}`));
  }
}

function timelineSummary(p: PlanOp, shot: (n: number) => string): string {
  switch (p.op) {
    case 'transition':
      return `${p.type === 'cut' ? 'Cut' : `${p.type} transition`} from ${shot(p.shot)} into the next (${p.durationSec} s)`;
    case 'match_color':
      return `Match the colour and light of ${shot(p.shot)} to ${shot(p.fromShot)}`;
    case 'camera':
      return `Digital camera move on ${shot(p.shot)}: ${p.preset.replaceAll('_', ' ')} (free, on the existing footage)`;
    case 'trim':
      return `Trim ${shot(p.shot)}${p.durationSec ? ` to ${p.durationSec} s` : ''}`;
    case 'speed':
      return `${shot(p.shot)} at ${p.speed}× speed`;
    default:
      return `Editor: ${p.op.replaceAll('_', ' ')}`;
  }
}
