import { z } from 'zod';
import { composePrompt, getTemplate, scaleBeats, fillTemplate, type MovieBrief, CAMERA_PRESETS } from '@framecraft/shared';
import { LlmError, type LlmClient, type LlmImage, type LlmUsage } from './llm';

/**
 * AI Director — planning layer between the user's idea and paid video generation.
 *
 * Every result carries `source`: 'llm' when Claude produced it, 'offline' when
 * the deterministic planner did (no LLM configured or the LLM failed). The UI
 * labels offline plans so nobody mistakes them for AI-written content.
 */

export type Sourced<T> = T & { source: 'llm' | 'offline'; usage?: LlmUsage; notice?: string };

// ----------------------------------------------------------------- schemas

export const enhancedPromptSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string(),
  rationale: z.string(),
});

const conceptShotSchema = z.object({ description: z.string(), durationSec: z.number(), camera: z.string() });
export const conceptsSchema = z.object({
  concepts: z.array(
    z.object({
      title: z.string(),
      logline: z.string(),
      hook: z.string(),
      visualStyle: z.string(),
      shots: z.array(conceptShotSchema),
      whyItWorks: z.string(),
    }),
  ),
});
export type Concept = z.infer<typeof conceptsSchema>['concepts'][number];

export const socialCopySchema = z.object({
  hooks: z.array(z.string()),
  titles: z.array(z.string()),
  caption: z.string(),
  hashtags: z.array(z.string()),
  script: z.string(),
});
export type SocialCopy = z.infer<typeof socialCopySchema>;

export const moviePlanSchema = z.object({
  title: z.string(),
  logline: z.string(),
  genre: z.string(),
  characters: z.array(z.object({ key: z.string(), name: z.string(), description: z.string(), appearance: z.string(), clothing: z.string(), voiceStyle: z.string(), gender: z.enum(['male', 'female', 'unknown']).optional(), referenceTokens: z.array(z.string()) })),
  locations: z.array(z.object({ key: z.string(), name: z.string(), description: z.string(), referenceTokens: z.array(z.string()) })),
  scenes: z.array(
    z.object({
      title: z.string(),
      synopsis: z.string(),
      locationKey: z.string(),
      shots: z.array(
        z.object({
          description: z.string(),
          prompt: z.string(),
          durationSec: z.number(),
          shotType: z.string(),
          camera: z.string(),
          characterKeys: z.array(z.string()),
          dialogue: z.array(z.object({ speakerKey: z.string(), line: z.string() })),
          sfx: z.string(),
          needsNativeAudio: z.boolean(),
          referenceTokens: z.array(z.string()),
        }),
      ),
    }),
  ),
  music: z.object({ mood: z.string(), prompt: z.string() }),
});
export type MoviePlan = z.infer<typeof moviePlanSchema>;

const LANG_NAME: Record<string, string> = { en: 'English', ka: 'Georgian', ru: 'Russian' };

const SYSTEM_PROMPTS = {
  enhance: `You are a senior cinematographer writing prompts for AI video models (Kling, Veo, Seedance, Wan, LTX, Runway).
Rewrite the user's idea into one precise, visual prompt that a video model can execute reliably:
- Describe subject, action, setting, lighting, camera movement and mood in concrete visual language.
- Keep the user's intent, subjects and any quoted dialogue exactly. Never add real people, brands or text overlays they did not ask for.
- One continuous shot unless the user clearly describes several. Avoid on-screen text requests (models render text poorly).
- Keep it under 120 words. Write the prompt in English even if the user wrote in another language, but keep quoted dialogue in its original language.
negativePrompt: short comma-separated list of artifacts to avoid (e.g. warped hands, flicker, text). rationale: one sentence.`,
  concepts: `You are a creative director for short-form social video. From one idea, propose exactly three clearly different creative directions
(e.g. cinematic, playful/UGC, bold/graphic). Each needs a scroll-stopping hook for the first 2 seconds, a visual style, and a short shot list whose
durations add up to the requested length. Shots must be visual and filmable by an AI video model; avoid on-screen text in shots.`,
  social: `You write high-performing social media copy. Be specific to the topic, platform-native and honest — no fake claims, prices, testimonials or statistics.
hooks: 5 opening lines under 12 words. titles: 5 short titles. caption: platform-appropriate caption. hashtags: 8-12 relevant hashtags without spaces, each starting with #.
script: a short voice-over script that fits the requested duration (about 2.3 words per second).`,
  screenplay: `You are a film director planning an AI-generated short film. Produce a complete production plan:
- characters: stable keys (c1, c2...), and appearance + clothing written so they can be repeated verbatim in every shot for visual consistency. Set gender (male/female) so each character gets a fitting voice.
- locations: stable keys (l1, l2...).
- scenes broken into shots of 4-10 seconds; total shot duration must match the requested film length within 10%.
- each shot.prompt must be self-contained for a video model: restate the characters' appearance and clothing, the location, lighting, camera and action. No on-screen text.
- dialogue lines are short (they must fit the shot duration at ~2.5 words/second). Set needsNativeAudio true only for shots with dialogue or crucial synced sound.
- Brand logos: never ask the video model to draw a logo or any on-screen text. When the brief wants the brand logo shown, plan it as its own short final shot whose description starts with "Logo end card" and assign the logo photo's token to that shot (it is built from the exact logo file).
- Do not depict real public figures. Keep content suitable for general audiences unless the brief says otherwise.
- camera: one of ${CAMERA_PRESETS.map((c) => c.key).join(', ')}.
- referenceTokens: when the user supplies reference photos (photo1, photo2…), assign each token to the character, location or shot (for objects/products) it depicts, following the user's text. Describe what the photo shows in appearance/clothing/description so prompts stay consistent. Never write the token itself ("photo1") inside a prompt — describe the subject instead. Use [] when no photo applies.`,
};

// ----------------------------------------------------------------- director

export class Director {
  constructor(private readonly llm: LlmClient) {}

  get llmAvailable() {
    return this.llm.available;
  }

  private async tryLlm<T>(fn: () => Promise<{ data: T; usage: LlmUsage }>, fallback: () => T): Promise<Sourced<T>> {
    if (!this.llm.available) return { ...fallback(), source: 'offline', notice: 'AI Director not configured — offline planner used.' };
    try {
      const { data, usage } = await fn();
      return { ...data, source: 'llm', usage };
    } catch (err) {
      const reason = err instanceof LlmError ? err.message : 'AI Director unavailable';
      return { ...fallback(), source: 'offline', notice: `${reason} Offline planner used instead.` };
    }
  }

  async enhancePrompt(p: { prompt: string; style?: string; camera?: string; lighting?: string; lens?: string; colorGrade?: string; mood?: string; shotType?: string; includeCamera?: boolean; aspectRatio: string; durationSec: number; characters?: string[] }) {
    const base = composePrompt(p.prompt, p, { includeCamera: p.includeCamera });
    const withCharacters = p.characters?.length ? `${base} Characters: ${p.characters.join('; ')}.` : base;
    return this.tryLlm(
      () =>
        this.llm.structured({
          tier: 'fast',
          system: SYSTEM_PROMPTS.enhance,
          schema: enhancedPromptSchema,
          prompt: `Idea and creative directives:\n${withCharacters}\n\nFormat: ${p.aspectRatio}, ${p.durationSec} seconds.`,
          maxTokens: 1500,
        }),
      () => ({ prompt: withCharacters, negativePrompt: 'blurry, distorted faces, warped hands, flicker, watermark, on-screen text', rationale: 'Structured directives appended to your description.' }),
    );
  }

  async concepts(p: { idea: string; platform: string; durationSec: number; templateKey?: string; language: string }) {
    const template = p.templateKey ? getTemplate(p.templateKey) : undefined;
    const res = await this.tryLlm(
      () =>
        this.llm.structured({
          tier: 'fast',
          system: SYSTEM_PROMPTS.concepts,
          schema: conceptsSchema,
          prompt: `Idea: ${p.idea}\nPlatform: ${p.platform}\nTotal length: ${p.durationSec}s\n${template ? `Template: ${template.name} — beats: ${template.beats.map((b) => b.label).join(' → ')}\n` : ''}Write titles, hooks and descriptions in ${LANG_NAME[p.language] ?? 'English'}.`,
          maxTokens: 4000,
        }),
      () => ({ concepts: offlineConcepts(p.idea, p.durationSec, template?.beats) }),
    );
    res.concepts = res.concepts.slice(0, 3).map((c) => ({ ...c, shots: normalizeDurations(c.shots, p.durationSec) }));
    return res;
  }

  async socialCopy(p: { topic: string; platform: string; tone?: string; language: string; durationSec?: number }) {
    return this.tryLlm(
      () =>
        this.llm.structured({
          tier: 'fast',
          system: SYSTEM_PROMPTS.social,
          schema: socialCopySchema,
          prompt: `Topic: ${p.topic}\nPlatform: ${p.platform}\nTone: ${p.tone ?? 'authentic, energetic'}\nVideo length: ${p.durationSec ?? 15}s\nLanguage: ${LANG_NAME[p.language] ?? 'English'}`,
          maxTokens: 2500,
        }),
      () => offlineSocialCopy(p.topic, p.platform, p.durationSec ?? 15),
    );
  }

  async screenplay(brief: MovieBrief, images: LlmImage[] = []) {
    const refs = brief.references.length
      ? `\nReference photos supplied by the user (attached above, in order): ${brief.references.map((r) => `${r.token}${r.note ? ` — ${r.note}` : ''}`).join('; ')}. Use them for the characters, places or objects the story text connects them to; if the text does not mention a photo, use it where it fits best.`
      : '\nNo reference photos: invent the characters, locations and look yourself.';
    const res = await this.tryLlm(
      () =>
        this.llm.structured({
          tier: 'smart',
          system: SYSTEM_PROMPTS.screenplay,
          schema: moviePlanSchema,
          prompt: `Film idea: ${brief.idea}\nLength: ${brief.lengthSec} seconds\nAspect ratio: ${brief.aspectRatio}\nVisual style: ${brief.style}\nGenre: ${brief.genre ?? 'choose the best fit'}\nDialogue: ${brief.withDialogue ? `yes, written in ${LANG_NAME[brief.language] ?? 'English'}` : 'no dialogue'}\nMusic: ${brief.withMusic ? 'yes' : 'no'}${refs}`,
          images,
          maxTokens: 32000,
        }),
      () => offlineScreenplay(brief),
    );
    return { ...res, ...sanitizePlan(res, brief) };
  }

  /** Apply the user's requested changes to an existing plan (keeps everything else as it is). */
  async revisePlan(current: MoviePlan, instructions: string, brief: MovieBrief) {
    const res = await this.tryLlm(
      () =>
        this.llm.structured({
          tier: 'smart',
          system: `${SYSTEM_PROMPTS.screenplay}\n\nYou are revising an existing plan. Apply the user's requested changes faithfully and completely; keep every other character, location, scene, shot, key and line exactly as it is unless the change requires otherwise. Return the complete updated plan.`,
          schema: moviePlanSchema,
          prompt: `Current plan (JSON):\n${JSON.stringify(current)}\n\nRequested changes (the user's words):\n${instructions}\n\nTarget length: ${brief.lengthSec} seconds. Dialogue language: ${LANG_NAME[brief.language] ?? 'English'}.`,
          maxTokens: 32000,
        }),
      () => current,
    );
    return { ...res, ...sanitizePlan(res, brief) };
  }

  /** One structured conversational turn (Movie Maker / Ad Studio chat). `fallback` answers when no LLM is configured. */
  async converse<S extends z.ZodType>(p: { system: string; prompt: string; schema: S; tier?: 'fast' | 'smart'; images?: LlmImage[]; maxTokens?: number }, fallback: () => z.infer<S>) {
    return this.tryLlm(() => this.llm.structured({ tier: p.tier ?? 'fast', system: p.system, prompt: p.prompt, schema: p.schema, images: p.images, maxTokens: p.maxTokens ?? 3000 }), fallback);
  }
}

// ----------------------------------------------------------------- offline planners

function normalizeDurations<T extends { durationSec: number }>(shots: T[], total: number): T[] {
  if (!shots.length) return shots;
  const sum = shots.reduce((s, x) => s + Math.max(1, x.durationSec), 0);
  return shots.map((s) => ({ ...s, durationSec: Math.max(2, Math.round((Math.max(1, s.durationSec) / sum) * total)) }));
}

function offlineConcepts(idea: string, durationSec: number, beats?: { label: string; seconds: number; guidance: string }[]): Concept[] {
  const clean = idea.trim().replace(/\.$/, '');
  const parts = beats?.length ? scaleBeats(beats, durationSec) : scaleBeats([{ label: 'Hook', seconds: 3, guidance: '' }, { label: 'Story', seconds: 7, guidance: '' }, { label: 'Payoff', seconds: 5, guidance: '' }], durationSec);
  const mk = (title: string, style: string, hook: string, cams: string[], why: string): Concept => ({
    title,
    logline: `${clean} — ${title.toLowerCase()} treatment.`,
    hook,
    visualStyle: style,
    shots: parts.map((b, i) => ({ description: `${b.label}: ${clean}${b.guidance ? `. ${fillTemplate(b.guidance, {})}` : ''}`.replace(/\s+/g, ' '), durationSec: b.seconds, camera: cams[i % cams.length]! })),
    whyItWorks: why,
  });
  return [
    mk('Cinematic', 'Filmic lighting, shallow depth of field, slow deliberate camera moves', `Open on a striking close-up that teases: ${clean}`, ['dolly_in', 'tracking', 'crane'], 'Premium look builds trust and stops the scroll with beauty.'),
    mk('Playful UGC', 'Handheld, natural light, authentic creator feel', `Start mid-action with a surprising moment from: ${clean}`, ['handheld', 'close_up', 'medium'], 'Feels native to the feed and invites comments.'),
    mk('Bold Graphic', 'High contrast, saturated colors, punchy fast cuts', `Smash-cut reveal: ${clean}`, ['static', 'orbit', 'wide'], 'Strong graphic frames read instantly on small screens.'),
  ];
}

function offlineSocialCopy(topic: string, platform: string, durationSec: number): SocialCopy {
  const t = topic.trim().replace(/\.$/, '');
  const words = t.split(/\s+/).filter((w) => w.length > 3).slice(0, 6);
  const tags = [...new Set(words.map((w) => `#${w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}`).filter((w) => w.length > 2))];
  const platformTag = { tiktok: '#fyp', reels: '#reels', shorts: '#shorts', facebook: '#reels' }[platform] ?? '#video';
  return {
    hooks: [`Wait for the end…`, `Nobody talks about this: ${t}`, `POV: ${t}`, `You need to see this`, `This changed everything`],
    titles: [t, `${t} in ${durationSec} seconds`, `The story of ${t}`, `Watch this: ${t}`, `${t} ✨`].map((x) => x.slice(0, 80)),
    caption: `${t}. Made with AI. What do you think? 👇`,
    hashtags: [...tags, platformTag, '#aivideo', '#creator'].slice(0, 10),
    script: `${t}. Here's what makes it special — in just ${durationSec} seconds. Watch till the end.`,
  };
}

function offlineScreenplay(brief: MovieBrief): MoviePlan {
  const idea = brief.idea.trim().replace(/\.$/, '');
  const sceneCount = Math.min(12, Math.max(2, Math.round(brief.lengthSec / 20)));
  const perScene = brief.lengthSec / sceneCount;
  const shotLen = perScene >= 18 ? 6 : 5;
  const roleMatch = idea.match(/\b(?:a|an|the)\s+([a-z]+(?:\s[a-z]+)?)\s+(?:who|investigat|discover|find|search|travel|fight|meet|explor|tr(?:y|ies)|must|is)/i);
  const role = roleMatch?.[1] ? roleMatch[1].replace(/\b\w/g, (c) => c.toUpperCase()) : 'The Protagonist';
  const refs = classifyReferences(brief);
  const charRefs = refs.filter((r) => r.kind === 'character');
  const characters: MoviePlan['characters'] = charRefs.length
    ? charRefs.slice(0, 5).map((r, i) => ({
        key: `c${i + 1}`,
        name: r.note ? r.note.slice(0, 40) : i === 0 ? (role.startsWith('The') ? role : `The ${role}`) : `Character ${i + 1}`,
        description: `${i === 0 ? 'Main character' : 'Character'}, based on the user’s reference photo.`,
        appearance: `looks exactly like the person in the reference photo${r.note ? ` (${r.note})` : ''}`,
        clothing: 'as in the reference photo',
        voiceStyle: 'natural',
        referenceTokens: [r.token],
      }))
    : [{ key: 'c1', name: role.startsWith('The') ? role : `The ${role}`, description: `Main character of: ${idea}`, appearance: 'distinctive, consistent appearance (edit to describe face, hair and age)', clothing: 'signature outfit (edit to describe)', voiceStyle: 'calm, determined', referenceTokens: [] }];
  const locRefs = refs.filter((r) => r.kind === 'location');
  const locations: MoviePlan['locations'] = locRefs.length
    ? locRefs.map((r, i) => ({ key: `l${i + 1}`, name: r.note ? r.note.slice(0, 40) : `Location ${i + 1}`, description: r.note ? `${r.note}, as in the user’s reference photo.` : 'The place in the user’s reference photo.', referenceTokens: [r.token] }))
    : [{ key: 'l1', name: 'Main location', description: `Primary setting of: ${idea}`, referenceTokens: [] }];
  const objectTokens = refs.filter((r) => r.kind === 'object').map((r) => r.token);
  const lead = characters[0]!;
  const arc = ['Opening', 'Inciting moment', 'Rising tension', 'Discovery', 'Confrontation', 'Turning point', 'Climax', 'Resolution', 'Epilogue', 'Aftermath', 'Reflection', 'Final image'];
  const scenes: MoviePlan['scenes'] = [];
  for (let i = 0; i < sceneCount; i++) {
    const beat = i === 0 ? 'Opening' : i === sceneCount - 1 ? 'Resolution' : arc[Math.min(arc.length - 2, i)]!;
    const n = Math.max(1, Math.round(perScene / shotLen));
    const shots: MoviePlan['scenes'][number]['shots'] = [];
    for (let j = 0; j < n; j++) {
      const type = j === 0 ? 'Wide' : j % 2 ? 'Medium' : 'Close-Up';
      const camera = j === 0 ? (i === 0 ? 'aerial' : 'dolly_in') : j % 2 ? 'tracking' : 'close_up';
      const dialogue = brief.withDialogue && j === n - 1 && i > 0 ? [{ speakerKey: 'c1', line: '(write a short line of dialogue)' }] : [];
      shots.push({
        description: `${beat} — ${type.toLowerCase()} shot ${j + 1}`,
        prompt: `${type} shot. ${beat} of the story: ${idea}. ${lead.name}, ${lead.appearance}, wearing ${lead.clothing}. ${brief.style} style.`,
        durationSec: shotLen,
        shotType: type,
        camera,
        characterKeys: characters.map((c) => c.key),
        dialogue,
        sfx: '',
        needsNativeAudio: dialogue.length > 0,
        referenceTokens: objectTokens,
      });
    }
    // Scenes rotate through the user's location photos (or the single invented location).
    scenes.push({ title: `Scene ${i + 1}: ${beat}`, synopsis: `${beat} — ${idea}`, locationKey: locations[i % locations.length]!.key, shots });
  }
  return {
    title: idea.length > 48 ? `${idea.slice(0, 45)}…` : idea,
    logline: idea,
    genre: brief.genre ?? 'Drama',
    characters,
    locations,
    scenes,
    music: { mood: 'cinematic, building tension', prompt: `Cinematic instrumental score for: ${idea}` },
  };
}

// Unicode-aware word matching (\b is ASCII-only and fails on Georgian/Cyrillic).
const words = (list: string) => new RegExp(`(?<!\\p{L})(?:${list})(?!\\p{L})`, 'iu');
const LOCATION_WORDS = words(
  'houses?|homes?|rooms?|city|street|town|village|forest|beach|office|kitchen|caf[eé]|restaurant|shop|store|place|location|building|apartment|garden|park|mountains?|lake|sea|landscape|background|interior|studio|სახლ\\p{L}*|ქალაქ\\p{L}*|ოთახ\\p{L}*|ქუჩ\\p{L}*|სოფ\\p{L}*|ტყე\\p{L}*|дом\\p{L}*|город\\p{L}*|комнат\\p{L}*|улиц\\p{L}*|квартир\\p{L}*|лес\\p{L}*',
);
const OBJECT_WORDS = words(
  'products?|bottle|car|bag|phone|logo|item|object|watch|shoes?|cup|mug|gift|box|package|perfume|bike|guitar|book|პროდუქტ\\p{L}*|მანქან\\p{L}*|ჩანთ\\p{L}*|ბოთლ\\p{L}*|товар\\p{L}*|машин\\p{L}*|сумк\\p{L}*|бутылк\\p{L}*',
);
const PERSON_WORDS = words('he|she|man|woman|person|girl|boy|dog|cat|hero|heroine|detective|character|friend|mother|father|kid|child|გმირ\\p{L}*|კაც\\p{L}*|ქალ\\p{L}*|გოგო\\p{L}*|ბიჭ\\p{L}*|ძაღლ\\p{L}*|мужчин\\p{L}*|женщин\\p{L}*|девушк\\p{L}*|собак\\p{L}*');

/**
 * Offline heuristic: decide whether each reference photo is a character, a location or an
 * object, from the sentence that mentions its token (and the user's note).
 */
export function classifyReferences(brief: Pick<MovieBrief, 'idea' | 'references'>) {
  const sentences = brief.idea.split(/(?<=[.!?…])\s+|\n+/);
  return brief.references.map((r) => {
    const mention = sentences.find((s) => s.toLowerCase().includes(r.token)) ?? '';
    // Words right around the token decide first ("…lives in a house like photo2"), then the note.
    const at = mention.toLowerCase().indexOf(r.token);
    // Only the words *before* the token describe it ("a house like photo2"); words after usually describe what it does.
    const near = at >= 0 ? mention.slice(Math.max(0, at - 30), at) : '';
    const classify = (text: string) => (LOCATION_WORDS.test(text) ? 'location' : OBJECT_WORDS.test(text) ? 'object' : PERSON_WORDS.test(text) ? 'character' : undefined);
    // The user's own note is the most explicit signal, then the words closest to the token.
    const kind: 'character' | 'location' | 'object' = (r.note && classify(r.note)) || classify(near) || 'character';
    return { ...r, kind };
  });
}

/** Clamp durations, fix dangling keys, map photo tokens, and keep the plan within ±15% of the requested length. */
function sanitizePlan(plan: MoviePlan, brief: MovieBrief): MoviePlan {
  const charKeys = new Set(plan.characters.map((c) => c.key));
  const locKeys = new Set(plan.locations.map((l) => l.key));
  const known = new Set(brief.references.map((r) => r.token));
  const keepTokens = (t: string[] | undefined) => [...new Set((t ?? []).map((x) => x.toLowerCase()).filter((x) => known.has(x)))];
  // Video models never see "photo1": replace tokens with the name of what they depict.
  const label = new Map<string, string>();
  for (const c of plan.characters) for (const t of keepTokens(c.referenceTokens)) label.set(t, c.name);
  for (const l of plan.locations) for (const t of keepTokens(l.referenceTokens)) label.set(t, l.name);
  for (const r of brief.references) if (!label.has(r.token)) label.set(r.token, r.note ?? 'the object shown in the reference image');
  const detoken = (text: string) => text.replace(/\bphoto([1-9]|1[0-2])\b/gi, (m) => label.get(m.toLowerCase()) ?? 'the reference subject');
  const characters = plan.characters.map((c) => ({ ...c, referenceTokens: keepTokens(c.referenceTokens), appearance: detoken(c.appearance), description: detoken(c.description) }));
  const locations = plan.locations.map((l) => ({ ...l, referenceTokens: keepTokens(l.referenceTokens), description: detoken(l.description) }));
  const scenes = plan.scenes
    .filter((s) => s.shots.length)
    .map((s) => ({
      ...s,
      synopsis: detoken(s.synopsis),
      locationKey: locKeys.has(s.locationKey) ? s.locationKey : (plan.locations[0]?.key ?? 'l1'),
      shots: s.shots.map((sh) => ({
        ...sh,
        prompt: detoken(sh.prompt),
        description: detoken(sh.description),
        durationSec: Math.min(10, Math.max(3, Math.round(sh.durationSec))),
        characterKeys: sh.characterKeys.filter((k) => charKeys.has(k)),
        dialogue: sh.dialogue.filter((d) => d.line.trim()),
        camera: CAMERA_PRESETS.some((c) => c.key === sh.camera) ? sh.camera : 'static',
        referenceTokens: keepTokens(sh.referenceTokens),
      })),
    }));
  plan = { ...plan, title: detoken(plan.title), logline: detoken(plan.logline), characters, locations };
  const total = scenes.reduce((a, s) => a + s.shots.reduce((b, x) => b + x.durationSec, 0), 0);
  if (total > brief.lengthSec * 1.15) {
    // Trim trailing shots until within budget (keeps the last scene's final shot).
    let excess = total - brief.lengthSec;
    for (let i = scenes.length - 1; i >= 0 && excess > 0; i--) {
      const shots = scenes[i]!.shots;
      while (shots.length > 1 && excess > 0) excess -= shots.splice(shots.length - 2, 1)[0]!.durationSec;
    }
  }
  return { ...plan, scenes: scenes.filter((s) => s.shots.length) };
}
