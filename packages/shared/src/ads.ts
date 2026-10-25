import { z } from 'zod';
import { aiEditModeSchema, CAMERA_MOVES, type CameraMove } from './edit';
import { aspectRatioSchema } from './schemas';
import type { LayerAnim } from './layers';

/*
 * Product ads from the client's real footage: brief, creative styles and the editable plan.
 * Styles change real planning and assembly parameters (pacing, shot length, transitions, look,
 * camera, title animation, script tone, music and what footage to favour) — not just a filter.
 */

export type AdStyle = {
  key: string;
  label: string;
  pacing: 'slow' | 'medium' | 'fast';
  shotSec: [number, number];
  transition: 'cut' | 'fade' | 'dissolve' | 'fadeblack';
  look: string;
  camera: CameraMove | null;
  textAnim: LayerAnim;
  font: 'bold' | 'black' | 'serif' | 'semibold';
  tone: string;
  music: string;
  hook: string;
  favour: string;
};

export const AD_STYLES: AdStyle[] = [
  { key: 'cinematic_luxury', label: 'Cinematic Luxury', pacing: 'slow', shotSec: [2.5, 4.5], transition: 'dissolve', look: 'luxury', camera: 'push_in', textAnim: 'fade', font: 'serif', tone: 'elegant, confident, few words', music: 'slow cinematic strings and soft piano, premium', hook: 'open on the most beautiful close-up of the product', favour: 'close-ups, beautiful light, the finished product' },
  { key: 'emotional', label: 'Emotional Storytelling', pacing: 'slow', shotSec: [2.5, 5], transition: 'dissolve', look: 'cinematic', camera: 'dolly', textAnim: 'fade', font: 'serif', tone: 'warm, human, heartfelt', music: 'emotional piano building to a warm swell', hook: 'start with a human moment or the reason the product exists', favour: 'hands, people, reactions, making-of, gifting' },
  { key: 'modern_minimal', label: 'Modern Minimal', pacing: 'medium', shotSec: [1.8, 3], transition: 'cut', look: 'clean', camera: 'static', textAnim: 'slide_up', font: 'semibold', tone: 'clear, short, matter-of-fact', music: 'minimal electronic, light percussion', hook: 'a clean product hero frame', favour: 'clean backgrounds, product alone, sharp shots' },
  { key: 'product_reveal', label: 'Premium Product Reveal', pacing: 'medium', shotSec: [1.5, 3.5], transition: 'fadeblack', look: 'moody', camera: 'push_in', textAnim: 'zoom', font: 'black', tone: 'suspense then pride', music: 'build-up with a hit on the reveal', hook: 'tease a detail, hide the full product until the reveal', favour: 'details first, then the full product' },
  { key: 'fast_social', label: 'Fast TikTok / Reels', pacing: 'fast', shotSec: [0.6, 1.4], transition: 'cut', look: 'pop', camera: 'zoom_to', textAnim: 'pop', font: 'black', tone: 'punchy, direct, energetic', music: 'upbeat trending-style beat (licensed/generated)', hook: 'movement or a surprising frame in the first second', favour: 'motion, variety, strongest frames' },
  { key: 'ugc', label: 'UGC Authentic', pacing: 'medium', shotSec: [1.2, 2.5], transition: 'cut', look: 'clean', camera: 'handheld', textAnim: 'words', font: 'bold', tone: 'casual first-person friend recommendation', music: 'light casual background track', hook: 'a candid moment', favour: 'handheld, real-life use, people' },
  { key: 'behind_scenes', label: 'Handmade / Behind the Scenes', pacing: 'medium', shotSec: [1.8, 3.5], transition: 'dissolve', look: 'cinematic', camera: 'tracking', textAnim: 'typewriter', font: 'semibold', tone: 'proud craftsmanship, process', music: 'acoustic, organic, warm', hook: 'hands at work', favour: 'making-of, tools, process, then the finished piece' },
  { key: 'demo', label: 'Product Demonstration', pacing: 'medium', shotSec: [2, 4], transition: 'cut', look: 'clean', camera: 'static', textAnim: 'slide_left', font: 'bold', tone: 'helpful, step by step', music: 'positive corporate-light', hook: 'show the result first', favour: 'demonstrations, product in use, clear steps' },
  { key: 'testimonial', label: 'Social Proof / Testimonial', pacing: 'medium', shotSec: [2, 4], transition: 'fade', look: 'clean', camera: 'push_in', textAnim: 'fade', font: 'semibold', tone: 'trustworthy; only real quotes supplied by the client', music: 'soft uplifting', hook: 'a person reacting to the product', favour: 'people, reactions, speech' },
  { key: 'before_after', label: 'Before & After', pacing: 'medium', shotSec: [1.5, 3], transition: 'fadeblack', look: 'clean', camera: 'static', textAnim: 'pop', font: 'black', tone: 'clear contrast', music: 'build with a drop at the "after"', hook: 'the "before" state', favour: 'raw material or before, then finished result' },
  { key: 'unboxing', label: 'Unboxing', pacing: 'medium', shotSec: [1.5, 3], transition: 'cut', look: 'luxury', camera: 'push_in', textAnim: 'pop', font: 'bold', tone: 'anticipation and delight', music: 'playful, light', hook: 'the closed package', favour: 'packaging, opening, the reveal' },
  { key: 'gift_reveal', label: 'Gift Reveal', pacing: 'slow', shotSec: [2, 4], transition: 'dissolve', look: 'luxury', camera: 'dolly', textAnim: 'fade', font: 'serif', tone: 'heartfelt, gifting', music: 'warm emotional', hook: 'a gift being handed over', favour: 'packaging, gifting, reactions, finished product' },
  { key: 'seasonal', label: 'Seasonal Campaign', pacing: 'medium', shotSec: [1.5, 3], transition: 'fade', look: 'luxury', camera: 'push_in', textAnim: 'pop', font: 'black', tone: 'festive, timely (no invented offers)', music: 'festive seasonal feel', hook: 'the most festive frame', favour: 'colourful, warm, gift-like' },
  { key: 'promo', label: 'High-Energy Promotional', pacing: 'fast', shotSec: [0.7, 1.6], transition: 'cut', look: 'pop', camera: 'zoom_to', textAnim: 'pop', font: 'black', tone: 'bold and urgent (only offers the client gave)', music: 'high-energy beat', hook: 'a fast cut on motion', favour: 'motion, bold colour, product' },
  { key: 'brand_film', label: 'Elegant Brand Film', pacing: 'slow', shotSec: [3, 5.5], transition: 'dissolve', look: 'cinematic', camera: 'dolly', textAnim: 'fade', font: 'serif', tone: 'poetic, brand values', music: 'orchestral ambient', hook: 'an atmospheric wide frame', favour: 'atmosphere, craft, people, product in context' },
];
export const adStyle = (key: string) => AD_STYLES.find((s) => s.key === key) ?? AD_STYLES[0]!;

export const adBriefSchema = z.object({
  request: z.string().trim().min(3).max(3000),
  style: z.string().default('cinematic_luxury'),
  /** original = only the client's footage; enhanced = selective, reviewable AI changes. */
  mode: z.enum(['original', 'enhanced']).default('original'),
  /** How strictly the real product must be preserved by any generative change. */
  preservation: z.enum(['strict', 'guided', 'creative']).default('strict'),
  language: z.enum(['ka', 'en', 'ru']).default('ka'),
  lengthSec: z.number().min(6).max(90).default(30),
  aspectRatio: aspectRatioSchema.default('9:16'),
  voiceover: z.boolean().default(true),
  music: z.enum(['none', 'generate', 'upload']).default('generate'),
  musicAssetId: z.string().uuid().optional(),
  footageAssetIds: z.array(z.string().uuid()).max(20).default([]),
  imageAssetIds: z.array(z.string().uuid()).max(20).default([]),
  productRefAssetIds: z.array(z.string().uuid()).max(8).default([]),
  productNotes: z.string().max(1500).default(''),
  referenceAdAssetId: z.string().uuid().nullable().optional(),
  brandKitId: z.string().uuid().nullable().optional(),
  cta: z.string().max(120).default(''),
  website: z.string().max(300).default(''),
  /** A product from the brand catalog: only its media and approved facts are used. */
  productId: z.string().uuid().nullable().optional(),
  objective: z.enum(['sales', 'awareness', 'launch', 'engagement', 'traffic']).default('sales'),
  audience: z.string().max(300).default(''),
  /** Chosen creative concept (empty = the recommended one). */
  conceptKey: z.string().max(40).default(''),
  voiceGender: z.enum(['auto', 'female', 'male']).default('auto'),
  musicStyle: z.string().max(200).default(''),
  /** Visual intensity: camera energy and cutting rhythm. */
  intensity: z.enum(['calm', 'balanced', 'bold']).default('balanced'),
  /** Upper limit of credits this ad may spend (null = ask each time). */
  budgetCredits: z.number().int().min(0).nullable().default(null),
});
export type AdBrief = z.infer<typeof adBriefSchema>;

/** A distinct creative treatment proposed before the storyboard (not just a filter or headline). */
export const adConceptSchema = z.object({
  key: z.string().min(1).max(40),
  name: z.string().max(80),
  angle: z.enum(['cinematic_premium', 'emotional_story', 'high_energy_social', 'craft_process', 'other']),
  /** AD_STYLES key the concept is cut in. */
  style: z.string().max(40),
  logline: z.string().max(300),
  treatment: z.string().max(1200),
  hook: z.string().max(300),
  /** HOOK -> INTEREST -> VALUE -> PAYOFF -> CTA. */
  beats: z.array(z.object({ beat: z.enum(['hook', 'interest', 'value', 'payoff', 'cta']), idea: z.string().max(300) })).max(8),
  pacing: z.string().max(120),
  music: z.string().max(200),
  voiceTone: z.string().max(200),
  cta: z.string().max(120),
  whyItFits: z.string().max(400),
  recommended: z.boolean().default(false),
});
export type AdConcept = z.infer<typeof adConceptSchema>;

export const adSceneSchema = z.object({
  id: z.string().min(1).max(40),
  segmentId: z.string().uuid(),
  /** Offset inside the segment where the cut starts. */
  inSec: z.number().min(0),
  durationSec: z.number().min(0.4).max(12),
  role: z.enum(['hook', 'story', 'detail', 'demo', 'benefit', 'reveal', 'proof', 'cta']).default('story'),
  purpose: z.string().max(200).default(''),
  overlay: z.object({ text: z.string().min(1).max(120), kind: z.enum(['title', 'lower_third', 'caption', 'price', 'cta']).default('caption') }).nullable().default(null),
  transition: z.enum(['cut', 'fade', 'dissolve', 'fadeblack']).default('cut'),
  /** AI-enhanced mode only: a reviewable generative change to this shot. */
  enhance: z.object({ mode: aiEditModeSchema, instruction: z.string().min(3).max(500) }).nullable().default(null),
  /** Shot language (storyboard): framing, camera move, light, sound. */
  framing: z.enum(['wide', 'medium', 'close', 'macro', 'detail']).nullable().default(null),
  camera: z.enum(CAMERA_MOVES.map((c) => c.key) as [CameraMove, ...CameraMove[]]).nullable().default(null),
  lighting: z.string().max(160).default(''),
  sound: z.string().max(160).default(''),
  /** Reframe inside the source (centre 0-1, scale >= 1): a detail crop that makes a reused source a new shot. */
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), scale: z.number().min(1).max(3) }).nullable().default(null),
});
export type AdScene = z.infer<typeof adSceneSchema>;

export const adPlanSchema = z.object({
  title: z.string().max(120),
  audience: z.string().max(300),
  objective: z.string().max(300),
  hook: z.string().max(300),
  narrative: z.string().max(800),
  benefits: z.array(z.string().max(160)).max(8),
  scenes: z.array(adSceneSchema).min(1).max(60),
  voiceover: z.array(z.object({ text: z.string().min(1).max(400), sceneIndex: z.number().int().min(0) })).max(20),
  musicMood: z.string().max(200),
  cta: z.string().max(120),
  endCard: z.boolean().default(true),
  notes: z.array(z.string().max(300)).max(10).default([]),
  conceptKey: z.string().max(40).default(''),
});
export type AdPlan = z.infer<typeof adPlanSchema>;

/* ------------------------------------------------------------------ shot diversity review */

export type DiversityIssue = {
  severity: 'error' | 'warning' | 'info';
  code: 'repeated_interval' | 'near_duplicate' | 'same_framing' | 'static_heavy' | 'few_product' | 'weak_progression' | 'repetitive_transitions' | 'insufficient_footage';
  message: string;
  sceneIndexes: number[];
};
export type DiversityReport = {
  score: number;
  issues: DiversityIssue[];
  stats: { scenes: number; uniqueSources: number; uniqueSegments: number; reusedSeconds: number; staticShare: number; productShots: number; avgShotSec: number; usableFootageSec: number; targetSec: number };
  /** What the user can do when the footage is not enough for the requested length. */
  options: { key: 'shorter' | 'crops' | 'more_footage'; label: string; lengthSec?: number }[];
};

export type DiversitySegment = { id: string; assetId: string; startSec: number; endSec: number; duplicateOf: string | null; metrics: Record<string, number>; scores: Record<string, number> };

const reframedApart = (a: AdScene['crop'], b: AdScene['crop']) => (!a || !b ? Boolean(a) !== Boolean(b) : Math.abs(a.scale - b.scale) + Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 0.25);

/**
 * Shot Diversity Checker: catches the "same shot for 15 seconds with different captions" ad —
 * repeated source intervals, near-duplicate frames, identical framing in a row, too many static
 * shots, too few product moments, weak progression and monotonous transitions.
 */
export function reviewPlanDiversity(plan: Pick<AdPlan, 'scenes'>, segments: DiversitySegment[], targetSec: number): DiversityReport {
  const issues: DiversityIssue[] = [];
  const ranges = plan.scenes.map((sc, i) => {
    const s = segments.find((x) => x.id === sc.segmentId);
    const a = (s?.startSec ?? 0) + sc.inSec;
    return { i, sc, s, assetId: s?.assetId ?? sc.segmentId, a, b: a + sc.durationSec };
  });

  let reusedSeconds = 0;
  for (let i = 0; i < ranges.length; i++)
    for (let j = 0; j < i; j++) {
      const x = ranges[i]!;
      const y = ranges[j]!;
      if (x.assetId !== y.assetId) continue;
      const overlap = Math.min(x.b, y.b) - Math.max(x.a, y.a);
      if (overlap <= 0.3) continue;
      reusedSeconds += overlap;
      // A reused interval is acceptable only when it is visibly a new shot (a different crop).
      if (!reframedApart(x.sc.crop, y.sc.crop)) issues.push({ severity: 'error', code: 'repeated_interval', message: `Scenes ${j + 1} and ${i + 1} show the same ${overlap.toFixed(1)} s of footage`, sceneIndexes: [j, i] });
    }

  for (let i = 1; i < ranges.length; i++) {
    const x = ranges[i]!;
    const y = ranges[i - 1]!;
    const dup = x.s && y.s && (x.s.duplicateOf === y.s.id || y.s.duplicateOf === x.s.id || (x.s.duplicateOf !== null && x.s.duplicateOf === y.s.duplicateOf));
    if (dup && !reframedApart(x.sc.crop, y.sc.crop)) issues.push({ severity: 'warning', code: 'near_duplicate', message: `Scenes ${i} and ${i + 1} look almost identical`, sceneIndexes: [i - 1, i] });
    else if (x.assetId === y.assetId && Math.abs(x.a - y.b) < 0.5 && !x.sc.crop && !y.sc.crop && x.sc.camera === y.sc.camera && x.sc.framing === y.sc.framing)
      issues.push({ severity: 'warning', code: 'same_framing', message: `Scenes ${i} and ${i + 1} continue one take with the same framing — it reads as one long shot`, sceneIndexes: [i - 1, i] });
  }

  const isStatic = (r: (typeof ranges)[number]) => (r.s?.metrics.motion ?? 0.2) < 0.04 && (!r.sc.camera || r.sc.camera === 'static') && !r.sc.crop;
  const statics = ranges.filter(isStatic);
  const staticShare = ranges.length ? statics.length / ranges.length : 0;
  if (ranges.length >= 3 && staticShare > 0.6) issues.push({ severity: 'warning', code: 'static_heavy', message: `${Math.round(staticShare * 100)}% of the shots have no movement — add camera moves or livelier footage`, sceneIndexes: statics.map((r) => r.i) });

  const scored = ranges.filter((r) => r.s?.scores.product !== undefined);
  const productShots = scored.filter((r) => (r.s!.scores.product ?? 0) >= 0.5).length;
  if (scored.length >= 3 && productShots < Math.max(2, Math.ceil(scored.length * 0.3))) issues.push({ severity: 'warning', code: 'few_product', message: `Only ${productShots} shot${productShots === 1 ? '' : 's'} clearly show the product`, sceneIndexes: [] });

  const first = plan.scenes[0];
  const last = plan.scenes.at(-1);
  if (first && first.role !== 'hook') issues.push({ severity: 'info', code: 'weak_progression', message: 'The ad does not open on a hook', sceneIndexes: [0] });
  if (last && plan.scenes.length > 2 && !['reveal', 'cta', 'benefit', 'proof'].includes(last.role)) issues.push({ severity: 'info', code: 'weak_progression', message: 'The ad does not end on the product or the call to action', sceneIndexes: [plan.scenes.length - 1] });

  const trans = plan.scenes.slice(0, -1).map((s) => s.transition);
  const top = trans.length ? Math.max(...(['fade', 'dissolve', 'fadeblack'] as const).map((t) => trans.filter((x) => x === t).length)) : 0;
  if (trans.length >= 5 && top / trans.length > 0.85) issues.push({ severity: 'info', code: 'repetitive_transitions', message: 'Every transition is the same soft blend — cuts on action keep the rhythm alive', sceneIndexes: [] });

  // Distinct usable footage vs the requested length.
  const usableFootageSec = Math.round(segments.filter((s) => !s.duplicateOf).reduce((t, s) => t + (s.endSec - s.startSec), 0) * 10) / 10;
  const options: DiversityReport['options'] = [];
  if (usableFootageSec < targetSec * 0.6) {
    const shorter = Math.max(6, Math.floor(usableFootageSec * 0.9));
    issues.push({ severity: 'error', code: 'insufficient_footage', message: `Only ${usableFootageSec} s of distinct footage for a ${targetSec} s ad — shots would repeat`, sceneIndexes: [] });
    options.push(
      { key: 'shorter', label: `Make a polished ${shorter} s ad from the original footage`, lengthSec: shorter },
      { key: 'crops', label: 'Keep the length with detail crops and camera moves (still only your footage)' },
      { key: 'more_footage', label: 'Upload more footage of the product' },
    );
  }

  const penalty = issues.reduce((p, x) => p + (x.severity === 'error' ? 25 : x.severity === 'warning' ? 10 : 3), 0);
  const total = plan.scenes.reduce((t, s) => t + s.durationSec, 0);
  return {
    score: Math.max(0, 100 - penalty),
    issues,
    stats: {
      scenes: plan.scenes.length,
      uniqueSources: new Set(ranges.map((r) => r.assetId)).size,
      uniqueSegments: new Set(plan.scenes.map((s) => s.segmentId)).size,
      reusedSeconds: Math.round(reusedSeconds * 10) / 10,
      staticShare: Math.round(staticShare * 100) / 100,
      productShots,
      avgShotSec: plan.scenes.length ? Math.round((total / plan.scenes.length) * 10) / 10 : 0,
      usableFootageSec,
      targetSec,
    },
    options,
  };
}

