import type { Env } from './config/env';
import { createDb, runMigrations, type Db, type DbHandle } from './db/client';
import { createStorage, type StorageDriver } from './storage/storage';
import { createVideoProviders, type VideoProviderMap, type HttpFetch } from './providers/video';
import { ElevenLabsProvider } from './providers/audio/elevenlabs';
import { ImageService } from './providers/image/image';
import { AnthropicLlm, type LlmClient } from './director/llm';
import { Director } from './director/director';
import { configuredProviders, syncCatalog } from './services/registry';
import { seedReferenceData } from './db/seed';
import type { ProviderKey } from './catalog/types';

export type Logger = { info: (msg: string, extra?: unknown) => void; warn: (msg: string, extra?: unknown) => void; error: (msg: string, extra?: unknown) => void };

export type AppContext = {
  env: Env;
  db: Db;
  dbHandle: DbHandle;
  storage: StorageDriver;
  video: VideoProviderMap;
  audio: ElevenLabsProvider;
  images: ImageService;
  llm: LlmClient;
  director: Director;
  /** Providers with credentials present. */
  configured: Set<ProviderKey>;
  /** Paid provider calls are allowed (LIVE_GENERATION_ENABLED + credentials). */
  liveEnabled: boolean;
  fetch: HttpFetch;
  log: Logger;
};

export type ContextOverrides = { fetch?: HttpFetch; llm?: LlmClient; dbHandle?: DbHandle; storage?: StorageDriver; log?: Logger };

const consoleLogger: Logger = {
  info: (m, e) => console.log(`[info] ${m}`, e ?? ''),
  warn: (m, e) => console.warn(`[warn] ${m}`, e ?? ''),
  error: (m, e) => console.error(`[error] ${m}`, e ?? ''),
};

export async function createContext(env: Env, o: ContextOverrides = {}): Promise<AppContext> {
  const dbHandle = o.dbHandle ?? (await createDb(env.DATABASE_URL));
  await runMigrations(dbHandle);
  await syncCatalog(dbHandle.db);
  await seedReferenceData(dbHandle.db);
  const fetchImpl = o.fetch ?? fetch;
  const llm = o.llm ?? new AnthropicLlm(env.ANTHROPIC_API_KEY, { fast: env.LLM_MODEL_FAST, smart: env.LLM_MODEL_SMART });
  const configured = configuredProviders(env as unknown as Record<string, unknown>);
  return {
    env,
    db: dbHandle.db,
    dbHandle,
    storage: o.storage ?? createStorage(env),
    video: createVideoProviders(env, fetchImpl),
    audio: new ElevenLabsProvider(env.ELEVENLABS_API_KEY, fetchImpl),
    images: new ImageService({ fal: env.FAL_KEY, runway: env.RUNWAYML_API_SECRET }, fetchImpl),
    llm,
    director: new Director(llm),
    configured,
    liveEnabled: env.LIVE_GENERATION_ENABLED,
    fetch: fetchImpl,
    log: o.log ?? consoleLogger,
  };
}

/** Providers usable for paid generation right now. */
export function liveProviders(ctx: AppContext): Set<ProviderKey> {
  return ctx.liveEnabled ? ctx.configured : new Set();
}
