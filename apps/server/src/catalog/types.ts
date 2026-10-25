import type { AspectRatio, GenerationMode, Resolution } from '@framecraft/shared';

export type ProviderKey = 'runway' | 'fal' | 'ltx' | 'google' | 'replicate' | 'fixture' | 'elevenlabs' | 'anthropic';

export type ModelStatus = 'active' | 'preview' | 'deprecated' | 'discontinued' | 'unverified';

export type VideoCapabilities = {
  modes: GenerationMode[];
  /** Output aspect ratios selectable for text-to-video. */
  aspectRatios: AspectRatio[];
  /** Image-to-video output follows the input image aspect instead of a ratio parameter. */
  aspectFollowsImage?: boolean;
  resolutions: Resolution[];
  durations: { min: number; max: number; allowed?: number[] };
  /** Optional per-resolution duration restrictions. */
  durationsByResolution?: Partial<Record<Resolution, number[]>>;
  /**
   * Native audio support *as an explicit, documented request parameter*.
   * Models whose marketing mentions audio but expose no parameter are 'none'
   * here so routing never promises audio it cannot verify.
   */
  nativeAudio: 'none' | 'optional' | 'always';
  /** Accepts reference audio the picture follows (lip-sync to a supplied voice). Max total seconds. */
  referenceAudio?: { maxSec: number };
  maxReferenceImages: number;
  /** Real camera-control API parameter (not prompt text). */
  cameraControl?: string[];
  negativePrompt: boolean;
  seed: boolean;
  maxPromptChars: number;
  draftMode?: boolean;
};

export type PriceRow = {
  resolution: Resolution;
  /** true = price with native audio; false = without; 'any' = same price either way. */
  audio: boolean | 'any';
  usdPerSecond: number;
  usdPerReference?: number;
  minimumUsd?: number;
};

export type PricingConfidence = 'verified' | 'partial' | 'unverified';

export type CatalogVideoModel = {
  key: string;
  kind: 'video';
  provider: ProviderKey;
  providerModelId: string;
  displayName: string;
  /** Underlying model family — the same family on two providers shares quality evidence. */
  family: string;
  status: ModelStatus;
  capabilities: VideoCapabilities;
  pricing: PriceRow[];
  pricingConfidence: PricingConfidence;
  /**
   * Provisional quality tier 1–5. These are editorial priors derived from each
   * vendor's own positioning (flagship / standard / fast / lite), NOT benchmark
   * results. Measured evaluations replace them once enough ratings exist.
   */
  qualityTier: number;
  docsUrl: string;
  verifiedAt: string;
  notes?: string;
  /** Adapter-specific options (ratio strings, endpoint ids...). */
  providerOptions?: Record<string, unknown>;
};

export type CatalogImageModel = {
  key: string;
  kind: 'image';
  provider: ProviderKey;
  providerModelId: string;
  displayName: string;
  status: ModelStatus;
  usdPerImage: number;
  /** Requires reference images (good for character-consistent frames). */
  requiresReferences?: boolean;
  maxReferences: number;
  qualityTier: number;
  docsUrl: string;
  verifiedAt: string;
  notes?: string;
};

export type CatalogAudioModel = {
  key: string;
  kind: 'audio';
  provider: ProviderKey;
  providerModelId: string;
  displayName: string;
  task: 'tts' | 'stt' | 'music' | 'sfx';
  status: ModelStatus;
  languages?: string[];
  /** Price unit depends on task: per 1k characters (tts), per hour (stt), per minute (music/sfx). */
  usdPerUnit: number;
  unit: 'per_1k_chars' | 'per_hour' | 'per_minute';
  qualityTier: number;
  docsUrl: string;
  verifiedAt: string;
  notes?: string;
};

export type CatalogModel = CatalogVideoModel | CatalogImageModel | CatalogAudioModel;
