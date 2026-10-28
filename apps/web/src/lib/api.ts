import type { GenerationEstimate, PublicJob, PublicModel, TemplateDefinition, Timeline, VideoSpecInput } from '@framecraft/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body || init.form ? 'POST' : 'GET'),
    headers: init.form ? undefined : init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    credentials: 'same-origin',
    signal: init.signal,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } }).error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data as T;
}

// ------------------------------------------------------------------ shared response types

export type Me = {
  user: { id: string; email: string; name: string; role: 'user' | 'admin'; locale: string; emailVerified?: boolean } | null;
  verificationRequired?: boolean;
  wallet?: { balance: number; reserved: number; available: number };
  plan?: { key: string; name: string; limits: { maxConcurrentJobs: number; maxClipSeconds: number; maxMovieSeconds: number; maxResolution: string; qualityModes: string[]; watermark: boolean; commercialUse: boolean } };
};

export type SystemStatus = {
  signupMode?: 'open' | 'invite' | 'closed';
  turnstileSiteKey?: string | null;
  signupBonusCredits?: number;
  mode: 'development' | 'production';
  liveGenerationEnabled: boolean;
  configuredProviders: string[];
  aiDirector: 'llm' | 'offline';
  devFixtures: boolean;
  audio: boolean;
  images: boolean;
  payments: string;
};

export type Asset = {
  id: string;
  kind: string;
  mediaType: 'video' | 'image' | 'audio' | 'text';
  url: string;
  downloadUrl?: string;
  thumbnailUrl?: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  originalName: string | null;
  isFixture: boolean;
  createdAt: string;
  projectId: string | null;
  source: Record<string, unknown>;
};

export type Project = {
  id: string;
  kind: 'quick' | 'social' | 'cinematic' | 'movie' | 'edit' | 'ad';
  title: string;
  status: string;
  aspectRatio: string;
  templateKey: string | null;
  thumbnailUrl?: string | null;
  generations?: number;
  createdAt: string;
  updatedAt: string;
  plan?: { title?: string; logline?: string; genre?: string; source?: string } | null;
  settings: Record<string, unknown>;
};

export type Character = {
  id: string;
  name: string;
  description: string;
  appearance: Record<string, string | undefined>;
  clothing: string;
  styleMeta: Record<string, string>;
  voice: Record<string, string | undefined>;
  references: { assetId: string; isPrimary: boolean; url: string; isFixture: boolean }[];
  likenessConsentAt: string | null;
  /** Where the character is used (Character Bible). */
  usage?: { shots: number; generated: number; projects: number };
};

export type Location = { id: string; name: string; description: string; references: { assetId: string; url: string }[] };

export type { GenerationEstimate, PublicJob, PublicModel, TemplateDefinition, Timeline, VideoSpecInput };

export const endpoints = {
  me: () => api<Me>('/api/auth/me'),
  status: () => api<SystemStatus>('/api/system/status'),
  models: () => api<{ models: PublicModel[] }>('/api/models'),
  templates: () => api<{ templates: (TemplateDefinition & { featured: boolean })[] }>('/api/templates'),
  estimate: (spec: VideoSpecInput) => api<{ estimate: GenerationEstimate }>('/api/generations/estimate', { body: { spec } }),
  generate: (body: { spec: VideoSpecInput; projectId?: string; templateKey?: string; idempotencyKey: string; confirmEstimate: boolean }) =>
    api<{ job: PublicJob; estimate: GenerationEstimate }>('/api/generations', { body }),
  job: (id: string) => api<{ job: PublicJob; estimate: GenerationEstimate | null; request: Record<string, unknown>; attempts: unknown[] }>(`/api/generations/${id}`),
  jobs: (q = '') => api<{ jobs: PublicJob[] }>(`/api/generations${q}`),
  cancel: (id: string) => api<{ job: PublicJob }>(`/api/generations/${id}/cancel`, { body: {} }),
  retry: (id: string, idempotencyKey: string) => api<{ job: PublicJob }>(`/api/generations/${id}/retry`, { body: { idempotencyKey } }),
  projects: (q = '') => api<{ projects: Project[] }>(`/api/projects${q}`),
  assets: (q = '') => api<{ assets: Asset[] }>(`/api/assets${q}`),
  upload: (file: File, fields: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set('file', file);
    return api<{ asset: Asset }>('/api/assets', { form });
  },
};
