import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { MovieBrief } from '@framecraft/shared';
import type { AppContext } from '../context';
import type { Db } from '../db/client';
import { assets, characters, generationJobs, projects, scenes, shots } from '../db/schema';
import { createAudioJob, estimateAudio } from '../audio/audio';
import { getConfig } from '../services/admin-config';
import type { SessionLike } from '../generation/service';

/**
 * Dialogue dubbing for films.
 *
 * Video models speak English convincingly but other languages (Georgian especially) with a
 * heavy foreign accent. For those languages the video model renders only picture + ambient
 * sound, and every line is voiced by ElevenLabs with the language set explicitly, one fixed
 * voice per character, then laid onto the timeline in sync with its shot.
 */
const NATIVE_SPEECH_LANGUAGES = new Set(['en']);

export const dubsDialogue = (brief: Pick<MovieBrief, 'language' | 'withDialogue'>) => brief.withDialogue && !NATIVE_SPEECH_LANGUAGES.has(brief.language);

/** Appended to dubbed shots' video prompts so the model leaves the speech out. */
export const NO_SPEECH_DIRECTION =
  'They talk with natural lip movement, but the audio has no speech, no voices and no music: only ambient sound and sound effects (the dialogue is dubbed separately).';

/** Video prompts that asked the model to speak the lines ("X says: ..."). */
export const promptHasSpokenLines = (prompt: string | undefined) => /\bsays: "/.test(prompt ?? '');

const FEMALE = /\b(woman|women|girl|she|her|wife|mother|mom|mum|bride|daughter|lady|sister|grandmother|grandma|actress|queen|princess|aunt|niece|girlfriend|female)\b|ქალი|გოგო|ცოლი|დედა|ბებია|პატარძალი|ქალიშვილი|დეიდა|მამიდა|დაიკო|девушк|женщин|\bона\b|жена|мать|бабушк|дочь|сестр/i;
const MALE = /\b(man|men|boy|he|his|him|husband|father|dad|groom|son|guy|brother|grandfather|grandpa|actor|king|prince|uncle|nephew|boyfriend|male)\b|კაცი|ბიჭი|ქმარი|მამა|ბაბუა|საქმრო|ვაჟი|ძმა|ბიძა|мужчин|парень|\bон\b|муж\b|отец|дедушк|сын|брат/i;

/** Best-effort gender from a character's name and descriptions (used to pick a voice). */
export function guessGender(text: string): 'male' | 'female' | undefined {
  const f = FEMALE.test(text);
  const m = MALE.test(text);
  if (f && !m) return 'female';
  if (m && !f) return 'male';
  return undefined;
}

type CharacterVoice = { style?: string; gender?: string; voiceId?: string; voiceLanguage?: string };

/** Give every character in the film a stable voice for the language (kept across re-dubs). */
export async function castVoices(db: Db, projectId: string, language: string): Promise<{ byCharacter: Map<string, string>; byName: Map<string, string>; narrator: string }> {
  const cfg = await getConfig(db, 'voices');
  const pool = cfg[language] ?? cfg.default!;
  const rows = await db.select().from(characters).where(eq(characters.projectId, projectId)).orderBy(asc(characters.createdAt));
  const byCharacter = new Map<string, string>();
  const byName = new Map<string, string>();
  const used = { male: new Set<string>(), female: new Set<string>() };
  // A cast voice is kept only while it is still in the language's list (e.g. premade voices are
  // replaced once native-speaker voices are adopted).
  const inPool = new Set([...pool.male, ...pool.female]);
  const keep = (v: CharacterVoice) => Boolean(v.voiceId && v.voiceLanguage === language && inPool.has(v.voiceId));
  for (const c of rows) {
    const v = c.voice as CharacterVoice;
    if (keep(v) && (v.gender === 'male' || v.gender === 'female')) used[v.gender].add(v.voiceId!);
  }
  let unknown = 0;
  for (const c of rows) {
    const v = c.voice as CharacterVoice;
    let voiceId = keep(v) ? v.voiceId : undefined;
    if (!voiceId) {
      const gender =
        (v.gender === 'male' || v.gender === 'female' ? v.gender : undefined) ??
        guessGender([c.name, c.description, c.appearance?.distinguishing, c.clothing, v.style].filter(Boolean).join(' ')) ??
        (unknown++ % 2 === 0 ? 'male' : 'female');
      // Prefer a voice no other character uses yet; reuse only when the list runs out.
      voiceId = pool[gender].find((id) => !used[gender].has(id)) ?? pool[gender][used[gender].size % pool[gender].length]!;
      used[gender].add(voiceId);
      await db.update(characters).set({ voice: { ...v, gender, voiceId, voiceLanguage: language }, updatedAt: new Date() }).where(eq(characters.id, c.id));
    }
    byCharacter.set(c.id, voiceId);
    byName.set(c.name.trim().toLowerCase(), voiceId);
  }
  return { byCharacter, byName, narrator: pool.narrator ?? pool.male[0]! };
}

export type DialogueLine = { shotId: string; index: number; speaker: string; characterId?: string; line: string };

/** Every spoken line in the film, in screen order. */
export async function filmDialogue(db: Db, projectId: string, shotIds?: string[]): Promise<DialogueLine[]> {
  const rows = await db
    .select({ shot: shots })
    .from(shots)
    .innerJoin(scenes, eq(scenes.id, shots.sceneId))
    .where(eq(shots.projectId, projectId))
    .orderBy(asc(scenes.index), asc(shots.index));
  // "(write a short line of dialogue)"-style placeholders from the offline planner are never voiced.
  const spoken = (line: string) => Boolean(line.trim()) && !/^\(.*\)$/s.test(line.trim());
  return rows.filter(({ shot }) => !shotIds || shotIds.includes(shot.id)).flatMap(({ shot }) =>
    shot.dialogue.filter((d) => spoken(d.line)).map((d, index) => ({ shotId: shot.id, index, speaker: d.speaker, characterId: d.characterId, line: d.line.trim() })),
  );
}

/** Cost of voicing every line (identical lines already recorded are reused free at run time). */
export async function estimateDialogue(ctx: AppContext, user: SessionLike, projectId: string, language: string, shotIds?: string[]) {
  const lines = await filmDialogue(ctx.db, projectId, shotIds);
  let credits = 0;
  let providerCostUsd = 0;
  for (const l of lines) {
    const e = await estimateAudio(ctx, user, { kind: 'tts', text: l.line, language, quality: 'high', idempotencyKey: 'estimate' });
    credits += e.credits;
    providerCostUsd += e.providerCostUsd;
  }
  const available = ctx.liveEnabled && ctx.audio.isConfigured();
  return { lines: lines.length, credits, providerCostUsd: Math.round(providerCostUsd * 1000) / 1000, available };
}

/**
 * Create one TTS job per line, linked to the film job. Returns how many lines were queued or reused.
 * `shotIds` limits it to some shots; `fresh` records a new take instead of reusing identical audio.
 */
export async function startDubbing(ctx: AppContext, movieJob: typeof generationJobs.$inferSelect, language: string, opts: { shotIds?: string[]; fresh?: boolean } = {}): Promise<number> {
  const projectId = movieJob.projectId!;
  const lines = await filmDialogue(ctx.db, projectId, opts.shotIds);
  if (!lines.length) return 0;
  const cast = await castVoices(ctx.db, projectId, language);
  const user = { id: movieJob.userId, role: 'user' as const };
  let n = 0;
  for (const l of lines) {
    const voiceId = (l.characterId && cast.byCharacter.get(l.characterId)) || cast.byName.get(l.speaker.trim().toLowerCase()) || cast.narrator;
    try {
      await createAudioJob(
        ctx,
        user,
        { kind: 'tts', text: l.line, voiceId, language, quality: 'high', projectId, idempotencyKey: `dub:${movieJob.id}:${l.shotId}:${l.index}`, fresh: opts.fresh },
        { parentJobId: movieJob.id, shotId: l.shotId },
      );
      n++;
    } catch (err) {
      // e.g. not enough credits: the line keeps its subtitle, the film still renders.
      ctx.log.warn('dialogue line not voiced', { shotId: l.shotId, error: (err as Error).message });
    }
  }
  return n;
}

export type VoiceWord = { text: string; start: number; end: number };
export type DubbedVoice = { assetId: string; durationSec: number; text: string; words: VoiceWord[] };

export type VoiceTake = { assetId: string; createdAt: string; current: boolean };

/** Which take the user chose per line (`${shotId}:${index}` → asset); absent = newest take. */
type VoiceSelection = Record<string, string>;

/**
 * The film's current dub: for every line still in the script, one recording — the take the user
 * chose, otherwise the newest — with word timings. Every earlier take is kept (`takes`) so the
 * user can switch back. Also returns the shots whose video still contains model-spoken lines.
 */
export async function dubTrack(db: Db, projectId: string): Promise<{ voices: Map<string, DubbedVoice[]>; spokenInVideo: Set<string>; takes: Map<string, VoiceTake[]> }> {
  const script = new Map((await filmDialogue(db, projectId)).map((l) => [`${l.shotId}:${l.index}`, l.line]));
  const [project] = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId));
  const selection = ((project?.settings as { voiceSelection?: VoiceSelection } | undefined)?.voiceSelection ?? {}) as VoiceSelection;
  const jobs = await db
    .select({ shotId: generationJobs.shotId, request: generationJobs.request, assetId: generationJobs.outputAssetId, key: generationJobs.idempotencyKey, createdAt: generationJobs.createdAt })
    .from(generationJobs)
    .where(and(eq(generationJobs.projectId, projectId), eq(generationJobs.kind, 'audio'), eq(generationJobs.status, 'completed'), sql`${generationJobs.idempotencyKey} like 'dub:%'`))
    .orderBy(asc(generationJobs.createdAt));
  const ids = jobs.map((j) => j.assetId).filter(Boolean) as string[];
  const rows = ids.length ? await db.select({ id: assets.id, durationMs: assets.durationMs, source: assets.source }).from(assets).where(inArray(assets.id, ids)) : [];
  const byAsset = new Map(rows.map((r) => [r.id, r]));
  // Takes in recording order; a recording whose text no longer matches the script is ignored.
  // (A reused identical recording is the same take, listed once.)
  const all = new Map<string, (DubbedVoice & { shotId: string; index: number; createdAt: Date })[]>();
  for (const j of jobs) {
    const a = j.assetId ? byAsset.get(j.assetId) : undefined;
    const index = Number(j.key?.split(':').pop());
    const text = (j.request as { text: string }).text;
    const line = `${j.shotId}:${index}`;
    if (!j.shotId || !a?.durationMs || !Number.isInteger(index) || script.get(line) !== text) continue;
    const list = all.get(line) ?? [];
    if (!list.some((t) => t.assetId === a.id)) list.push({ shotId: j.shotId, index, assetId: a.id, durationSec: a.durationMs / 1000, text, words: (a.source as { words?: VoiceWord[] }).words ?? [], createdAt: j.createdAt });
    all.set(line, list);
  }
  const voices = new Map<string, (DubbedVoice & { index: number })[]>();
  const takes = new Map<string, VoiceTake[]>();
  for (const [line, list] of all) {
    const chosen = list.find((t) => t.assetId === selection[line]) ?? list.at(-1)!;
    takes.set(line, list.map((t) => ({ assetId: t.assetId, createdAt: t.createdAt.toISOString(), current: t === chosen })));
    voices.set(chosen.shotId, [...(voices.get(chosen.shotId) ?? []), chosen]);
  }
  for (const list of voices.values()) list.sort((x, y) => x.index - y.index);

  // Shots generated before dubbing existed had the model speak the lines: those clips are muted under the new voices.
  const spokenInVideo = new Set<string>();
  const shotIds = [...voices.keys()];
  if (shotIds.length) {
    const vids = await db
      .select({ shotId: shots.id, prompt: sql<string>`${generationJobs.request}->>'prompt'` })
      .from(shots)
      .innerJoin(generationJobs, eq(generationJobs.id, shots.lastJobId))
      .where(inArray(shots.id, shotIds));
    for (const v of vids) if (promptHasSpokenLines(v.prompt)) spokenInVideo.add(v.shotId);
  }
  return { voices, spokenInVideo, takes };
}

/** Choose a line's take (null = back to the newest). */
export async function selectVoiceTake(db: Db, projectId: string, line: string, assetId: string | null) {
  const [project] = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId));
  const settings = (project?.settings ?? {}) as { voiceSelection?: VoiceSelection };
  const voiceSelection = { ...(settings.voiceSelection ?? {}) };
  if (assetId) voiceSelection[line] = assetId;
  else delete voiceSelection[line];
  await db.update(projects).set({ settings: { ...settings, voiceSelection }, updatedAt: new Date() }).where(eq(projects.id, projectId));
}

/** A new take of these shots becomes current: forget earlier choices for their lines. */
export async function clearVoiceSelection(db: Db, projectId: string, shotIds: string[]) {
  const [project] = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId));
  const settings = (project?.settings ?? {}) as { voiceSelection?: VoiceSelection };
  if (!settings.voiceSelection) return;
  const voiceSelection = Object.fromEntries(Object.entries(settings.voiceSelection).filter(([line]) => !shotIds.includes(line.split(':')[0]!)));
  await db.update(projects).set({ settings: { ...settings, voiceSelection }, updatedAt: new Date() }).where(eq(projects.id, projectId));
}
