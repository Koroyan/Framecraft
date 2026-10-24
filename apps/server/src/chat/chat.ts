import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { movieBriefSchema, type MovieBrief } from '@framecraft/shared';
import type { AppContext } from '../context';
import { assets, chatMessages, chatSessions, generationJobs, projects, shots, userSettings, users } from '../db/schema';
import { createMovie, replanMovie } from '../movie/movie';
import { enqueue, type QueueJob } from '../queue/queue';
import { assetUrl, getOwnedAsset } from '../services/assets';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import type { SessionLike } from '../generation/service';
import { linksIn, readWebPage } from './web';

/**
 * Chat mode for the AI Movie Maker and the Ad Studio.
 *
 * The AI Director talks with the user, keeps a working brief in the session, and drives the same
 * pipeline as the form-based Movie Maker: screenplay → (chat or Director-mode edits) → approval →
 * budget → generation → film. Anything that spends credits happens only through explicit buttons
 * (the budget card's Generate), never from the model's reply.
 */

export type ChatKind = 'movie' | 'ad';
type Lang = 'en' | 'ka' | 'ru';
type Attachment = { assetId: string; kind: 'photo' | 'logo' | 'product'; token?: string };
type Session = typeof chatSessions.$inferSelect;

export type AdConcept = { title: string; angle: string; hook: string; story: string; voiceover: string[]; cta: string; musicMood: string; lengthSec: number };
type Business = Partial<{ name: string; about: string; products: string; offer: string; audience: string; tone: string; website: string; platform: 'tiktok' | 'reels' | 'shorts' | 'youtube' | 'feed'; lengthSec: number; language: Lang }>;
type MovieState = { lang?: Lang; brief?: Partial<MovieBrief>; references?: { token: string; assetId: string; note?: string }[] };
/** A reply the AI is still working on (runs in the queue: model calls can outlast an HTTP request). */
type PendingTurn = { since: number; action?: 'new_concepts' };
type AdState = MovieState & { business?: Business; logoAssetId?: string; productAssetIds?: string[]; pages?: { url: string; text: string }[]; concepts?: AdConcept[]; pending?: PendingTurn };

const TURN_STALE_MS = 10 * 60_000;
const thinking = (state: AdState) => Boolean(state.pending && Date.now() - state.pending.since < TURN_STALE_MS);

// ----------------------------------------------------------------- language

const detectLang = (text: string): Lang | undefined => (/[Ⴀ-ჿ]/.test(text) ? 'ka' : /[Ѐ-ӿ]/.test(text) ? 'ru' : /[a-z]{3}/i.test(text) ? 'en' : undefined);
const LANG_NAME: Record<Lang, string> = { en: 'English', ka: 'Georgian', ru: 'Russian' };

const T = {
  welcomeMovie: {
    en: "Hi! I'm your AI Director. Tell me the story you want to film — a sentence is enough. You can attach photos (people, places, products) and refer to them as photo1, photo2… I'll write the characters and screenplay for you to review before anything is generated.",
    ka: 'გამარჯობა! მე ვარ შენი AI რეჟისორი. მომიყევი, რა ისტორიის გადაღება გინდა — ერთი წინადადებაც საკმარისია. შეგიძლია ფოტოებიც მიამაგრო (ადამიანები, ადგილები, პროდუქტები) და მოიხსენიო როგორც photo1, photo2… დავწერ პერსონაჟებს და სცენარს, შენ ნახავ და დაადასტურებ, სანამ რამე დაგენერირდება.',
    ru: 'Привет! Я ваш AI-режиссёр. Расскажите, какую историю хотите снять — достаточно одного предложения. Можно прикрепить фото (люди, места, товары) и называть их photo1, photo2… Я напишу персонажей и сценарий, вы проверите их до генерации.',
  },
  welcomeAd: {
    en: "Hi! I'm your Ad Studio creative director. Tell me about your business — what you sell and who it's for. Paste your website or social links, and attach your logo and product photos. I'll pitch ad ideas, then make the video you pick.",
    ka: 'გამარჯობა! მე ვარ Ad Studio-ს კრეატიული დირექტორი. მომიყევი შენს ბიზნესზე — რას ყიდი და ვისთვის. ჩასვი ვებსაიტის ან სოციალური ქსელის ლინკები, მიამაგრე ლოგო და პროდუქტის ფოტოები. შემოგთავაზებ რეკლამის იდეებს და შენ მიერ არჩეულ ვიდეოს გავაკეთებ.',
    ru: 'Привет! Я креативный директор Ad Studio. Расскажите о бизнесе — что продаёте и для кого. Вставьте ссылки на сайт или соцсети, прикрепите логотип и фото товаров. Я предложу идеи рекламы и сделаю выбранное видео.',
  },
  approved: {
    en: 'Great — here is the budget. Tick the approval box and press Generate when you are ready.',
    ka: 'შესანიშნავია — აი ბიუჯეტი. მონიშნე დადასტურება და დააჭირე Generate, როცა მზად იქნები.',
    ru: 'Отлично — вот бюджет. Отметьте подтверждение и нажмите Generate, когда будете готовы.',
  },
  started: {
    en: 'Production has started. I will show every step here — shots, voices, music and the final cut.',
    ka: 'წარმოება დაიწყო. ყველა ნაბიჯს აქ გაჩვენებ — შოტებს, ხმებს, მუსიკას და საბოლოო მონტაჟს.',
    ru: 'Производство началось. Я покажу здесь каждый шаг — кадры, голоса, музыку и финальный монтаж.',
  },
  writing: { en: 'Writing the screenplay…', ka: 'ვწერ სცენარს…', ru: 'Пишу сценарий…' },
  revising: { en: 'Revising the screenplay…', ka: 'ვასწორებ სცენარს…', ru: 'Исправляю сценарий…' },
  concepts: { en: 'Here are three ad ideas. Pick one (or tell me what to change).', ka: 'აი სამი რეკლამის იდეა. აირჩიე ერთი (ან მითხარი, რა შევცვალო).', ru: 'Вот три идеи рекламы. Выберите одну (или скажите, что изменить).' },
  making: { en: 'Making this ad — writing the shots and voice-over…', ka: 'ვაკეთებ ამ რეკლამას — ვწერ შოტებს და ტექსტს…', ru: 'Делаю эту рекламу — пишу кадры и закадровый текст…' },
  noProject: { en: 'Tell me the story first, then I will write the screenplay.', ka: 'ჯერ ისტორია მომიყევი და მერე სცენარს დავწერ.', ru: 'Сначала расскажите историю, потом я напишу сценарий.' },
  offline: { en: '(AI Director is not configured, so I used the offline planner.)', ka: '(AI რეჟისორი არ არის ჩართული — გამოვიყენე ოფლაინ დამგეგმავი.)', ru: '(AI-режиссёр не настроен — использован офлайн-планировщик.)' },
  failed: { en: 'Sorry, something went wrong on my side. Please send that again.', ka: 'ბოდიში, ჩემს მხარეს რაღაც შეფერხდა. გთხოვ, ეს კიდევ ერთხელ მომწერე.', ru: 'Извините, у меня что-то пошло не так. Пожалуйста, отправьте ещё раз.' },
  busy: { en: 'Still working on the previous reply — one moment.', ka: 'ჯერ წინა პასუხზე ვმუშაობ — ერთი წამით.', ru: 'Ещё работаю над предыдущим ответом — секунду.' },
} satisfies Record<string, Record<Lang, string>>;

// ----------------------------------------------------------------- model schemas

const briefPatchSchema = z.object({
  idea: z.string().optional(),
  lengthSec: z.number().optional(),
  aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:5']).optional(),
  style: z.string().optional(),
  genre: z.string().optional(),
  language: z.enum(['en', 'ka', 'ru']).optional(),
  withDialogue: z.boolean().optional(),
  withMusic: z.boolean().optional(),
});

const movieTurnSchema = z.object({
  reply: z.string(),
  action: z.enum(['ask', 'write_screenplay', 'revise_screenplay', 'show_budget', 'none']),
  brief: briefPatchSchema,
  revision: z.string(),
  suggestions: z.array(z.string()),
});

const businessPatchSchema = z.object({
  name: z.string().optional(),
  about: z.string().optional(),
  products: z.string().optional(),
  offer: z.string().optional(),
  audience: z.string().optional(),
  tone: z.string().optional(),
  website: z.string().optional(),
  platform: z.enum(['tiktok', 'reels', 'shorts', 'youtube', 'feed']).optional(),
  lengthSec: z.number().optional(),
  language: z.enum(['en', 'ka', 'ru']).optional(),
});

const adTurnSchema = z.object({
  reply: z.string(),
  action: z.enum(['ask', 'propose_concepts', 'make_ad', 'revise_screenplay', 'show_budget', 'none']),
  business: businessPatchSchema,
  conceptIndex: z.number().int(),
  revision: z.string(),
  suggestions: z.array(z.string()),
});

const adConceptsSchema = z.object({
  concepts: z.array(z.object({ title: z.string(), angle: z.string(), hook: z.string(), story: z.string(), voiceover: z.array(z.string()), cta: z.string(), musicMood: z.string(), lengthSec: z.number() })),
});

const RULES_COMMON = `Always reply in the user's language (Georgian, Russian or English — match their latest message). Be warm, concise and professional: 1–4 short sentences, no lists unless asked.
Never start generation yourself and never quote prices — the app shows the budget and a Generate button. Never invent facts about the user's business (no fake prices, discounts, awards or testimonials).
suggestions: up to 3 very short quick replies the user might send next, in their language.`;

const MOVIE_SYSTEM = `You are the AI Director of Framecraft, chatting with a user to make a short AI film.
Workflow:
1) If the user has given a story idea, do not interrogate them: fill sensible defaults (length 30–60 s unless stated; 16:9 unless they mention TikTok/Reels/Shorts/vertical → 9:16; dialogue in the user's language; style cinematic) and choose action write_screenplay with brief.idea = the full story in your words (keep names, places, photo tokens). Ask (action ask) only when there is no usable idea yet.
2) After a screenplay exists (see Project status) and the user asks for changes, choose revise_screenplay and put a precise English list of the requested changes in "revision". For a completely different story, choose write_screenplay with the new brief.
3) When the user approves or says go/generate, choose show_budget.
4) While the screenplay is being written or the film is generating, choose none and say what is happening.
Attached photos are named photo1, photo2…; when the user says who or what a photo shows, include that in brief.idea (e.g. "Nino (photo1) …").
brief: only the fields you set or change. revision: "" unless revising.
${RULES_COMMON}`;

const AD_SYSTEM = `You are the creative director of Framecraft's Ad Studio, helping a business owner create video ads.
Gather the essentials: business name, what they sell/offer, target audience, where the ad runs (tiktok, reels, shorts, youtube or feed), length (15 or 30 s) and language. Website/link text is in Context — use it, don't ask for what is already there. Ask at most two questions per turn and default the rest.
As soon as you know the business and what to advertise, choose propose_concepts. When the user picks an idea (by number or description), choose make_ad with conceptIndex (0-based). Afterwards: revise_screenplay for changes (precise English list in "revision"), show_budget when they approve.
business: only the fields you learned or changed. conceptIndex: -1 unless make_ad. revision: "" unless revising.
${RULES_COMMON}`;

const CONCEPTS_SYSTEM = `You are an award-winning performance-marketing creative. Write three clearly different video ad concepts for this business (e.g. emotional story, product demo, bold/UGC-style).
Each: title; angle (why it sells); hook (what happens in the first 2 seconds); story (2–4 vivid visual sentences an AI video model can film — real-looking scenes, no on-screen text, no logos drawn by the model); voiceover (2–5 short narrator lines in the requested language that fit the length at ~2.3 words/second); cta (short call to action in the requested language); musicMood; lengthSec (the requested length).
Write every field (title, angle, hook, story, voiceover, cta) in the requested language — the business owner reads them; the screenplay step turns the story into English video prompts later.
Use only facts from the brief and website notes — no invented prices, discounts, awards or testimonials.`;

// ----------------------------------------------------------------- sessions

async function userLang(ctx: AppContext, userId: string): Promise<Lang> {
  const [s] = await ctx.db.select({ language: userSettings.language }).from(userSettings).where(eq(userSettings.userId, userId));
  return (['en', 'ka', 'ru'].includes(s?.language ?? '') ? s!.language : 'en') as Lang;
}

async function ownedSession(ctx: AppContext, user: SessionLike, id: string): Promise<Session> {
  const [s] = await ctx.db.select().from(chatSessions).where(and(eq(chatSessions.id, id), eq(chatSessions.userId, user.id)));
  if (!s) throw notFound('Conversation not found');
  return s;
}

async function addMessage(ctx: AppContext, sessionId: string, m: { role: 'user' | 'assistant'; content: string; attachments?: Attachment[]; card?: Record<string, unknown> | null }) {
  const [row] = await ctx.db.insert(chatMessages).values({ sessionId, role: m.role, content: m.content, attachments: m.attachments ?? [], card: m.card ?? null }).returning();
  return row!;
}

async function saveSession(ctx: AppContext, s: Session, patch: Partial<Pick<Session, 'state' | 'title' | 'projectId'>>) {
  await ctx.db.update(chatSessions).set({ ...patch, updatedAt: new Date() }).where(eq(chatSessions.id, s.id));
  Object.assign(s, patch);
}

export async function createChatSession(ctx: AppContext, user: SessionLike, kind: ChatKind) {
  const lang = await userLang(ctx, user.id);
  const [s] = await ctx.db.insert(chatSessions).values({ userId: user.id, kind, title: kind === 'ad' ? 'New ad' : 'New film', state: { lang } }).returning();
  await addMessage(ctx, s!.id, { role: 'assistant', content: (kind === 'ad' ? T.welcomeAd : T.welcomeMovie)[lang] });
  return getChatSession(ctx, user, s!.id);
}

export async function listChatSessions(ctx: AppContext, user: SessionLike, kind?: ChatKind) {
  return ctx.db
    .select({ id: chatSessions.id, kind: chatSessions.kind, title: chatSessions.title, projectId: chatSessions.projectId, updatedAt: chatSessions.updatedAt })
    .from(chatSessions)
    .where(and(eq(chatSessions.userId, user.id), kind ? eq(chatSessions.kind, kind) : sql`true`))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(50);
}

export async function getChatSession(ctx: AppContext, user: SessionLike, id: string) {
  const s = await ownedSession(ctx, user, id);
  const messages = await ctx.db.select().from(chatMessages).where(eq(chatMessages.sessionId, id)).orderBy(asc(chatMessages.createdAt));
  const state = s.state as AdState;
  // Thumbnails for attached photos and the logo.
  const ids = [...new Set([...messages.flatMap((m) => m.attachments.map((a) => a.assetId)), ...(state.logoAssetId ? [state.logoAssetId] : [])])];
  const rows = ids.length ? await ctx.db.select().from(assets).where(and(inArray(assets.id, ids), eq(assets.userId, user.id))) : [];
  const assetUrls = Object.fromEntries(await Promise.all(rows.map(async (a) => [a.id, await assetUrl(ctx, a)] as const)));
  return { assetUrls, session: { id: s.id, kind: s.kind as ChatKind, title: s.title, projectId: s.projectId, lang: state.lang ?? 'en', business: state.business ?? null, logoAssetId: state.logoAssetId ?? null, references: state.references ?? [], thinking: thinking(state) }, messages };
}

export async function deleteChatSession(ctx: AppContext, user: SessionLike, id: string) {
  await ownedSession(ctx, user, id);
  await ctx.db.delete(chatSessions).where(eq(chatSessions.id, id));
}

// ----------------------------------------------------------------- project status (for the model)

async function projectStatus(ctx: AppContext, projectId: string | null): Promise<{ text: string; stage: 'none' | 'writing' | 'review' | 'generating' | 'done' | 'failed' }> {
  if (!projectId) return { text: 'No screenplay yet.', stage: 'none' };
  const jobs = await ctx.db.select().from(generationJobs).where(and(eq(generationJobs.projectId, projectId), sql`${generationJobs.kind} in ('plan', 'movie')`)).orderBy(asc(generationJobs.createdAt));
  const plan = jobs.filter((j) => j.kind === 'plan').at(-1);
  const movie = jobs.filter((j) => j.kind === 'movie').at(-1);
  if (plan && ['queued', 'preparing'].includes(plan.status)) return { text: 'The screenplay is being written right now.', stage: 'writing' };
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  const shotRows = await ctx.db.select({ id: shots.id, ready: sql<boolean>`${shots.currentAssetId} is not null` }).from(shots).where(eq(shots.projectId, projectId));
  const meta = (project?.plan ?? {}) as { title?: string; logline?: string };
  const summary = `Screenplay "${meta.title ?? project?.title}" — ${meta.logline ?? ''} (${shotRows.length} shots, ${shotRows.filter((s) => s.ready).length} generated).`;
  if (movie && ['queued', 'generating', 'rendering'].includes(movie.status)) return { text: `${summary} The film is being generated: ${movie.phase ?? ''}.`, stage: 'generating' };
  if (movie?.status === 'completed' && movie.outputAssetId) return { text: `${summary} The film is finished.`, stage: 'done' };
  if (movie?.status === 'failed') return { text: `${summary} Some shots failed: ${movie.phase ?? ''}.`, stage: 'failed' };
  if (plan?.status === 'failed') return { text: 'Writing the screenplay failed; it can be tried again.', stage: 'none' };
  return { text: `${summary} Waiting for the user's review or approval.`, stage: 'review' };
}

function transcript(messages: (typeof chatMessages.$inferSelect)[]) {
  return messages
    .slice(-16)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}${m.attachments.length ? ` [attached: ${m.attachments.map((a) => a.token ?? a.kind).join(', ')}]` : ''}`)
    .join('\n');
}

// ----------------------------------------------------------------- turn

const APPROVE = /\b(approve|approved|go|generate|ok|yes|start)\b|დავადასტურ|დადასტურ|დაიწყე|გააკეთე|კარგი|დიახ|ჰო|გენერირ|утверж|давай|запуск|генерир|да\b/i;

export async function postChatMessage(ctx: AppContext, user: SessionLike, sessionId: string, input: { content: string; attachments?: { assetId: string; kind?: 'photo' | 'logo' | 'product'; note?: string }[] }) {
  const s = await ownedSession(ctx, user, sessionId);
  const state = { ...(s.state as AdState) };
  const content = input.content.trim();
  if (!content && !input.attachments?.length) throw badRequest('Write a message or attach a photo');
  if (thinking(state)) throw conflict(T.busy[state.lang ?? 'en']);
  state.lang = detectLang(content) ?? state.lang ?? 'en';

  // Attachments: the user's own images. Film photos get photoN tokens; ad logo/product photos too.
  const attachments: Attachment[] = [];
  for (const a of input.attachments ?? []) {
    const asset = await getOwnedAsset(ctx, user.id, a.assetId);
    if (asset.mediaType !== 'image') throw badRequest('Only images can be attached');
    const kind = a.kind ?? 'photo';
    if (kind === 'logo') {
      // The logo also becomes a reference photo so the final "logo end card" shot uses the exact file.
      state.logoAssetId = asset.id;
      const refs = (state.references ??= []);
      let ref = refs.find((r) => r.note === 'brand logo');
      if (ref) ref.assetId = asset.id;
      else refs.push((ref = { token: `photo${refs.length + 1}`, assetId: asset.id, note: 'brand logo' }));
      attachments.push({ assetId: asset.id, kind, token: ref.token });
      continue;
    }
    const refs = (state.references ??= []);
    if (refs.length >= 12) throw badRequest('Up to 12 photos per conversation');
    const token = `photo${refs.length + 1}`;
    refs.push({ token, assetId: asset.id, ...(a.note ? { note: a.note.slice(0, 120) } : {}) });
    if (kind === 'product') state.productAssetIds = [...(state.productAssetIds ?? []), asset.id];
    attachments.push({ assetId: asset.id, kind, token });
  }
  const msg = await addMessage(ctx, s.id, { role: 'user', content, attachments });
  if (s.title === 'New film' || s.title === 'New ad') s.title = (content || 'Photos').slice(0, 60);
  await startTurn(ctx, s, state, {});
  return msg;
}

/** Mark the conversation as "thinking" and hand the AI's reply to the queue. */
async function startTurn(ctx: AppContext, s: Session, state: AdState, pending: Omit<PendingTurn, 'since'>) {
  state.pending = { since: Date.now(), ...pending };
  await ctx.db.transaction(async (tx) => {
    await tx.update(chatSessions).set({ state: state as Record<string, unknown>, title: s.title, updatedAt: new Date() }).where(eq(chatSessions.id, s.id));
    await enqueue(tx as never, 'chat.turn', { sessionId: s.id, since: state.pending!.since }, { queue: 'generation', dedupeKey: `chat:${s.id}:${state.pending!.since}`, maxAttempts: 1 });
  });
}

/** Queue handler: the AI's reply to the latest message (or a "new ideas" request). */
export async function runChatTurn(ctx: AppContext, job: QueueJob) {
  const { sessionId, since } = job.payload as { sessionId: string; since: number };
  const [s] = await ctx.db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  const state = { ...((s?.state ?? {}) as AdState) };
  if (!s || state.pending?.since !== since) return; // deleted, or already answered
  const [u] = await ctx.db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, s.userId));
  const lang = state.lang ?? 'en';
  try {
    if (!u) throw new Error('user not found');
    if (state.pending.action === 'new_concepts') {
      state.concepts = await proposeConcepts(ctx, state);
      await addMessage(ctx, s.id, { role: 'assistant', content: T.concepts[lang], card: { type: 'concepts', concepts: state.concepts } });
    } else {
      await replyTurn(ctx, u, s, state);
    }
  } catch (err) {
    ctx.log.error('chat turn failed', { sessionId, error: (err as Error).message });
    await addMessage(ctx, s.id, { role: 'assistant', content: err instanceof AppError ? err.message : T.failed[lang] });
  }
  delete state.pending;
  await saveSession(ctx, s, { state: state as Record<string, unknown>, title: s.title });
}

async function replyTurn(ctx: AppContext, user: SessionLike, s: Session, state: AdState) {
  const history = await ctx.db.select().from(chatMessages).where(eq(chatMessages.sessionId, s.id)).orderBy(asc(chatMessages.createdAt));
  const content = history.filter((m) => m.role === 'user').at(-1)?.content ?? '';

  // Ads: read pasted links (the business's own pages) once.
  if (s.kind === 'ad') {
    const links = [...linksIn(content), ...(state.business?.website ? [state.business.website] : [])].filter((u) => !(state.pages ?? []).some((p) => p.url.includes(u.replace(/^https?:\/\//, ''))));
    for (const link of links.slice(0, 3)) {
      try {
        const page = await readWebPage(link, { maxChars: 4000 });
        state.pages = [...(state.pages ?? []), page].slice(-4);
      } catch (err) {
        state.pages = [...(state.pages ?? []), { url: link, text: `(could not read this page: ${(err as Error).message})` }].slice(-4);
      }
    }
  }

  const status = await projectStatus(ctx, s.projectId);
  const context = [
    `Project status: ${status.text}`,
    s.kind === 'ad'
      ? `Business so far: ${JSON.stringify(state.business ?? {})}\nLogo attached: ${state.logoAssetId ? 'yes' : 'no'}; product photos: ${(state.productAssetIds ?? []).length}\nConcepts shown: ${(state.concepts ?? []).map((c, i) => `${i}: ${c.title}`).join('; ') || 'none'}\nWebsite notes:\n${(state.pages ?? []).map((p) => `[${p.url}]\n${p.text}`).join('\n\n') || 'none'}`
      : `Working brief: ${JSON.stringify(state.brief ?? {})}`,
    `Attached photos: ${(state.references ?? []).map((r) => r.token + (r.note ? ` (${r.note})` : '')).join(', ') || 'none'}`,
    `Conversation:\n${transcript(history)}`,
  ].join('\n\n');

  return s.kind === 'ad' ? adTurn(ctx, user, s, state, context, content, status.stage) : movieTurn(ctx, user, s, state, context, content, status.stage);
}

type TurnResult = { reply: string; card?: Record<string, unknown>; suggestions: string[] };

async function finishTurn(ctx: AppContext, s: Session, r: TurnResult) {
  const msg = await addMessage(ctx, s.id, { role: 'assistant', content: r.reply, card: r.card ?? (r.suggestions.length ? { type: 'suggestions', items: r.suggestions.slice(0, 3) } : null) });
  return msg;
}

/** Turn a user-facing error (e.g. "already generated") into a chat reply instead of a failure. */
async function attempt(fn: () => Promise<TurnResult>, fallbackReply: string): Promise<TurnResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return { reply: `${fallbackReply}\n\n${err.message}`, suggestions: [] };
    throw err;
  }
}

function buildBrief(state: MovieState, patch: Partial<MovieBrief>, lang: Lang): MovieBrief | null {
  const merged = { language: lang, lengthSec: 45, aspectRatio: '16:9', style: 'cinematic', withDialogue: true, withMusic: true, ...state.brief, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== '')), references: state.references ?? [] };
  merged.lengthSec = Math.min(600, Math.max(15, Math.round(Number(merged.lengthSec) || 45)));
  const parsed = movieBriefSchema.safeParse(merged);
  return parsed.success ? parsed.data : null;
}

async function screenplayStep(ctx: AppContext, user: SessionLike, s: Session, state: MovieState, brief: MovieBrief, key: string, opts: { kind?: 'movie' | 'ad'; settings?: Record<string, unknown> } = {}) {
  state.brief = brief;
  if (!s.projectId) {
    const { projectId, planJobId } = await createMovie(ctx, user, brief, key, opts);
    await saveSession(ctx, s, { projectId });
    return { type: 'screenplay', projectId, planJobId };
  }
  const job = await replanMovie(ctx, user, s.projectId, { brief, idempotencyKey: key });
  return { type: 'screenplay', projectId: s.projectId, planJobId: job.id };
}

async function movieTurn(ctx: AppContext, user: SessionLike, s: Session, state: MovieState, context: string, content: string, stage: string) {
  const lang = state.lang ?? 'en';
  const turn = await ctx.director.converse({ system: MOVIE_SYSTEM, prompt: context, schema: movieTurnSchema }, () => {
    // Offline: the first message is the idea; afterwards approval words open the budget.
    if (!s.projectId) return { reply: T.writing[lang], action: 'write_screenplay' as const, brief: { idea: content }, revision: '', suggestions: [] };
    if (APPROVE.test(content)) return { reply: T.approved[lang], action: 'show_budget' as const, brief: {}, revision: '', suggestions: [] };
    return { reply: `${T.revising[lang]} ${T.offline[lang]}`, action: 'revise_screenplay' as const, brief: {}, revision: content, suggestions: [] };
  });
  const offline = turn.source === 'offline' ? ` ${T.offline[lang]}` : '';
  const key = `chat:${s.id}:${Date.now()}`;
  const r = await attempt(async () => {
    switch (turn.action) {
      case 'write_screenplay': {
        if (stage === 'generating') return { reply: turn.reply, suggestions: turn.suggestions };
        const brief = buildBrief(state, turn.brief as Partial<MovieBrief>, lang);
        if (!brief) return { reply: T.noProject[lang], suggestions: turn.suggestions };
        return { reply: turn.reply + offline, card: await screenplayStep(ctx, user, s, state, brief, key), suggestions: [] };
      }
      case 'revise_screenplay': {
        if (!s.projectId) return { reply: T.noProject[lang], suggestions: turn.suggestions };
        const job = await replanMovie(ctx, user, s.projectId, { revision: turn.revision || content, idempotencyKey: key });
        return { reply: turn.reply, card: { type: 'screenplay', projectId: s.projectId, planJobId: job.id }, suggestions: [] };
      }
      case 'show_budget':
        if (!s.projectId || stage === 'writing') return { reply: s.projectId ? turn.reply : T.noProject[lang], suggestions: turn.suggestions };
        return { reply: turn.reply || T.approved[lang], card: { type: 'budget', projectId: s.projectId }, suggestions: [] };
      default:
        return { reply: turn.reply, suggestions: turn.suggestions };
    }
  }, turn.reply);
  return finishTurn(ctx, s, r);
}

// ----------------------------------------------------------------- ads

const PLATFORM_ASPECT = { tiktok: '9:16', reels: '9:16', shorts: '9:16', youtube: '16:9', feed: '4:5' } as const;

async function proposeConcepts(ctx: AppContext, state: AdState): Promise<AdConcept[]> {
  const b = state.business ?? {};
  const lang = b.language ?? state.lang ?? 'en';
  const lengthSec = b.lengthSec && b.lengthSec <= 20 ? 15 : (b.lengthSec ?? 30) <= 45 ? 30 : 60;
  const res = await ctx.director.converse(
    {
      tier: 'smart',
      system: CONCEPTS_SYSTEM,
      prompt: `Business: ${JSON.stringify(b)}\nPlatform: ${b.platform ?? 'reels'}; length: ${lengthSec} s; language for all text: ${LANG_NAME[lang]}\nProduct photos: ${(state.productAssetIds ?? []).length} (the product must look exactly like them)\nWebsite notes:\n${(state.pages ?? []).map((p) => p.text).join('\n\n').slice(0, 6000) || 'none'}`,
      schema: adConceptsSchema,
      maxTokens: 6000,
    },
    () => ({
      concepts: [
        { title: 'Story', angle: 'Emotional moment with the product', hook: `A close-up that makes you look twice`, story: `A real customer moment with ${b.name ?? 'the product'}: ${b.about ?? b.offer ?? ''}`.trim(), voiceover: [b.offer ?? b.about ?? b.name ?? ''].filter(Boolean), cta: b.name ?? '', musicMood: 'warm, uplifting', lengthSec },
        { title: 'Demo', angle: 'Show how it works', hook: 'The result first, then how', story: `Hands using ${b.products ?? b.name ?? 'the product'} step by step, crisp studio light.`, voiceover: [b.offer ?? b.name ?? ''].filter(Boolean), cta: b.name ?? '', musicMood: 'modern, rhythmic', lengthSec },
        { title: 'Bold', angle: 'Fast, punchy, scroll-stopping', hook: 'A quick, surprising cut', story: `Dynamic close-ups of ${b.products ?? b.name ?? 'the product'} with bold colour and motion.`, voiceover: [b.offer ?? b.name ?? ''].filter(Boolean), cta: b.name ?? '', musicMood: 'energetic', lengthSec },
      ],
    }),
  );
  return res.concepts.slice(0, 3).map((c) => ({ ...c, lengthSec: Math.min(60, Math.max(15, Math.round(c.lengthSec || lengthSec))) }));
}

function adBrief(state: AdState, c: AdConcept): MovieBrief | null {
  const b = state.business ?? {};
  const lang = b.language ?? state.lang ?? 'en';
  const products = (state.references ?? []).filter((r) => (state.productAssetIds ?? []).includes(r.assetId)).map((r) => r.token);
  const logo = (state.references ?? []).find((r) => r.note === 'brand logo')?.token;
  const idea = [
    `Video advertisement for ${b.name ?? 'the business'}${b.about ? ` — ${b.about}` : ''}.`,
    b.offer && `What is advertised: ${b.offer}.`,
    b.audience && `Audience: ${b.audience}.`,
    `Concept "${c.title}": ${c.story}`,
    `Hook in the first 2 seconds: ${c.hook}.`,
    products.length && `Show the product exactly as in ${products.join(', ')}.`,
    `Voice-over by a Narrator (exact lines, in order): ${c.voiceover.map((l) => `"${l}"`).join(' ')}.`,
    `End with the call to action: "${c.cta}".`,
    logo && `Final shot (3 seconds): "Logo end card" showing the brand logo (${logo}).`,
    'The video model must not draw logos or any on-screen text in the other shots; the logo end card and the CTA text are made in editing.',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 3900);
  return buildBrief(state, { idea, lengthSec: c.lengthSec, aspectRatio: PLATFORM_ASPECT[b.platform ?? 'reels'], style: 'commercial', genre: 'commercial', language: lang, withDialogue: true, withMusic: true }, lang);
}

async function makeAd(ctx: AppContext, user: SessionLike, s: Session, state: AdState, index: number, key: string): Promise<Record<string, unknown> | null> {
  const c = state.concepts?.[index];
  if (!c) return null;
  const brief = adBrief(state, c);
  if (!brief) return null;
  if (s.projectId) {
    const generated = await ctx.db.select({ id: shots.id }).from(shots).where(and(eq(shots.projectId, s.projectId), sql`${shots.currentAssetId} is not null`)).limit(1);
    // A new ad after a finished one starts a new project (the finished ad is kept).
    if (generated.length) await saveSession(ctx, s, { projectId: null });
  }
  return screenplayStep(ctx, user, s, state, brief, key, { kind: 'ad', settings: { ad: { brand: state.business?.name ?? '', cta: c.cta, logoAssetId: state.logoAssetId ?? null, website: state.business?.website ?? null, concept: c.title } } });
}

async function adTurn(ctx: AppContext, user: SessionLike, s: Session, state: AdState, context: string, content: string, stage: string) {
  const lang = state.lang ?? 'en';
  const turn = await ctx.director.converse({ system: AD_SYSTEM, prompt: context, schema: adTurnSchema }, () => {
    const pick = content.match(/\b([1-3])\b/);
    if (state.concepts?.length && pick) return { reply: T.making[lang], action: 'make_ad' as const, business: {}, conceptIndex: Number(pick[1]) - 1, revision: '', suggestions: [] };
    if (s.projectId && APPROVE.test(content)) return { reply: T.approved[lang], action: 'show_budget' as const, business: {}, conceptIndex: -1, revision: '', suggestions: [] };
    return { reply: T.concepts[lang], action: 'propose_concepts' as const, business: state.business?.name ? {} : { name: content.slice(0, 60), about: content }, conceptIndex: -1, revision: '', suggestions: [] };
  });
  state.business = { ...state.business, ...Object.fromEntries(Object.entries(turn.business).filter(([, v]) => v !== undefined && v !== '')) };
  const key = `chat:${s.id}:${Date.now()}`;
  const r = await attempt(async () => {
    switch (turn.action) {
      case 'propose_concepts':
        state.concepts = await proposeConcepts(ctx, state);
        return { reply: turn.reply || T.concepts[lang], card: { type: 'concepts', concepts: state.concepts }, suggestions: [] };
      case 'make_ad': {
        if (stage === 'generating') return { reply: turn.reply, suggestions: turn.suggestions };
        const card = await makeAd(ctx, user, s, state, turn.conceptIndex, key);
        return card ? { reply: turn.reply || T.making[lang], card, suggestions: [] } : { reply: turn.reply, suggestions: turn.suggestions };
      }
      case 'revise_screenplay': {
        if (!s.projectId) return { reply: turn.reply, suggestions: turn.suggestions };
        const job = await replanMovie(ctx, user, s.projectId, { revision: turn.revision || content, idempotencyKey: key });
        return { reply: turn.reply, card: { type: 'screenplay', projectId: s.projectId, planJobId: job.id }, suggestions: [] };
      }
      case 'show_budget':
        if (!s.projectId || stage === 'writing') return { reply: turn.reply, suggestions: turn.suggestions };
        return { reply: turn.reply || T.approved[lang], card: { type: 'budget', projectId: s.projectId }, suggestions: [] };
      default:
        return { reply: turn.reply, suggestions: turn.suggestions };
    }
  }, turn.reply);
  return finishTurn(ctx, s, r);
}

// ----------------------------------------------------------------- buttons (no model call)

export async function chatAction(ctx: AppContext, user: SessionLike, sessionId: string, a: { type: 'approve_screenplay' | 'generation_started' | 'choose_concept' | 'new_concepts'; index?: number }) {
  const s = await ownedSession(ctx, user, sessionId);
  const state = { ...(s.state as AdState) };
  const lang = state.lang ?? 'en';
  if (thinking(state)) throw conflict(T.busy[lang]);
  let msg;
  switch (a.type) {
    case 'approve_screenplay':
      if (!s.projectId) throw badRequest('No screenplay yet');
      msg = await addMessage(ctx, s.id, { role: 'assistant', content: T.approved[lang], card: { type: 'budget', projectId: s.projectId } });
      break;
    case 'generation_started':
      if (!s.projectId) throw badRequest('No film yet');
      msg = await addMessage(ctx, s.id, { role: 'assistant', content: T.started[lang], card: { type: 'film', projectId: s.projectId } });
      break;
    case 'choose_concept': {
      if (s.kind !== 'ad') throw badRequest('Not an ad conversation');
      const card = await makeAd(ctx, user, s, state, a.index ?? 0, `chat:${s.id}:concept:${a.index}:${Date.now()}`);
      if (!card) throw badRequest('That idea is no longer available');
      msg = await addMessage(ctx, s.id, { role: 'assistant', content: `${T.making[lang]} “${state.concepts![a.index ?? 0]!.title}”`, card });
      break;
    }
    case 'new_concepts':
      if (s.kind !== 'ad') throw badRequest('Not an ad conversation');
      await startTurn(ctx, s, state, { action: 'new_concepts' });
      return null;
  }
  await saveSession(ctx, s, { state: state as Record<string, unknown> });
  return msg;
}
