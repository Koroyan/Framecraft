import type { CameraMove } from './edit';

/*
 * Creative Director modes. A mode is a complete strategy, not a filter: what the ad must say
 * (messaging beats), in which order (narrative), and how it is cut (pacing, shot lengths,
 * transitions, camera language, on-screen text, music, the brand ending). Both production paths
 * use it: cutting the client's footage, and staging the product in new AI scenes.
 */

export type AdModeKey = 'product_showcase' | 'emotional_story' | 'product_demo' | 'luxury_commercial' | 'social_sales' | 'behind_the_scenes';

/** What every complete ad communicates (a pretty showcase alone is not an ad). */
export type MessagingBeat = 'what' | 'why' | 'unique' | 'cta';

export type AdMode = {
  key: AdModeKey;
  label: string;
  purpose: string;
  /** AD_STYLES key used for look, fonts and title animation. */
  style: string;
  /** Narrative in order: beat role → what the shot does. */
  narrative: { role: 'hook' | 'story' | 'detail' | 'demo' | 'benefit' | 'reveal' | 'proof' | 'cta'; does: string }[];
  editing: {
    pacing: 'slow' | 'medium' | 'fast';
    shotSec: [number, number];
    /** Allowed transitions; the planner varies within them and cuts on action where marked. */
    transitions: ('cut' | 'fade' | 'dissolve' | 'fadeblack')[];
    cutOnAction: boolean;
    camera: CameraMove[];
    text: string;
    music: string;
    /** Share of the ad given to the brand ending (clamped to 1.5–3 s). */
    endCardRatio: number;
  };
  /** AI-scenes path: the shot list the film director must follow. */
  aiShots: string[];
  /** How the narration should sound. */
  voice: string;
};

export const AD_MODES: AdMode[] = [
  {
    key: 'product_showcase',
    label: 'Product Showcase',
    purpose: 'Show exactly what the product is and what makes it special, clearly and attractively.',
    style: 'modern_minimal',
    narrative: [
      { role: 'hook', does: 'the most striking detail, revealed in the first second' },
      { role: 'reveal', does: 'the whole product, clearly framed — viewers learn what it is' },
      { role: 'detail', does: 'two or three details that prove quality' },
      { role: 'benefit', does: 'the product in context: why someone wants it' },
      { role: 'cta', does: 'hero shot with the call to action' },
    ],
    editing: { pacing: 'medium', shotSec: [1.8, 3], transitions: ['cut', 'dissolve'], cutOnAction: true, camera: ['push_in', 'pan_right', 'zoom_to', 'tilt_up'], text: 'short labels naming what the viewer sees (≤ 5 words)', music: 'clean modern, light percussion', endCardRatio: 0.12 },
    aiShots: ['macro hook on the most distinctive detail', 'clean reveal of the whole product, front view', 'smooth turntable orbit: front, both sides, back', 'two macro detail passes on materials and finish', 'hero shot, calm final frame'],
    voice: 'clear, confident, informative',
  },
  {
    key: 'emotional_story',
    label: 'Emotional Storytelling',
    purpose: 'Make viewers feel why the product matters to people — a small story with a payoff.',
    style: 'emotional',
    narrative: [
      { role: 'hook', does: 'a human moment or the reason the product exists' },
      { role: 'story', does: 'anticipation: the moment before' },
      { role: 'reveal', does: 'the product appears — what it is' },
      { role: 'benefit', does: 'the meaning: what it gives the person' },
      { role: 'cta', does: 'warm ending on the product and the call to action' },
    ],
    editing: { pacing: 'slow', shotSec: [2.5, 4.5], transitions: ['dissolve', 'cut', 'fade'], cutOnAction: false, camera: ['dolly', 'push_in', 'tracking', 'pull_out'], text: 'few, heartfelt words; let images breathe', music: 'emotional piano building to a warm swell', endCardRatio: 0.13 },
    aiShots: ['warm, intimate opening on the product in soft window light as if just placed as a gift', 'slow push-in revealing the product from the gift wrapping', 'close-up of the details that make it personal', 'the product in a warm home setting, golden hour', 'calm hero shot with soft glow'],
    voice: 'warm, heartfelt, unhurried',
  },
  {
    key: 'product_demo',
    label: 'Product Demonstration',
    purpose: 'Show how it works or how it is used, step by step, ending on the result.',
    style: 'demo',
    narrative: [
      { role: 'hook', does: 'the result first' },
      { role: 'demo', does: 'step one, shown clearly' },
      { role: 'demo', does: 'step two' },
      { role: 'benefit', does: 'the outcome and why it is better' },
      { role: 'cta', does: 'product with the call to action' },
    ],
    editing: { pacing: 'medium', shotSec: [2, 3.5], transitions: ['cut'], cutOnAction: true, camera: ['static', 'push_in', 'zoom_to'], text: 'numbered steps and one benefit line', music: 'positive, light corporate', endCardRatio: 0.11 },
    aiShots: ['the finished product as the result, hero light', 'clear mid shot showing how it is used or held', 'macro on the part that makes it work', 'the outcome in context', 'final product shot'],
    voice: 'helpful, step by step',
  },
  {
    key: 'luxury_commercial',
    label: 'Luxury Commercial',
    purpose: 'Premium desirability: controlled light, slow reveals, few refined words.',
    style: 'cinematic_luxury',
    narrative: [
      { role: 'hook', does: 'a mysterious macro detail in sculpted light' },
      { role: 'detail', does: 'slow reveal of materials and craft' },
      { role: 'reveal', does: 'the full product as an object of desire' },
      { role: 'benefit', does: 'one line on what makes it exceptional' },
      { role: 'cta', does: 'elegant brand reveal and call to action' },
    ],
    editing: { pacing: 'slow', shotSec: [2.5, 4.5], transitions: ['dissolve', 'fadeblack', 'cut'], cutOnAction: false, camera: ['push_in', 'dolly', 'tracking', 'pull_out'], text: 'serif, minimal, generous spacing', music: 'slow cinematic strings and soft piano', endCardRatio: 0.12 },
    aiShots: ['extreme macro in darkness, a sliver of rim light tracing a detail', 'slow dolly revealing the product on a pedestal in a dark luxury studio, haze and bokeh', 'smooth 360° orbit around the product', 'macro passes on the finest details', 'hero shot, dramatic low angle, light blooms'],
    voice: 'calm, elegant, few words',
  },
  {
    key: 'social_sales',
    label: 'Social Media Sales Ad',
    purpose: 'Stop the scroll and sell: instant hook, benefit, proof, offer, clear CTA.',
    style: 'fast_social',
    narrative: [
      { role: 'hook', does: 'movement or a surprising frame in the first second' },
      { role: 'reveal', does: 'what the product is, said on screen' },
      { role: 'benefit', does: 'the main benefit in one punchy line' },
      { role: 'detail', does: 'quick montage of the best moments' },
      { role: 'cta', does: 'direct call to action (and the real offer, if any)' },
    ],
    editing: { pacing: 'fast', shotSec: [0.7, 1.6], transitions: ['cut'], cutOnAction: true, camera: ['zoom_to', 'pan_right', 'push_in', 'handheld'], text: 'bold captions on every beat, ≤ 4 words', music: 'upbeat beat', endCardRatio: 0.1 },
    aiShots: ['fast whip-in to the product with an energetic camera move', 'quick reveal of the whole product, bright', 'snappy macro detail', 'the product being picked up or turned, dynamic', 'punchy final hero frame'],
    voice: 'punchy, direct',
  },
  {
    key: 'behind_the_scenes',
    label: 'Behind-the-Scenes Ad',
    purpose: 'Prove quality through the making: process, care and the finished piece.',
    style: 'behind_scenes',
    narrative: [
      { role: 'hook', does: 'hands at work, mid-action' },
      { role: 'demo', does: 'the process in order' },
      { role: 'detail', does: 'the finishing touches' },
      { role: 'reveal', does: 'the finished product' },
      { role: 'cta', does: 'order yours' },
    ],
    editing: { pacing: 'medium', shotSec: [1.8, 3.5], transitions: ['cut', 'dissolve'], cutOnAction: true, camera: ['tracking', 'push_in', 'handheld', 'static'], text: 'process labels (designed · printed · painted)', music: 'acoustic, organic, warm', endCardRatio: 0.12 },
    aiShots: ['workshop close-up: tools and materials around the product, warm practical light', 'the product on the workbench, a brush or tool beside it', 'macro of the hand-finished details', 'the finished piece revealed on a clean surface', 'hero shot of the finished product'],
    voice: 'warm, proud of the craft',
  },
];

export const adMode = (key: string | undefined | null) => AD_MODES.find((m) => m.key === key) ?? AD_MODES[0]!;

/** Concept angle → mode (older concepts carry only an angle). */
export function modeForAngle(angle: string): AdModeKey {
  return angle === 'cinematic_premium' ? 'luxury_commercial' : angle === 'emotional_story' ? 'emotional_story' : angle === 'high_energy_social' ? 'social_sales' : angle === 'craft_process' ? 'behind_the_scenes' : 'product_showcase';
}

/** Brand ending length for an ad of `totalSec`: a share of the ad, clamped to 1.5–3 s. */
export function endCardSeconds(totalSec: number, ratio = 0.12) {
  return Math.round(Math.max(1.5, Math.min(3, totalSec * ratio)) * 10) / 10;
}
