import type { AspectRatio, GenerationMode, Resolution } from '@framecraft/shared';
import type { CatalogVideoModel, PricingConfidence, ProviderKey, VideoCapabilities } from '../../catalog/types';

export type HttpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Normalized, provider-independent request handed to an adapter. */
export type ProviderVideoRequest = {
  model: CatalogVideoModel;
  mode: GenerationMode;
  prompt: string;
  negativePrompt?: string;
  /** Aspect the model must render (may differ from the final target when we crop). */
  aspectRatio: AspectRatio;
  resolution: Resolution;
  /** A duration the model accepts (already rounded by the router). */
  durationSec: number;
  audio: boolean;
  seed?: number;
  /** First frame: HTTPS URL or data: URI. */
  image?: string;
  endImage?: string;
  references?: string[];
  /** Framecraft camera preset key; adapters map it to a real API parameter when one exists. */
  camera?: string;
  draft?: boolean;
};

export type OutputRef = {
  url?: string;
  /** Extra headers needed to download (e.g. Google requires the API key). */
  headers?: Record<string, string>;
  /** Some APIs return media inline. */
  inlineBase64?: string;
  localPath?: string;
  mimeType?: string;
};

export type NormalizedError = {
  code:
    | 'invalid_request'
    | 'auth'
    | 'rate_limited'
    | 'insufficient_provider_balance'
    | 'content_policy'
    | 'provider_unavailable'
    | 'bad_output'
    | 'timeout'
    | 'not_found'
    | 'cancelled'
    | 'unknown';
  message: string;
  retryable: boolean;
  /** Whether the provider refunds its own cost for this failure. */
  providerRefunds: boolean;
  providerCode?: string;
  httpStatus?: number;
};

export type ProviderStatus = {
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  /** 0..1 when the provider reports genuine progress. */
  progress?: number;
  /** Human-readable explanation of the provider-side state (e.g. waiting in the provider's queue). */
  note?: string;
  outputs?: OutputRef[];
  /** Provider-reported actual cost. */
  costUsd?: number;
  error?: NormalizedError;
  raw?: unknown;
};

export type SubmitResult = {
  externalId: string;
  raw: unknown;
  estimatedCostUsd?: number;
  /** Synchronous APIs return the finished result immediately. */
  immediate?: ProviderStatus;
};

export type SubmitContext = { idempotencyKey: string; webhookUrl?: string; signal?: AbortSignal };

export interface VideoProvider {
  readonly key: ProviderKey;
  readonly displayName: string;
  isConfigured(): boolean;
  getSupportedModels(): CatalogVideoModel[];
  getCapabilities(modelKey: string): VideoCapabilities | undefined;
  /** Returns a list of problems; empty means the request is valid for this model. */
  validateRequest(req: ProviderVideoRequest): string[];
  estimateCost(req: ProviderVideoRequest): { usd: number; confidence: PricingConfidence };
  /** Build the exact provider payload (exposed for contract tests and audit logs). */
  buildPayload(req: ProviderVideoRequest): { url: string; body: Record<string, unknown> };
  submitGeneration(req: ProviderVideoRequest, ctx: SubmitContext): Promise<SubmitResult>;
  getGenerationStatus(externalId: string, model: CatalogVideoModel): Promise<ProviderStatus>;
  retrieveOutput(status: ProviderStatus): OutputRef[];
  normalizeError(err: unknown): NormalizedError;
  cancelGeneration?(externalId: string, model: CatalogVideoModel): Promise<boolean>;
  /** Cheap authenticated call to confirm the credentials work (no generation cost). */
  checkCredentials?(): Promise<{ ok: boolean; message: string }>;
}

export class ProviderError extends Error {
  constructor(public readonly normalized: NormalizedError) {
    super(normalized.message);
    this.name = 'ProviderError';
  }
}

export class ProviderHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}
