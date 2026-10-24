import { z } from 'zod';
import { ASPECT_RATIOS, QUALITY_MODES, RESOLUTIONS, LANGUAGES } from './constants';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), 'Use letters and numbers');

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(80),
  acceptTerms: z.literal(true, { message: 'You must accept the Terms and AI content policy' }),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const aspectRatioSchema = z.enum(ASPECT_RATIOS);
export const qualityModeSchema = z.enum(QUALITY_MODES);
export const resolutionSchema = z.enum(RESOLUTIONS);
export const languageSchema = z.enum(LANGUAGES.map((l) => l.code) as [string, ...string[]]);

/** The user-facing description of a single video clip to generate. */
export const videoSpecSchema = z.object({
  prompt: z.string().trim().min(3, 'Describe your video').max(4000),
  negativePrompt: z.string().max(1000).optional(),
  aspectRatio: aspectRatioSchema.default('9:16'),
  durationSec: z.number().int().min(2).max(60).default(10),
  quality: qualityModeSchema.default('balanced'),
  /** Minimum output resolution. Never silently downgraded. */
  resolution: resolutionSchema.optional(),
  style: z.string().max(40).optional(),
  camera: z.string().max(40).optional(),
  lighting: z.string().max(40).optional(),
  lens: z.string().max(40).optional(),
  colorGrade: z.string().max(40).optional(),
  mood: z.string().max(40).optional(),
  shotType: z.string().max(40).optional(),
  /** Require the model to generate native audio. */
  nativeAudio: z.boolean().default(false),
  imageAssetId: z.string().uuid().optional(),
  endImageAssetId: z.string().uuid().optional(),
  referenceAssetIds: z.array(z.string().uuid()).max(7).default([]),
  characterIds: z.array(z.string().uuid()).max(5).default([]),
  /** Saved locations (their photos and description keep the place consistent). */
  locationIds: z.array(z.string().uuid()).max(2).default([]),
  /**
   * With characters, locations or reference photos: draw the first frame from them, then animate
   * it — the look stays consistent and cheaper image-to-video models can be used.
   */
  keyframe: z.boolean().default(true),
  /** Manual model choice. Undefined means automatic routing. */
  modelKey: z.string().max(80).optional(),
  enhancePrompt: z.boolean().default(true),
  seed: z.number().int().min(0).max(4294967295).optional(),
  /** Maximum credits the user is willing to spend on this clip. */
  maxCredits: z.number().int().positive().optional(),
  /** Draft = cheap preview render; final = full quality. */
  renderPass: z.enum(['draft', 'final']).default('final'),
});
export type VideoSpec = z.infer<typeof videoSpecSchema>;
export type VideoSpecInput = z.input<typeof videoSpecSchema>;

export const createGenerationSchema = z.object({
  spec: videoSpecSchema,
  projectId: z.string().uuid().optional(),
  shotId: z.string().uuid().optional(),
  templateKey: z.string().max(60).optional(),
  /** Client generated key; repeated submissions with the same key never double-charge. */
  idempotencyKey: z.string().min(8).max(100),
  /** The user explicitly approved the estimate. Required for paid work. */
  confirmEstimate: z.boolean().default(false),
});
export type CreateGenerationInput = z.input<typeof createGenerationSchema>;

export const estimateSchema = z.object({ spec: videoSpecSchema });

export const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  kind: z.enum(['quick', 'social', 'cinematic', 'movie', 'edit', 'ad']).default('quick'),
  aspectRatio: aspectRatioSchema.default('9:16'),
  templateKey: z.string().max(60).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const updateProjectSchema = createProjectSchema.partial().extend({
  status: z.enum(['active', 'archived']).optional(),
});

export const characterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).default(''),
  appearance: z
    .object({
      age: z.string().max(40).optional(),
      gender: z.string().max(40).optional(),
      hair: z.string().max(200).optional(),
      eyes: z.string().max(100).optional(),
      build: z.string().max(100).optional(),
      distinguishing: z.string().max(400).optional(),
    })
    .default({}),
  clothing: z.string().max(600).default(''),
  styleMeta: z.record(z.string(), z.string()).default({}),
  voice: z
    .object({
      provider: z.string().max(40).optional(),
      voiceId: z.string().max(120).optional(),
      language: z.string().max(8).optional(),
      style: z.string().max(80).optional(),
    })
    .default({}),
  referenceAssetIds: z.array(z.string().uuid()).max(8).default([]),
  /** User confirms they have rights/consent for any real person depicted. */
  likenessConsent: z.boolean().default(false),
});

export const locationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).default(''),
  styleMeta: z.record(z.string(), z.string()).default({}),
  referenceAssetIds: z.array(z.string().uuid()).max(8).default([]),
});

export const movieBriefSchema = z.object({
  idea: z.string().trim().min(10).max(4000),
  lengthSec: z.number().int().min(15).max(600).default(60),
  aspectRatio: aspectRatioSchema.default('16:9'),
  quality: qualityModeSchema.default('high'),
  style: z.string().max(40).default('cinematic'),
  genre: z.string().max(40).optional(),
  language: languageSchema.default('en'),
  withDialogue: z.boolean().default(true),
  withMusic: z.boolean().default(true),
  /** Draw each shot's keyframe first (with the characters' photos), then animate it — consistent and cheaper. */
  keyframes: z.boolean().default(true),
  mode: z.enum(['auto', 'director']).default('director'),
  /**
   * Optional user photos the story can refer to as photo1, photo2… (characters, places,
   * products). Without photos the AI Director invents everything itself.
   */
  references: z
    .array(
      z.object({
        token: z.string().regex(/^photo([1-9]|1[0-2])$/, 'Tokens are photo1 … photo12'),
        assetId: z.string().uuid(),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .max(12)
    .default([])
    .refine((refs) => new Set(refs.map((r) => r.token)).size === refs.length, 'Each photo token must be unique'),
});
export type MovieBrief = z.infer<typeof movieBriefSchema>;
export type MovieReference = MovieBrief['references'][number];

/** photo1, photo2… mentioned in a text (case-insensitive, de-duplicated, in order). */
export function photoTokensIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\bphoto([1-9]|1[0-2])\b/gi)].map((m) => `photo${m[1]}`))];
}

export const conceptsRequestSchema = z.object({
  idea: z.string().trim().min(3).max(2000),
  platform: z.string().max(30).default('tiktok'),
  durationSec: z.number().int().min(5).max(120).default(15),
  templateKey: z.string().max(60).optional(),
  language: languageSchema.default('en'),
});

export const socialCopyRequestSchema = z.object({
  topic: z.string().trim().min(3).max(2000),
  platform: z.string().max(30).default('tiktok'),
  tone: z.string().max(80).optional(),
  language: languageSchema.default('en'),
});

// ---------------- Timeline (editor) ----------------

export const transitionSchema = z.object({
  type: z.enum(['cut', 'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideup', 'circleopen', 'fadeblack']),
  durationSec: z.number().min(0).max(3).default(0.5),
});

/** Manual colour adjustments; identical maths in the browser preview (SVG filter) and the FFmpeg export. */
export const clipAdjustSchema = z.object({
  exposure: z.number().min(-2).max(2).default(0),
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(-1).max(1).default(0),
  saturation: z.number().min(-1).max(1).default(0),
  temperature: z.number().min(-1).max(1).default(0),
  tint: z.number().min(-1).max(1).default(0),
  hue: z.number().min(-180).max(180).default(0),
  highlights: z.number().min(-1).max(1).default(0),
  shadows: z.number().min(-1).max(1).default(0),
  blur: z.number().min(0).max(20).default(0),
  sharpen: z.number().min(0).max(2).default(0),
  vignette: z.number().min(0).max(1).default(0),
});
export type ClipAdjust = z.infer<typeof clipAdjustSchema>;

/** 2D camera on existing frames: a framing window (centre x/y, zoom, rotation) keyframed over the clip. */
export const cameraKeyframeSchema = z.object({
  /** Seconds from the start of the clip (timeline time). */
  t: z.number().min(0).max(600),
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.5),
  scale: z.number().min(1).max(4).default(1),
  rotation: z.number().min(-45).max(45).default(0),
});
export type CameraKeyframe = z.infer<typeof cameraKeyframeSchema>;
export const clipCameraSchema = z.object({
  keyframes: z.array(cameraKeyframeSchema).min(1).max(16),
  easing: z.enum(['linear', 'ease']).default('ease'),
  preset: z.string().max(40).optional(),
});
export type ClipCamera = z.infer<typeof clipCameraSchema>;

export const timelineClipSchema = z.object({
  id: z.string().min(1).max(64),
  assetId: z.string().uuid(),
  /** Source in/out points in seconds. */
  inSec: z.number().min(0),
  outSec: z.number().positive(),
  volume: z.number().min(0).max(2).default(1),
  /** Transition into the next clip. */
  transition: transitionSchema.optional(),
  shotId: z.string().uuid().optional(),
  /** The shot version this clip plays (see shot versions). */
  versionId: z.string().uuid().optional(),
  label: z.string().max(120).optional(),
  /** Playback speed (0.25–4×); the clip lasts (out − in) / speed on the timeline. */
  speed: z.number().min(0.25).max(4).default(1),
  reverse: z.boolean().default(false),
  /** Freeze frame: hold the frame at `inSec` for this many seconds instead of playing. */
  freezeSec: z.number().min(0.2).max(30).optional(),
  fadeInSec: z.number().min(0).max(5).default(0),
  fadeOutSec: z.number().min(0).max(5).default(0),
  /** Fade towards black (1 = fully visible). */
  opacity: z.number().min(0).max(1).default(1),
  adjust: clipAdjustSchema.optional(),
  camera: clipCameraSchema.optional(),
});
export type TimelineClip = z.infer<typeof timelineClipSchema>;

export const audioClipSchema = z.object({
  id: z.string().min(1).max(64),
  assetId: z.string().uuid(),
  kind: z.enum(['music', 'voice', 'sfx']).default('music'),
  startSec: z.number().min(0),
  inSec: z.number().min(0).default(0),
  outSec: z.number().positive(),
  volume: z.number().min(0).max(2).default(0.8),
  fadeInSec: z.number().min(0).max(10).default(0),
  fadeOutSec: z.number().min(0).max(10).default(0),
  muted: z.boolean().default(false),
});
export type AudioClip = z.infer<typeof audioClipSchema>;

export const textOverlaySchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(300),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  position: z.enum(['top', 'center', 'bottom']).default('bottom'),
  fontSize: z.number().int().min(12).max(160).default(56),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFFFFF'),
  background: z.boolean().default(true),
});
export type TextOverlay = z.infer<typeof textOverlaySchema>;

/** Picture-in-picture / overlay track (V2): an image or video above the main track. */
export const overlaySchema = z.object({
  id: z.string().min(1).max(64),
  assetId: z.string().uuid(),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  /** Top-left corner and width as fractions of the frame (height follows the media's aspect). */
  x: z.number().min(0).max(1).default(0.6),
  y: z.number().min(0).max(1).default(0.05),
  w: z.number().min(0.05).max(1).default(0.35),
  opacity: z.number().min(0.05).max(1).default(1),
  /** Source offset for video overlays. */
  inSec: z.number().min(0).default(0),
});
export type Overlay = z.infer<typeof overlaySchema>;

export const subtitleCueSchema = z.object({
  id: z.string().min(1).max(64),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  text: z.string().min(1).max(500),
});
export type SubtitleCue = z.infer<typeof subtitleCueSchema>;

export const timelineSchema = z.object({
  version: z.literal(1).default(1),
  aspectRatio: aspectRatioSchema.default('9:16'),
  resolution: z.enum(['480p', '720p', '1080p']).default('1080p'),
  fps: z.number().int().min(12).max(60).default(30),
  clips: z.array(timelineClipSchema).max(300).default([]),
  audio: z.array(audioClipSchema).max(50).default([]),
  texts: z.array(textOverlaySchema).max(200).default([]),
  subtitles: z.array(subtitleCueSchema).max(2000).default([]),
  overlays: z.array(overlaySchema).max(50).default([]),
  burnSubtitles: z.boolean().default(true),
  /** Mute the original clip audio (e.g. when narration replaces it). */
  muteClipAudio: z.boolean().default(false),
  logo: z
    .object({
      assetId: z.string().uuid(),
      /** The uploaded logo when `assetId` points to its transparent (no background) variant. */
      originalAssetId: z.string().uuid().optional(),
      position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('top-right'),
      /** Free placement (logo's top-left corner as a fraction of the frame). Overrides `position` when set. */
      x: z.number().min(0).max(1).optional(),
      y: z.number().min(0).max(1).optional(),
      scale: z.number().min(0.03).max(0.5).default(0.12),
      opacity: z.number().min(0.1).max(1).default(0.9),
    })
    .optional(),
});
export type Timeline = z.infer<typeof timelineSchema>;
export type TimelineInput = z.input<typeof timelineSchema>;

export const renderRequestSchema = z.object({
  timeline: timelineSchema,
  preset: z.enum(['tiktok', 'reels', 'shorts', 'youtube', 'feed', 'master']).default('master'),
  idempotencyKey: z.string().min(8).max(100),
});

/** How long a clip lasts on the timeline (speed and freeze frames included). */
export function clipDuration(c: Pick<TimelineClip, 'inSec' | 'outSec'> & Partial<Pick<TimelineClip, 'speed' | 'freezeSec'>>): number {
  if (c.freezeSec) return c.freezeSec;
  return Math.max(0, c.outSec - c.inSec) / (c.speed || 1);
}

export function timelineDuration(t: { clips: (Pick<TimelineClip, 'inSec' | 'outSec' | 'transition'> & Partial<Pick<TimelineClip, 'speed' | 'freezeSec'>>)[] }): number {
  let total = 0;
  t.clips.forEach((c, i) => {
    total += clipDuration(c);
    const prev = i > 0 ? t.clips[i - 1] : undefined;
    if (prev?.transition && prev.transition.type !== 'cut') total -= prev.transition.durationSec;
  });
  return Math.max(0, Math.round(total * 1000) / 1000);
}
