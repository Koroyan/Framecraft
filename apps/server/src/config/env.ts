import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() && !/^(changeme|your[-_].*|xxx+|<.*>)$/i.test(v.trim()) ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_MODE: z.enum(['development', 'production']).optional(),
  PORT: z.coerce.number().int().default(4000),
  // Loopback by default so a dev machine never exposes the API on the LAN; containers set 0.0.0.0.
  HOST: z.string().default('127.0.0.1'),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  LOG_LEVEL: z.string().default('info'),

  // Database: a postgres:// URL, or pglite:<dir> for the embedded dev/test database.
  DATABASE_URL: z.string().default('pglite:./.data/pglite'),
  REDIS_URL: optionalSecret,

  // Auth
  SESSION_SECRET: z.string().min(32).optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  COOKIE_SECURE: bool.optional(),
  GOOGLE_OAUTH_CLIENT_ID: optionalSecret,
  GOOGLE_OAUTH_CLIENT_SECRET: optionalSecret,

  // Storage
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./.data/storage'),
  STORAGE_SIGNING_SECRET: z.string().min(32).optional(),
  S3_ENDPOINT: optionalSecret,
  /** Endpoint used in presigned URLs when the internal endpoint is not reachable by browsers/providers. */
  S3_PUBLIC_ENDPOINT: optionalSecret,
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: optionalSecret,
  S3_ACCESS_KEY_ID: optionalSecret,
  S3_SECRET_ACCESS_KEY: optionalSecret,
  S3_FORCE_PATH_STYLE: bool.default(false),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(2048).default(200),
  /** Resumable chunked uploads (phone 4K videos): the per-file limit, the chunk size, and per-user storage. */
  MAX_LARGE_UPLOAD_MB: z.coerce.number().int().min(1).max(65_536).default(8192),
  UPLOAD_CHUNK_MB: z.coerce.number().int().min(1).max(64).default(8),
  /** Total storage per user (0 = unlimited). */
  STORAGE_QUOTA_MB: z.coerce.number().int().min(0).default(51_200),

  // Media
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),

  // Video providers (official env var names from provider docs/examples)
  RUNWAYML_API_SECRET: optionalSecret,
  FAL_KEY: optionalSecret,
  LTX_API_KEY: optionalSecret,
  GEMINI_API_KEY: optionalSecret,
  REPLICATE_API_TOKEN: optionalSecret,
  PROVIDER_WEBHOOK_BASE_URL: z.string().url().optional(),

  // LLM (AI Director, prompt enhancement)
  ANTHROPIC_API_KEY: optionalSecret,
  LLM_MODEL_FAST: z.string().default('claude-haiku-5-5'),
  LLM_MODEL_SMART: z.string().default('claude-opus-5-5'),

  // Audio
  ELEVENLABS_API_KEY: optionalSecret,

  // Payments
  PAYMENT_PROVIDER: z.enum(['sandbox', 'stripe', 'none']).default('sandbox'),
  STRIPE_SECRET_KEY: optionalSecret,
  STRIPE_WEBHOOK_SECRET: optionalSecret,

  // Email
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: optionalSecret,
  EMAIL_FROM: z.string().default('Framecraft <no-reply@localhost>'),

  // Workers
  EMBEDDED_WORKER: bool.optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  PROVIDER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(6000),

  // Safety switches
  /** Must be true before any paid provider call is made. */
  LIVE_GENERATION_ENABLED: bool.default(false),
  /** Allows clearly-labelled fixture output in development. Never enabled in production. */
  DEV_FIXTURES_ENABLED: bool.optional(),
  GLOBAL_DAILY_PROVIDER_BUDGET_USD: z.coerce.number().min(0).default(50),
  /** Free credits for a new account. Production default 0: nothing is generated without paying. */
  SIGNUP_BONUS_CREDITS: z.coerce.number().int().min(0).optional(),

  // Access control (production defaults are strict; see loadEnv)
  /** open = anyone; invite = only SIGNUP_ALLOWLIST; closed = no new accounts. */
  SIGNUP_MODE: z.enum(['open', 'invite', 'closed']).optional(),
  /** Comma-separated emails and/or @domains allowed to register in invite mode. */
  SIGNUP_ALLOWLIST: z.string().default(''),
  /** Buying credits needs a verified email address. */
  REQUIRE_EMAIL_VERIFICATION: bool.optional(),
  /** Cloudflare Turnstile (bot protection on sign-up and sign-in). */
  TURNSTILE_SITE_KEY: optionalSecret,
  TURNSTILE_SECRET_KEY: optionalSecret,
  /** Daily credit cap given to every new account (they can lower it; raising it is their choice). */
  DEFAULT_DAILY_SPEND_LIMIT: z.coerce.number().int().min(0).optional(),
});

export type Env = Omit<z.infer<typeof envSchema>, 'SIGNUP_BONUS_CREDITS' | 'SIGNUP_MODE' | 'REQUIRE_EMAIL_VERIFICATION' | 'DEFAULT_DAILY_SPEND_LIMIT'> & {
  SIGNUP_BONUS_CREDITS: number;
  SIGNUP_MODE: 'open' | 'invite' | 'closed';
  REQUIRE_EMAIL_VERIFICATION: boolean;
  DEFAULT_DAILY_SPEND_LIMIT: number | null;
  signupAllowlist: string[];
  isProduction: boolean;
  isTest: boolean;
  sessionSecret: string;
  storageSigningSecret: string;
  embeddedWorker: boolean;
  devFixturesEnabled: boolean;
  cookieSecure: boolean;
};

let cached: Env | undefined;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // `KEY=` in a .env file means "not set".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production' || e.APP_MODE === 'production';
  const isTest = e.NODE_ENV === 'test';

  if (isProduction) {
    const missing: string[] = [];
    if (!e.SESSION_SECRET) missing.push('SESSION_SECRET');
    if (!e.STORAGE_SIGNING_SECRET) missing.push('STORAGE_SIGNING_SECRET');
    if (e.DATABASE_URL.startsWith('pglite:')) missing.push('DATABASE_URL (PostgreSQL required in production)');
    if (e.STORAGE_DRIVER === 's3' && (!e.S3_BUCKET || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY)) missing.push('S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY');
    if (e.DEV_FIXTURES_ENABLED) missing.push('DEV_FIXTURES_ENABLED must be false in production');
    // Public sign-ups without bot protection would let anyone farm accounts.
    if ((e.SIGNUP_MODE ?? 'invite') === 'open' && !e.TURNSTILE_SECRET_KEY) missing.push('TURNSTILE_SECRET_KEY (required when SIGNUP_MODE=open)');
    if ((e.REQUIRE_EMAIL_VERIFICATION ?? true) && e.EMAIL_PROVIDER === 'console') missing.push('EMAIL_PROVIDER=resend + RESEND_API_KEY (email verification is on)');
    if (e.EMAIL_PROVIDER === 'resend' && !e.RESEND_API_KEY) missing.push('RESEND_API_KEY');
    if (e.PAYMENT_PROVIDER === 'stripe' && (!e.STRIPE_SECRET_KEY || !e.STRIPE_WEBHOOK_SECRET)) missing.push('STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET');
    if (missing.length) throw new Error(`Production configuration incomplete:\n${missing.map((m) => `  - ${m}`).join('\n')}`);
  }

  const devSecret = 'dev-only-insecure-secret-do-not-use-in-production-0000';
  return {
    ...e,
    isProduction,
    isTest,
    sessionSecret: e.SESSION_SECRET ?? devSecret,
    storageSigningSecret: e.STORAGE_SIGNING_SECRET ?? e.SESSION_SECRET ?? devSecret,
    embeddedWorker: e.EMBEDDED_WORKER ?? e.DATABASE_URL.startsWith('pglite:'),
    devFixturesEnabled: isProduction ? false : (e.DEV_FIXTURES_ENABLED ?? true),
    cookieSecure: e.COOKIE_SECURE ?? isProduction,
    SIGNUP_BONUS_CREDITS: e.SIGNUP_BONUS_CREDITS ?? (isProduction ? 0 : 300),
    SIGNUP_MODE: e.SIGNUP_MODE ?? (isProduction ? 'invite' : 'open'),
    REQUIRE_EMAIL_VERIFICATION: e.REQUIRE_EMAIL_VERIFICATION ?? isProduction,
    DEFAULT_DAILY_SPEND_LIMIT: e.DEFAULT_DAILY_SPEND_LIMIT ?? (isProduction ? 1000 : null),
    signupAllowlist: e.SIGNUP_ALLOWLIST.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  };
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

export function setEnvForTests(overrides: Record<string, string | undefined>): Env {
  cached = loadEnv({ ...process.env, NODE_ENV: 'test', ...overrides });
  return cached;
}
