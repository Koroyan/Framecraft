import type { AspectRatio, JobStatus, QualityMode, Resolution } from './constants';

/** Public shape of a model in the catalog (what the UI is allowed to see). */
export type PublicModel = {
  key: string;
  provider: string;
  displayName: string;
  family: string;
  status: 'active' | 'preview' | 'deprecated' | 'discontinued' | 'unverified';
  enabled: boolean;
  configured: boolean;
  routable: boolean;
  modes: string[];
  aspectRatios: AspectRatio[];
  resolutions: Resolution[];
  durations: { min: number; max: number; allowed?: number[] };
  nativeAudio: boolean;
  maxReferenceImages: number;
  firstLastFrame: boolean;
  cameraControl: boolean;
  qualityTier: number;
  qualitySource: 'measured' | 'provisional';
  fromUsdPerSecond: number;
  notes?: string;
  docsUrl?: string;
  verifiedAt?: string;
};

export type EstimateSegment = {
  modelKey: string;
  modelName: string;
  durationSec: number;
  billedDurationSec: number;
  resolution: Resolution;
  nativeAudio: boolean;
  providerCostUsd: number;
};

export type RoutingAlternative = {
  modelKey: string;
  modelName: string;
  credits: number;
  qualityTier: number;
  reason: string;
};

export type GenerationEstimate = {
  ok: boolean;
  credits: number;
  providerCostUsd: number;
  processingCostUsd: number;
  segments: EstimateSegment[];
  quality: QualityMode;
  requiredTier: number;
  explanation: string[];
  warnings: string[];
  alternatives: RoutingAlternative[];
  /** Present when no strategy satisfies the request. */
  blockers?: string[];
  /** True if the chosen model's provider has no credentials configured. */
  requiresConfiguration?: boolean;
  liveGenerationAvailable: boolean;
  pricingConfidence: 'verified' | 'partial' | 'unverified';
};

export type PublicJob = {
  id: string;
  kind: string;
  status: JobStatus;
  phase: string | null;
  progress: number | null;
  progressSource: 'provider' | 'phase';
  /** Estimated seconds until done (null when finished or unknown). Based on real history for the model. */
  etaSec: number | null;
  /** Seconds since the job started working (queued time excluded). */
  elapsedSec: number | null;
  projectId: string | null;
  shotId: string | null;
  modelKey: string | null;
  estimatedCredits: number;
  chargedCredits: number | null;
  error: { code: string; message: string; retryable: boolean } | null;
  outputAssetId: string | null;
  outputUrl: string | null;
  thumbnailUrl: string | null;
  isFixture: boolean;
  prompt: string | null;
  enhancedPrompt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type ApiError = { error: { code: string; message: string; details?: unknown } };
