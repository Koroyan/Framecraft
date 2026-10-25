import { z } from 'zod';
import { aiEditModeSchema, type CameraMove } from './edit';
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
});
export type AdBrief = z.infer<typeof adBriefSchema>;

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
});
export type AdPlan = z.infer<typeof adPlanSchema>;
