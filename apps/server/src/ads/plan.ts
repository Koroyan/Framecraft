import { z } from 'zod';
import { AD_MODES, adConceptSchema, adMode, adPlanSchema, adStyle, AI_EDIT_MODES, CAMERA_MOVES, endCardSeconds, modeForAngle, type AdBrief, type AdConcept, type AdMode, type AdPlan, type CameraMove } from '@framecraft/shared';
import type { AppContext } from '../context';
import type { footageSegments } from '../db/schema';

/*
 * AI Creative Director for real-footage ads, in two steps:
 *  1. concepts — three genuinely different treatments (angle, structure, pacing, music, voice);
 *  2. storyboard — the chosen concept cut from the segment catalog, shot by shot (framing, camera,
 *     light, sound, text, voice).
 * The server validates everything: only real segments, cuts inside them, no repeated intervals
 * (a reuse must be a different crop), target length, hook first; in "original" mode generative
 * enhancements are removed. Only approved brand facts may be stated.
 */

type Segment = typeof footageSegments.$inferSelect;
export type BrandContext = {
  name: string;
  voice: string;
  products: string;
  ctas: string[];
  slogans: string[];
  offers: string;
  website: string | null;
  description?: string;
  audience?: string;
  restrictions?: string;
  vocabulary?: string[];
  /** Approved facts from the brand knowledge (website, manual). */
  facts?: string[];
  product?: { name: string; description: string; claims: string[]; price: string } | null;
} | null;

const LANG = { ka: 'Georgian', en: 'English', ru: 'Russian' } as const;
const MOVES = CAMERA_MOVES.map((c) => c.key) as [CameraMove, ...CameraMove[]];

function brandLines(brand: BrandContext, brief: AdBrief): string {
  if (!brand) return 'No brand profile — keep the CTA generic unless the brief gives one; state no facts beyond the brief.';
  return [
    `Brand: ${brand.name}.${brand.description ? ` ${brand.description}` : ''}`,
    brand.product ? `Product advertised: ${brand.product.name}. ${brand.product.description}${brand.product.claims.length ? ` Approved claims: ${brand.product.claims.join(' | ')}.` : ''}${brand.product.price ? ` Price: ${brand.product.price}.` : ''} Advertise ONLY this product.` : `Products: ${brand.products || 'n/a'}.`,
    brand.facts?.length ? `Approved facts (the only facts you may state): ${brand.facts.join(' | ')}` : '',
    `Voice: ${brand.voice || 'n/a'}. Approved slogans: ${brand.slogans.join(' | ') || 'n/a'}. CTAs: ${brand.ctas.join(' | ') || 'n/a'}. Offers: ${brand.offers || 'none given'}. Website: ${brand.website ?? 'n/a'}.`,
    brand.audience || brief.audience ? `Audience: ${brief.audience || brand.audience}.` : '',
    brand.vocabulary?.length ? `Preferred words: ${brand.vocabulary.join(', ')}.` : '',
    brand.restrictions ? `NEVER: ${brand.restrictions}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function catalogOf(segs: Segment[]) {
  return segs
    .map((s, i) => {
      const sc = s.scores as Record<string, number>;
      const m = s.metrics as Record<string, number>;
      const photo = (s.tags ?? []).includes('photo');
      return `S${i + 1}: ${photo ? 'photo' : `${(s.endSec - s.startSec).toFixed(1)} s`} · ${s.description || '(no description)'} · tags: ${(s.tags ?? []).join(', ')} · overall ${sc.overall ?? '?'}, product ${sc.product ?? '?'}, close-up ${sc.closeup ?? '?'}, appeal ${sc.appeal ?? '?'}, quality ${sc.quality ?? '?'}, motion ${m.motion ?? '?'}${(m.shake ?? 0) > 0.5 ? ' · shaky' : ''}${s.duplicateOf ? ' · near-duplicate' : ''}`;
    })
    .join('\n');
}

// ------------------------------------------------------------------ 1. concepts

const conceptsSchema = z.object({ concepts: z.array(adConceptSchema.omit({ recommended: true })).min(1).max(4), recommended: z.string() });

const CONCEPT_SYSTEM = `You are the creative director of a top advertising agency. From the client's real footage and approved brand facts, propose THREE genuinely different ad concepts — different angle, structure, pacing, camera language, music and voice, not the same idea with another filter or headline.
Each concept uses a different Creative Director mode (field "mode"), listed with its purpose; choose the three that best fit the product, the footage and the request. If the client asked for a mode, the first concept uses it.
Each concept follows HOOK → INTEREST → PRODUCT VALUE → PAYOFF → CTA, can really be cut from the listed footage, opens on something visually interesting (never a long logo), and invents nothing: no fake testimonials, no exaggerated claims or false urgency, no facts outside the brief and approved brand facts.
style must be one of the listed style keys. Write names, loglines and beats in English; cta in the ad language.`;

const MODE_LIST = AD_MODES.map((m) => `${m.key}: ${m.label} — ${m.purpose}`).join('\n');
const angleOf = (m: AdMode): AdConcept['angle'] => (m.key === 'luxury_commercial' ? 'cinematic_premium' : m.key === 'emotional_story' ? 'emotional_story' : m.key === 'social_sales' ? 'high_energy_social' : m.key === 'behind_the_scenes' ? 'craft_process' : 'other');
/** The mode of a concept (older concepts carry only an angle). */
export const conceptMode = (c: Pick<AdConcept, 'mode' | 'angle'> | null | undefined, fallback?: string | null) => adMode(c?.mode ?? (c ? modeForAngle(c.angle) : fallback));

/** Three distinct concepts; the recommended one comes first. */
export async function generateConcepts(ctx: AppContext, p: { brief: AdBrief; segments: Segment[]; brand: BrandContext; styleKeys: string[] }): Promise<{ concepts: AdConcept[]; source: 'llm' | 'offline' }> {
  const segs = p.segments.filter((s) => s.role === 'footage');
  const prompt = [
    `Client request: ${p.brief.request}`,
    `Objective: ${p.brief.objective}. Length ${p.brief.lengthSec} s · ${p.brief.aspectRatio} · language ${LANG[p.brief.language]} · narration ${p.brief.voiceover ? 'third-person narrator' : 'none'}.`,
    brandLines(p.brand, p.brief),
    `Style keys: ${p.styleKeys.join(', ')}`,
    `Creative Director modes:\n${MODE_LIST}`,
    p.brief.adMode ? `The client chose the mode: ${p.brief.adMode}.` : '',
    `Footage:\n${catalogOf(segs)}`,
  ]
    .filter(Boolean)
    .join('\n');
  const res = await ctx.director.converse({ system: CONCEPT_SYSTEM, prompt, schema: conceptsSchema, tier: 'smart', maxTokens: 5000 }, () => offlineConcepts(p.brief, segs, p.brand));
  const valid = res.concepts.map((c, i) => ({ ...c, mode: conceptMode(c).key, key: c.key.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || `c${i + 1}`, style: p.styleKeys.includes(c.style) ? c.style : p.styleKeys[0]!, recommended: false }));
  // The client's chosen mode is always on offer.
  if (p.brief.adMode && !valid.some((c) => c.mode === p.brief.adMode)) {
    const m = adMode(p.brief.adMode);
    valid.unshift({ key: m.key, name: m.label, angle: angleOf(m), mode: m.key, style: m.style, logline: m.purpose, treatment: m.narrative.map((n) => n.does).join(' → '), hook: m.narrative[0]!.does, beats: [], pacing: `${m.editing.pacing}, ${m.editing.shotSec[0]}–${m.editing.shotSec[1]} s shots`, music: m.editing.music, voiceTone: m.voice, cta: p.brief.cta, whyItFits: 'The mode you chose.', recommended: false });
  }
  const uniq = valid.filter((c, i) => valid.findIndex((x) => x.key === c.key) === i);
  // A style the user picked explicitly wins over the director's recommendation.
  const explicit = (p.brief.adMode ? uniq.find((c) => c.mode === p.brief.adMode) : undefined) ?? (p.brief.style !== 'auto' && p.styleKeys.includes(p.brief.style) ? uniq.find((c) => c.style === p.brief.style) : undefined);
  const rec = explicit ?? uniq.find((c) => c.key === res.recommended) ?? uniq[0]!;
  rec.recommended = true;
  return { concepts: [rec, ...uniq.filter((c) => c !== rec)], source: res.source === 'llm' ? 'llm' : 'offline' };
}

function offlineConcepts(brief: AdBrief, segs: Segment[], brand: BrandContext): z.infer<typeof conceptsSchema> {
  const tags = new Set(segs.flatMap((s) => s.tags ?? []));
  const craft = ['printing', 'painting', 'hands', 'workshop', 'making', 'tools', 'process'].some((t) => tags.has(t));
  const cta = brief.cta || brand?.ctas[0] || '';
  const name = brand?.product?.name ?? brand?.name ?? 'the product';
  const beats = (h: string, i: string, v: string, pay: string, c: string) => [
    { beat: 'hook' as const, idea: h },
    { beat: 'interest' as const, idea: i },
    { beat: 'value' as const, idea: v },
    { beat: 'payoff' as const, idea: pay },
    { beat: 'cta' as const, idea: c },
  ];
  const concepts: z.infer<typeof conceptsSchema>['concepts'] = [
    { key: 'premium', name: 'Luxury Commercial', mode: 'luxury_commercial', angle: 'cinematic_premium', style: 'cinematic_luxury', logline: `${name}, shown like a luxury object.`, treatment: 'Slow, controlled push-ins on the best close-ups, rich warm grade, few words, dissolves on the beat; the full product is held back for a hero shot.', hook: 'The most beautiful close-up detail, slowly revealed.', beats: beats('Macro detail in soft light', 'Glimpses of craft and material', 'Details that make it special', 'Hero shot of the finished product', 'Brand and call to action'), pacing: 'slow, 2.5–4.5 s shots', music: 'slow cinematic strings and soft piano', voiceTone: 'calm, elegant, confident', cta, whyItFits: 'Your close-ups carry a premium look without inventing anything.' },
    craft
      ? { key: 'craft', name: 'Behind-the-Scenes Ad', mode: 'behind_the_scenes', angle: 'craft_process', style: 'behind_scenes', logline: `How ${name} is made — from the first step to the finished piece.`, treatment: 'The real making-of in order: tools and hands, the process, the finishing touches, then the finished product revealed and gifted.', hook: 'Hands at work, mid-action.', beats: beats('Hands at work', 'The process step by step', 'Care and detail in the finishing', 'The finished piece revealed', 'Order yours'), pacing: 'medium, 1.8–3.5 s shots', music: 'acoustic, organic, warm', voiceTone: 'warm, proud of the craft', cta, whyItFits: 'Your footage shows the process — the most convincing proof of quality.' }
      : { key: 'emotional', name: 'Emotional Storytelling', mode: 'emotional_story', angle: 'emotional_story', style: 'emotional', logline: `The feeling behind ${name}.`, treatment: 'A human-centred story: the reason the product exists, a moment of anticipation, the reveal, and a meaningful ending.', hook: 'A human moment or the reason the product exists.', beats: beats('A human moment', 'Anticipation builds', 'What makes it meaningful', 'The reveal and the reaction', 'Make someone happy'), pacing: 'slow, 2.5–5 s shots', music: 'emotional piano building to a warm swell', voiceTone: 'warm, heartfelt', cta, whyItFits: 'Turns the product into a feeling people want to give.' },
    { key: 'social', name: 'Social Media Sales Ad', mode: 'social_sales', angle: 'high_energy_social', style: 'fast_social', logline: `${name} in fifteen fast, scroll-stopping seconds.`, treatment: 'Motion in the first second, quick cuts on action, punchy captions, zoom accents, a clear CTA at the end.', hook: 'Movement or a surprising frame in the first second.', beats: beats('A surprising moving frame', 'Rapid montage of the best moments', 'One clear benefit on screen', 'The product held up proudly', 'Short, direct CTA'), pacing: 'fast, 0.6–1.4 s shots', music: 'upbeat beat', voiceTone: 'punchy, direct', cta, whyItFits: 'Made for TikTok and Reels feeds.' },
  ];
  const r = brief.request.toLowerCase();
  const recommended = /tiktok|reels|fast|energetic|dynamic|სწრაფ|ენერგ/.test(r) ? 'social' : /emotion|gift|story|საჩუქ|ემოცი/.test(r) ? (craft ? 'craft' : 'emotional') : /process|making|how .* made|პროცეს|მზადდება/.test(r) && craft ? 'craft' : 'premium';
  return { concepts, recommended };
}

// ------------------------------------------------------------------ 2. storyboard

const modelPlanSchema = z.object({
  title: z.string(),
  audience: z.string(),
  objective: z.string(),
  hook: z.string(),
  narrative: z.string(),
  benefits: z.array(z.string()).max(8),
  scenes: z
    .array(
      z.object({
        segment: z.string(),
        offsetSec: z.number(),
        durationSec: z.number(),
        role: z.enum(['hook', 'story', 'detail', 'demo', 'benefit', 'reveal', 'proof', 'cta']),
        purpose: z.string(),
        // Shot language is optional for the model (a missing field must not throw the plan away).
        framing: z.enum(['wide', 'medium', 'close', 'macro', 'detail']).nullable().optional(),
        camera: z.enum(MOVES).nullable().optional(),
        lighting: z.string().optional(),
        sound: z.string().optional(),
        crop: z.object({ x: z.number(), y: z.number(), scale: z.number() }).nullable().optional(),
        overlayText: z.string(),
        overlayKind: z.enum(['none', 'title', 'lower_third', 'caption', 'price', 'cta']),
        transition: z.enum(['cut', 'fade', 'dissolve', 'fadeblack']),
        enhanceMode: z.string(),
        enhanceInstruction: z.string(),
      }),
    )
    .min(1)
    .max(40),
  voiceover: z.array(z.object({ text: z.string(), sceneIndex: z.number().int() })).max(20),
  musicMood: z.string(),
  cta: z.string(),
  notes: z.array(z.string()).max(8),
  // Where the ad says what it is, why it matters, what is unique, and the CTA (scene index; -1 = end card).
  messaging: z.object({ what: z.object({ text: z.string(), scene: z.number().int() }), why: z.object({ text: z.string(), scene: z.number().int() }), unique: z.object({ text: z.string(), scene: z.number().int() }), cta: z.object({ text: z.string(), scene: z.number().int() }) }).optional(),
});

const SYSTEM = `You are an award-winning commercial director and editor. You cut real client footage into an advertisement, following the chosen concept, shot by shot.
Rules:
- Use ONLY the listed footage segments (by id) and cut inside them: offsetSec + durationSec ≤ the segment's duration (photos: up to 5 s).
- Never show the same seconds of footage twice. If the footage is short, reuse a source ONLY as a visibly different shot: a detail crop (crop: centre x/y 0–1, scale 1.3–2.2) or a different part of the take.
- Vary the shot language: framing (wide / medium / close / macro / detail), camera (static, push_in, pull_out, pan_left, pan_right, tilt_up, tilt_down, dolly, zoom_to, tracking, handheld) chosen for the story — not at random — and transitions (cuts on action; soft transitions only where the mood asks).
- Follow the Creative Director mode: its narrative order, pacing and shot lengths, allowed transitions (vary them; cut on action when the mode says so), camera language and on-screen text style. HOOK in the first 2 s; end on the product and the call to action. Sum of durations ≈ target.
- A complete ad, not just a pretty showcase: it must SAY what the product is, why it matters, what makes it unique, and what to do (CTA) — each in an overlay text or a voice-over line, taken only from the brief and approved facts. Report where in "messaging" ({text, scene}); text "" when there is truly nothing approved to say for that beat.
- Favour sharp, well-exposed, product-visible segments; skip shaky, dark or near-duplicate ones unless the story needs them.
- Write overlay texts, voice-over and the CTA in the requested language; on-screen texts ≤ 6 words.
- NEVER invent facts: no prices, discounts, awards, guarantees, delivery promises, testimonials or features that are not in the brief or approved brand facts. overlayKind "price" only when a price is given.
- Voice-over: third-person narration unless the brief says otherwise; about 2.3 words per second; one line per scene it covers (sceneIndex = first scene of the line); leave breathing room.
- lighting/sound: one short line each (e.g. "warm side light, soft shadows", "soft whoosh into the reveal").
- enhanceMode/enhanceInstruction: only when AI enhancement is allowed and a shot clearly benefits (relight a dark shot, clean a messy background); otherwise "none" and "". Never change the product itself.`;

const DETAIL_CROPS = [
  { x: 0.5, y: 0.42, scale: 1.6 },
  { x: 0.38, y: 0.55, scale: 1.45 },
  { x: 0.62, y: 0.5, scale: 1.5 },
  { x: 0.5, y: 0.62, scale: 1.7 },
];

const isPhoto = (s: Segment) => (s.tags ?? []).includes('photo');
/** Usable length of a segment for one scene (a photo can hold for a few seconds). */
const roomOf = (s: Segment) => (isPhoto(s) ? 5 : s.endSec - s.startSec);

export async function planAd(ctx: AppContext, p: { brief: AdBrief; segments: Segment[]; brand: BrandContext; concept?: AdConcept | null; reference?: { shots: number; avgShotSec: number; hookSec: number } | null }): Promise<AdPlan & { source: 'llm' | 'offline' }> {
  const style = adStyle(p.concept?.style ?? p.brief.style);
  const segs = p.segments.filter((s) => s.role === 'footage');
  const sid = new Map(segs.map((s, i) => [`S${i + 1}`, s]));
  const concept = p.concept;
  const mode = conceptMode(concept, p.brief.adMode);
  const prompt = [
    `Client request: ${p.brief.request}`,
    concept ? `Chosen concept: ${concept.name} — ${concept.logline}\nTreatment: ${concept.treatment}\nHook: ${concept.hook}\nBeats: ${concept.beats.map((b) => `${b.beat.toUpperCase()}: ${b.idea}`).join(' → ')}\nPacing: ${concept.pacing}. Music: ${concept.music}. Voice: ${concept.voiceTone}.` : '',
    `Creative Director mode: ${mode.label} — ${mode.purpose}\nNarrative: ${mode.narrative.map((n) => `${n.role.toUpperCase()}: ${n.does}`).join(' → ')}\nEditing: ${mode.editing.pacing} pacing, shots ${mode.editing.shotSec[0]}–${mode.editing.shotSec[1]} s, transitions ${mode.editing.transitions.join('/')}${mode.editing.cutOnAction ? ' (cut on action)' : ''}, camera ${mode.editing.camera.join(', ')}, on-screen text: ${mode.editing.text}. Voice: ${mode.voice}.`,
    `Style: ${style.label} — tone ${style.tone}, hook: ${style.hook}, favour: ${style.favour}. Visual intensity: ${p.brief.intensity}.`,
    `Target length: ${p.brief.lengthSec} s · aspect ${p.brief.aspectRatio} · language ${LANG[p.brief.language]} · voice-over ${p.brief.voiceover ? 'yes' : 'no'} · objective ${p.brief.objective}.`,
    `AI enhancement: ${p.brief.mode === 'enhanced' ? `allowed (product preservation: ${p.brief.preservation}; modes: ${AI_EDIT_MODES.map((m) => m.key).join(', ')})` : 'NOT allowed — original footage only'}.`,
    p.brief.productNotes ? `Product notes from the client: ${p.brief.productNotes}` : '',
    brandLines(p.brand, p.brief),
    p.brief.cta ? `CTA requested: ${p.brief.cta}` : '',
    p.reference ? `Structure inspiration from a reference ad (do not copy its content): ${p.reference.shots} shots, average ${p.reference.avgShotSec.toFixed(1)} s, hook ${p.reference.hookSec.toFixed(1)} s.` : '',
    `Footage segments:\n${catalogOf(segs)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const res = await ctx.director.converse({ system: SYSTEM, prompt, schema: modelPlanSchema, tier: 'smart', maxTokens: 9000 }, () => offlinePlan(p.brief, segs, p.brand, concept ?? null));
  const scenes: AdPlan['scenes'] = [];
  for (const [i, s] of res.scenes.entries()) {
    const seg = sid.get(s.segment) ?? segs.find((x) => x.id === s.segment);
    if (!seg) continue;
    const segLen = roomOf(seg);
    const dur = Math.max(0.5, Math.min(segLen, s.durationSec));
    const inSec = isPhoto(seg) ? 0 : Math.max(0, Math.min(segLen - dur, s.offsetSec));
    const editMode = AI_EDIT_MODES.find((m) => m.key === s.enhanceMode)?.key;
    const crop = s.crop && s.crop.scale > 1.05 ? { x: clamp01(s.crop.x), y: clamp01(s.crop.y), scale: Math.min(3, s.crop.scale) } : null;
    scenes.push({
      id: `sc${i + 1}`,
      segmentId: seg.id,
      inSec: round2(inSec),
      durationSec: round2(dur),
      role: s.role,
      purpose: s.purpose.slice(0, 200),
      overlay: s.overlayKind !== 'none' && s.overlayText.trim() ? { text: s.overlayText.trim().slice(0, 120), kind: s.overlayKind } : null,
      transition: mode.editing.transitions.includes(s.transition) ? s.transition : mode.editing.transitions[0]!,
      enhance: p.brief.mode === 'enhanced' && editMode && s.enhanceInstruction.trim().length >= 3 ? { mode: editMode, instruction: s.enhanceInstruction.trim().slice(0, 500) } : null,
      framing: s.framing ?? null,
      camera: s.camera ?? null,
      lighting: (s.lighting ?? '').slice(0, 160),
      sound: (s.sound ?? '').slice(0, 160),
      crop,
    });
  }
  if (!scenes.length) throw new Error('The plan used none of the uploaded footage');
  fitLength(scenes, p.brief.lengthSec, segs);
  separateRepeats(scenes, segs);
  varyTransitions(scenes, mode);
  const total = scenes.reduce((t, x) => t + x.durationSec, 0);
  const msg = (m?: { text: string; scene: number }) => (m && m.text.trim() ? { text: m.text.trim().slice(0, 200), scene: Math.max(-1, Math.min(scenes.length - 1, m.scene)) } : null);
  const plan = adPlanSchema.parse({
    title: res.title.slice(0, 120),
    audience: res.audience.slice(0, 300),
    objective: res.objective.slice(0, 300),
    hook: res.hook.slice(0, 300),
    narrative: res.narrative.slice(0, 800),
    benefits: res.benefits.map((b) => b.slice(0, 160)),
    scenes,
    voiceover: p.brief.voiceover ? res.voiceover.filter((v) => v.text.trim()).map((v) => ({ text: v.text.trim().slice(0, 400), sceneIndex: Math.max(0, Math.min(scenes.length - 1, v.sceneIndex)) })) : [],
    musicMood: (p.brief.musicStyle || res.musicMood || concept?.music || style.music).slice(0, 200),
    cta: (res.cta || p.brief.cta).slice(0, 120),
    endCard: true,
    notes: res.notes.map((n) => n.slice(0, 300)),
    conceptKey: concept?.key ?? '',
    mode: mode.key,
    messaging: res.messaging ? { what: msg(res.messaging.what), why: msg(res.messaging.why), unique: msg(res.messaging.unique), cta: msg(res.messaging.cta) } : null,
    endCardSec: endCardSeconds(total, mode.editing.endCardRatio),
  });
  return { ...plan, source: res.source === 'llm' ? 'llm' : 'offline' };
}

/** Scale scene lengths (within each segment's limits) so the cut lasts about the target length. */
export function fitLength(scenes: AdPlan['scenes'], target: number, segs: Segment[]) {
  for (let pass = 0; pass < 4; pass++) {
    const total = scenes.reduce((s, x) => s + x.durationSec, 0);
    if (Math.abs(total - target) / target < 0.06) return;
    const k = target / total;
    for (const s of scenes) {
      const seg = segs.find((x) => x.id === s.segmentId)!;
      const room = roomOf(seg) - s.inSec;
      s.durationSec = round2(Math.max(0.5, Math.min(room, s.durationSec * k)));
    }
  }
}

/**
 * No scene may show seconds another scene already showed. A repeat is moved to an unused part of
 * its take when there is room; otherwise it becomes a visibly different detail crop.
 */
export function separateRepeats(scenes: AdPlan['scenes'], segs: Segment[]) {
  const used: { assetId: string; a: number; b: number; crop: AdPlan['scenes'][number]['crop'] }[] = [];
  let cropIdx = 0;
  for (const sc of scenes) {
    const seg = segs.find((x) => x.id === sc.segmentId);
    if (!seg) continue;
    const photo = isPhoto(seg);
    const clash = (a: number, b: number) => used.some((u) => u.assetId === seg.assetId && Math.min(b, u.b) - Math.max(a, u.a) > 0.3 && !cropsDiffer(u.crop, sc.crop));
    let a = seg.startSec + sc.inSec;
    if (clash(a, a + sc.durationSec) && !photo) {
      // Find a free window in the same take.
      for (let start = seg.startSec; start + sc.durationSec <= seg.endSec + 0.01; start += 0.25)
        if (!clash(start, start + sc.durationSec)) {
          sc.inSec = round2(start - seg.startSec);
          a = start;
          break;
        }
    }
    if (clash(a, a + sc.durationSec)) {
      sc.crop = DETAIL_CROPS[cropIdx++ % DETAIL_CROPS.length]!;
      sc.framing = 'detail';
      sc.camera = sc.camera && sc.camera !== 'static' ? sc.camera : 'push_in';
    }
    used.push({ assetId: seg.assetId, a, b: a + sc.durationSec, crop: sc.crop });
  }
}

/** No soft transition three times in a row; stay within the mode's transitions. */
export function varyTransitions(scenes: AdPlan['scenes'], mode: AdMode) {
  const allowed = mode.editing.transitions;
  for (let i = 2; i < scenes.length - 1; i++) {
    const t = scenes[i]!.transition;
    if (t !== 'cut' && scenes[i - 1]!.transition === t && scenes[i - 2]!.transition === t) scenes[i]!.transition = allowed.find((x) => x !== t) ?? 'cut';
  }
}

const cropsDiffer = (a: AdPlan['scenes'][number]['crop'], b: AdPlan['scenes'][number]['crop']) => (!a || !b ? Boolean(a) !== Boolean(b) : Math.abs(a.scale - b.scale) + Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 0.25);
const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Without the AI Director: a real structure from the scores and tags, varied shot language. */
function offlinePlan(brief: AdBrief, segs: Segment[], brand: BrandContext, concept: AdConcept | null): z.infer<typeof modelPlanSchema> {
  const style = adStyle(concept?.style ?? brief.style);
  const mode = conceptMode(concept, brief.adMode);
  const usable = segs.filter((s) => !s.duplicateOf);
  const sc = (s: Segment, k: string) => (s.scores as Record<string, number>)[k] ?? 0;
  const ranked = [...usable].sort((a, b) => sc(b, 'overall') - sc(a, 'overall'));
  const shot = (style.shotSec[0] + style.shotSec[1]) / 2;
  const n = Math.max(1, Math.round(brief.lengthSec / shot));
  const has = (s: Segment, ...t: string[]) => t.some((x) => (s.tags ?? []).includes(x));
  // Hook = best close-up; middle = process/demo in source order, then details; payoff = most product-visible.
  const hook = [...ranked].sort((a, b) => sc(b, 'closeup') + sc(b, 'appeal') - sc(a, 'closeup') - sc(a, 'appeal'))[0]!;
  const payoff = [...ranked].filter((s) => s !== hook).sort((a, b) => sc(b, 'product') - sc(a, 'product'))[0];
  const middlePool = ranked.filter((s) => s !== hook && s !== payoff);
  const process = middlePool.filter((s) => has(s, 'printing', 'painting', 'hands', 'workshop', 'demo', 'making')).sort((a, b) => a.index - b.index);
  const others = middlePool.filter((s) => !process.includes(s));
  const middle = [...process, ...others].slice(0, Math.max(0, n - (payoff ? 2 : 1)));
  let order = [hook, ...middle, ...(payoff ? [payoff] : [])];
  // Not enough distinct footage for the length: reuse sources as detail crops (still the real footage).
  const moves: CameraMove[] = style.pacing === 'fast' ? ['zoom_to', 'pan_right', 'push_in', 'tilt_up', 'pull_out'] : ['push_in', 'pan_right', 'dolly', 'tilt_up', 'pull_out'];
  const reuse: Segment[] = [];
  for (let k = 0; order.length + reuse.length < n && k < order.length * 2; k++) reuse.push(order[k % order.length]!);
  if (reuse.length && payoff) order = [...order.slice(0, -1), ...reuse, payoff];
  else order = [...order, ...reuse];
  const label = (s: Segment) => `S${segs.indexOf(s) + 1}`;
  const name = brand?.product?.name ?? brand?.name ?? '';
  const cta = brief.cta || concept?.cta || brand?.ctas[0] || '';
  const seen = new Map<string, number>();
  return {
    title: name ? `${name} — ${concept?.name ?? 'ad'}` : concept?.name ?? 'Product ad',
    audience: brief.audience || brand?.audience || '',
    objective: 'Show the real product attractively and invite viewers to act.',
    hook: concept?.hook ?? 'Strongest close-up first',
    narrative: concept?.treatment ?? 'Hook on the best close-up, the process in order, then the product as the payoff and the call to action.',
    benefits: [],
    scenes: order.map((s, i) => {
      const times = seen.get(s.id) ?? 0;
      seen.set(s.id, times + 1);
      const last = i === order.length - 1;
      const room = roomOf(s);
      const dur = Math.min(room, shot);
      const role = i === 0 ? 'hook' : last ? 'reveal' : has(s, 'printing', 'painting', 'hands', 'workshop', 'demo', 'making') ? 'demo' : sc(s, 'closeup') > 0.6 ? 'detail' : 'story';
      return {
        segment: label(s),
        // A reused take continues from where the last use stopped, when it can.
        offsetSec: times && !isPhoto(s) ? Math.min(Math.max(0, room - dur), dur * times) : 0,
        durationSec: dur,
        role,
        purpose: role === 'hook' ? 'Stop the scroll with the strongest detail' : role === 'reveal' ? 'The product as the hero' : role === 'demo' ? 'Show how it is made' : 'Build interest',
        framing: times ? 'detail' : role === 'hook' ? 'close' : role === 'reveal' ? 'medium' : sc(s, 'closeup') > 0.6 ? 'close' : 'medium',
        camera: style.camera === 'static' && !isPhoto(s) ? 'static' : moves[i % moves.length]!,
        lighting: '',
        sound: '',
        crop: times ? DETAIL_CROPS[(times - 1 + i) % DETAIL_CROPS.length]! : null,
        overlayText: i === 0 && name ? name : last ? cta : '',
        overlayKind: i === 0 && name ? 'title' : last && cta ? 'cta' : 'none',
        transition: mode.editing.transitions[i % mode.editing.transitions.length]!,
        enhanceMode: 'none',
        enhanceInstruction: '',
      };
    }),
    voiceover: [],
    musicMood: concept?.music ?? mode.editing.music,
    cta,
    notes: ['Planned without the AI Director (not configured): shots were picked by their quality scores and tags.'],
    // Only what is approved: the product's name/description and claims, and the CTA.
    messaging: {
      what: { text: name, scene: 0 },
      why: { text: brand?.product?.description?.split(/[.!?]/)[0] ?? '', scene: Math.min(1, order.length - 1) },
      unique: { text: brand?.product?.claims[0] ?? '', scene: Math.min(2, order.length - 1) },
      cta: { text: cta, scene: cta ? order.length - 1 : -1 },
    },
  };
}
