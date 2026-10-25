import {
  pgTable,
  pgEnum,
  text,
  uuid,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  numeric,
  real,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const usd = (name: string) => numeric(name, { precision: 12, scale: 4, mode: 'number' });

export const userRole = pgEnum('user_role', ['user', 'admin']);
export const userStatus = pgEnum('user_status', ['active', 'suspended']);
export const projectKind = pgEnum('project_kind', ['quick', 'social', 'cinematic', 'movie', 'edit', 'ad']);
export const jobStatus = pgEnum('job_status', ['draft', 'queued', 'preparing', 'generating', 'processing', 'rendering', 'completed', 'failed', 'cancelled']);
export const jobKind = pgEnum('job_kind', ['video', 'image', 'audio', 'render', 'plan', 'movie', 'edit']);
export const assetKind = pgEnum('asset_kind', ['upload', 'generated', 'render', 'thumbnail', 'reference', 'audio', 'subtitle', 'frame']);
export const mediaType = pgEnum('media_type', ['video', 'image', 'audio', 'text']);
export const txType = pgEnum('credit_tx_type', ['grant', 'purchase', 'subscription_allowance', 'reserve', 'release', 'capture', 'refund', 'adjustment', 'expire']);
export const reservationStatus = pgEnum('reservation_status', ['held', 'captured', 'released']);
export const paymentStatus = pgEnum('payment_status', ['pending', 'succeeded', 'failed', 'refunded', 'cancelled']);
export const queueStatus = pgEnum('queue_status', ['pending', 'running', 'completed', 'failed', 'dead']);

// ---------------------------------------------------------------- identity

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash'),
    role: userRole('role').notNull().default('user'),
    status: userStatus('status').notNull().default('active'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    locale: text('locale').notNull().default('en'),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email), index('users_created_idx').on(t.createdAt)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

/** OAuth-linked identities (OAuth-ready; provider flows enabled when credentials exist). */
export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('accounts_provider_uq').on(t.provider, t.providerAccountId), index('accounts_user_idx').on(t.userId)],
);

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  defaultQuality: text('default_quality').notNull().default('balanced'),
  defaultAspectRatio: text('default_aspect_ratio').notNull().default('9:16'),
  language: text('language').notNull().default('en'),
  brandKit: jsonb('brand_kit').$type<{ colors: string[]; logoAssetId?: string; fontFamily?: string; name?: string }>().notNull().default({ colors: [] }),
  /** Credits; null = no personal cap. */
  dailySpendLimit: integer('daily_spend_limit'),
  perJobSpendLimit: integer('per_job_spend_limit'),
  notifyEmail: boolean('notify_email').notNull().default(true),
  updatedAt: updatedAt(),
});

export const consents = pgTable(
  'consents',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // terms | ai_content | likeness | voice | commercial | copyright
    version: text('version').notNull(),
    subjectRef: text('subject_ref'), // e.g. character id or asset id
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('consents_user_idx').on(t.userId, t.kind)],
);

// ---------------------------------------------------------------- projects & assets

export const projects = pgTable(
  'projects',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: projectKind('kind').notNull().default('quick'),
    title: text('title').notNull(),
    status: text('status').notNull().default('active'),
    aspectRatio: text('aspect_ratio').notNull().default('9:16'),
    templateKey: text('template_key'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /** Movie / social plan (screenplay, concept, copy). */
    plan: jsonb('plan').$type<Record<string, unknown> | null>(),
    thumbnailAssetId: uuid('thumbnail_asset_id'),
    budgetCredits: integer('budget_credits'),
    approvedBudgetCredits: integer('approved_budget_credits'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_user_idx').on(t.userId, t.updatedAt)],
);

export const projectVersions = pgTable(
  'project_versions',
  {
    id: id(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    label: text('label'),
    timeline: jsonb('timeline').$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('project_versions_uq').on(t.projectId, t.version)],
);

export const assets = pgTable(
  'assets',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    kind: assetKind('kind').notNull(),
    mediaType: mediaType('media_type').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    sha256: text('sha256'),
    originalName: text('original_name'),
    thumbnailAssetId: uuid('thumbnail_asset_id'),
    /** Provenance: provider/model/job for generated media. */
    source: jsonb('source').$type<Record<string, unknown>>().notNull().default({}),
    /** True for development sample media. Never presented as AI output. */
    isFixture: boolean('is_fixture').notNull().default(false),
    hasAudio: boolean('has_audio'),
    retentionUntil: timestamp('retention_until', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('assets_user_idx').on(t.userId, t.createdAt),
    index('assets_project_idx').on(t.projectId),
    index('assets_sha_idx').on(t.userId, t.sha256),
  ],
);

// ---------------------------------------------------------------- characters & locations

export const characters = pgTable(
  'characters',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    appearance: jsonb('appearance').$type<Record<string, string | undefined>>().notNull().default({}),
    clothing: text('clothing').notNull().default(''),
    styleMeta: jsonb('style_meta').$type<Record<string, string>>().notNull().default({}),
    voice: jsonb('voice').$type<Record<string, string | undefined>>().notNull().default({}),
    likenessConsentAt: timestamp('likeness_consent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('characters_user_idx').on(t.userId)],
);

export const characterReferences = pgTable(
  'character_references',
  {
    characterId: uuid('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    label: text('label'),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.characterId, t.assetId] })],
);

export const locations = pgTable(
  'locations',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    styleMeta: jsonb('style_meta').$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('locations_user_idx').on(t.userId)],
);

export const locationReferences = pgTable(
  'location_references',
  {
    locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.locationId, t.assetId] })],
);

// ---------------------------------------------------------------- film structure

export const scenes = pgTable(
  'scenes',
  {
    id: id(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    title: text('title').notNull(),
    synopsis: text('synopsis').notNull().default(''),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    /** Continuity facts that must hold across this scene's shots. */
    continuity: jsonb('continuity').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('scenes_project_idx').on(t.projectId, t.index)],
);

export const shots = pgTable(
  'shots',
  {
    id: id(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    description: text('description').notNull().default(''),
    prompt: text('prompt').notNull().default(''),
    durationSec: integer('duration_sec').notNull().default(5),
    shotType: text('shot_type'),
    camera: text('camera'),
    characterIds: jsonb('character_ids').$type<string[]>().notNull().default([]),
    /** Extra user reference images for this shot (objects/products from the brief's photoN tokens). */
    referenceAssetIds: jsonb('reference_asset_ids').$type<string[]>().notNull().default([]),
    dialogue: jsonb('dialogue').$type<{ characterId?: string; speaker: string; line: string }[]>().notNull().default([]),
    sfx: text('sfx'),
    modelOverride: text('model_override'),
    quality: text('quality'),
    status: text('status').notNull().default('planned'), // planned|storyboarded|queued|generating|ready|failed
    storyboardAssetId: uuid('storyboard_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    currentAssetId: uuid('current_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    lastJobId: uuid('last_job_id'),
    /** The shot version used by the movie (its asset is `currentAssetId`). */
    activeVersionId: uuid('active_version_id'),
    continuityFlags: jsonb('continuity_flags').$type<{ kind: string; message: string; severity: 'info' | 'warn' }[]>().notNull().default([]),
    approved: boolean('approved').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('shots_scene_idx').on(t.sceneId, t.index), index('shots_project_idx').on(t.projectId)],
);

export const storyboards = pgTable(
  'storyboards',
  {
    id: id(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    source: text('source').notNull(), // llm | offline | user
    createdAt: createdAt(),
  },
  (t) => [index('storyboards_project_idx').on(t.projectId, t.version)],
);

// ---------------------------------------------------------------- model registry

export const providers = pgTable('providers', {
  key: text('key').primaryKey(),
  displayName: text('display_name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: updatedAt(),
});

export const modelRegistry = pgTable(
  'model_registry',
  {
    key: text('key').primaryKey(),
    providerKey: text('provider_key').notNull().references(() => providers.key),
    providerModelId: text('provider_model_id').notNull(),
    displayName: text('display_name').notNull(),
    family: text('family').notNull(),
    kind: text('kind').notNull().default('video'), // video | image | audio | llm
    status: text('status').notNull(), // active | preview | deprecated | discontinued | unverified
    enabled: boolean('enabled').notNull().default(true),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().notNull(),
    qualityTier: real('quality_tier').notNull(),
    qualitySource: text('quality_source').notNull().default('provisional'),
    reliability: real('reliability').notNull().default(0.95),
    docsUrl: text('docs_url'),
    verifiedAt: text('verified_at'),
    notes: text('notes'),
    updatedAt: updatedAt(),
  },
  (t) => [index('model_registry_provider_idx').on(t.providerKey)],
);

export const modelPricing = pgTable(
  'model_pricing',
  {
    id: id(),
    modelKey: text('model_key').notNull().references(() => modelRegistry.key, { onDelete: 'cascade' }),
    resolution: text('resolution').notNull(),
    audio: boolean('audio').notNull().default(false),
    usdPerSecond: usd('usd_per_second').notNull(),
    usdPerRequest: usd('usd_per_request').notNull().default(0),
    usdPerReference: usd('usd_per_reference').notNull().default(0),
    minimumUsd: usd('minimum_usd').notNull().default(0),
    confidence: text('confidence').notNull().default('verified'), // verified | partial | unverified
    source: text('source'),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('model_pricing_uq').on(t.modelKey, t.resolution, t.audio)],
);

/** Real quality measurements (human ratings / evaluation runs). Drives measured routing. */
export const modelEvaluations = pgTable(
  'model_evaluations',
  {
    id: id(),
    modelKey: text('model_key').notNull(),
    jobId: uuid('job_id'),
    evaluatorId: uuid('evaluator_id').references(() => users.id, { onDelete: 'set null' }),
    category: text('category').notNull().default('general'), // general | humans | motion | product | text
    overall: real('overall').notNull(), // 1..5
    motion: real('motion'),
    consistency: real('consistency'),
    promptAdherence: real('prompt_adherence'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [index('model_evaluations_model_idx').on(t.modelKey, t.category)],
);

// ---------------------------------------------------------------- generation

export const generationJobs = pgTable(
  'generation_jobs',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    shotId: uuid('shot_id').references(() => shots.id, { onDelete: 'set null' }),
    parentJobId: uuid('parent_job_id'),
    kind: jobKind('kind').notNull(),
    status: jobStatus('status').notNull().default('draft'),
    phase: text('phase'),
    progress: real('progress'),
    progressSource: text('progress_source').notNull().default('phase'),
    request: jsonb('request').$type<Record<string, unknown>>().notNull(),
    enhancedPrompt: text('enhanced_prompt'),
    routing: jsonb('routing').$type<Record<string, unknown> | null>(),
    modelKey: text('model_key'),
    providerKey: text('provider_key'),
    estimatedCostUsd: usd('estimated_cost_usd').notNull().default(0),
    estimatedCredits: integer('estimated_credits').notNull().default(0),
    actualCostUsd: usd('actual_cost_usd'),
    chargedCredits: integer('charged_credits'),
    reservationId: uuid('reservation_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(2),
    error: jsonb('error').$type<{ code: string; message: string; retryable: boolean } | null>(),
    outputAssetId: uuid('output_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    /** Intermediate state that lets a job resume without repeating paid work. */
    checkpoint: jsonb('checkpoint').$type<Record<string, unknown>>().notNull().default({}),
    isFixture: boolean('is_fixture').notNull().default(false),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('generation_jobs_idem_uq').on(t.userId, t.idempotencyKey),
    index('generation_jobs_user_idx').on(t.userId, t.createdAt),
    index('generation_jobs_status_idx').on(t.status),
    index('generation_jobs_project_idx').on(t.projectId),
    index('generation_jobs_parent_idx').on(t.parentJobId),
  ],
);

export const providerJobs = pgTable(
  'provider_jobs',
  {
    id: id(),
    generationJobId: uuid('generation_job_id').notNull().references(() => generationJobs.id, { onDelete: 'cascade' }),
    segmentIndex: integer('segment_index').notNull().default(0),
    attempt: integer('attempt').notNull().default(1),
    providerKey: text('provider_key').notNull(),
    modelKey: text('model_key').notNull(),
    externalId: text('external_id'),
    status: text('status').notNull().default('submitting'), // submitting|submitted|running|succeeded|failed|cancelled
    requestPayload: jsonb('request_payload').$type<Record<string, unknown>>(),
    response: jsonb('response').$type<Record<string, unknown>>(),
    estimatedCostUsd: usd('estimated_cost_usd'),
    costUsd: usd('cost_usd'),
    costSource: text('cost_source'), // provider_reported | price_table
    error: jsonb('error').$type<Record<string, unknown>>(),
    idempotencyKey: text('idempotency_key').notNull(),
    outputAssetId: uuid('output_asset_id'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('provider_jobs_idem_uq').on(t.idempotencyKey),
    index('provider_jobs_job_idx').on(t.generationJobId),
    index('provider_jobs_external_idx').on(t.providerKey, t.externalId),
  ],
);

// ---------------------------------------------------------------- credits & billing

export const creditWallets = pgTable(
  'credit_wallets',
  {
    userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
    balance: bigint('balance', { mode: 'number' }).notNull().default(0),
    reserved: bigint('reserved', { mode: 'number' }).notNull().default(0),
    lifetimePurchased: bigint('lifetime_purchased', { mode: 'number' }).notNull().default(0),
    lifetimeSpent: bigint('lifetime_spent', { mode: 'number' }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('wallet_balance_nonneg', sql`${t.balance} >= 0`),
    check('wallet_reserved_nonneg', sql`${t.reserved} >= 0`),
    check('wallet_reserved_le_balance', sql`${t.reserved} <= ${t.balance}`),
  ],
);

export const creditReservations = pgTable(
  'credit_reservations',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id'),
    amount: integer('amount').notNull(),
    capturedAmount: integer('captured_amount').notNull().default(0),
    status: reservationStatus('status').notNull().default('held'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('credit_reservations_user_idx').on(t.userId, t.status), check('reservation_amount_pos', sql`${t.amount} > 0`)],
);

export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: txType('type').notNull(),
    /** Signed change to balance (reserve/release do not change balance; amount is informational). */
    amount: integer('amount').notNull(),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    reservedAfter: bigint('reserved_after', { mode: 'number' }).notNull(),
    reservationId: uuid('reservation_id'),
    jobId: uuid('job_id'),
    paymentId: uuid('payment_id'),
    description: text('description').notNull(),
    idempotencyKey: text('idempotency_key'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('credit_tx_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('credit_tx_idem_uq').on(t.idempotencyKey),
    index('credit_tx_job_idx').on(t.jobId),
  ],
);

export const plans = pgTable('plans', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  priceCents: integer('price_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  interval: text('interval').notNull().default('month'),
  monthlyCredits: integer('monthly_credits').notNull(),
  limits: jsonb('limits')
    .$type<{
      maxConcurrentJobs: number;
      maxClipSeconds: number;
      maxMovieSeconds: number;
      maxResolution: string;
      qualityModes: string[];
      watermark: boolean;
      commercialUse: boolean;
      storageGb: number;
    }>()
    .notNull(),
  features: jsonb('features').$type<string[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  providerPriceIds: jsonb('provider_price_ids').$type<Record<string, string>>().notNull().default({}),
  updatedAt: updatedAt(),
});

export const creditPacks = pgTable('credit_packs', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  credits: integer('credits').notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  active: boolean('active').notNull().default(true),
  providerPriceIds: jsonb('provider_price_ids').$type<Record<string, string>>().notNull().default({}),
});

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    planKey: text('plan_key').notNull().references(() => plans.key),
    status: text('status').notNull(), // active | past_due | cancelled | trialing
    provider: text('provider').notNull(),
    providerSubscriptionId: text('provider_subscription_id'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('subscriptions_user_idx').on(t.userId), uniqueIndex('subscriptions_provider_uq').on(t.provider, t.providerSubscriptionId)],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerPaymentId: text('provider_payment_id'),
    kind: text('kind').notNull(), // credits | subscription
    productKey: text('product_key').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    credits: integer('credits').notNull().default(0),
    status: paymentStatus('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull(),
    checkoutUrl: text('checkout_url'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payments_idem_uq').on(t.userId, t.idempotencyKey),
    index('payments_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('payments_provider_uq').on(t.provider, t.providerPaymentId),
  ],
);

/** Processed webhook events — guarantees each provider event is applied once. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    source: text('source').notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('webhook_events_uq').on(t.source, t.eventId)],
);

// ---------------------------------------------------------------- content & ops

export const templates = pgTable('templates', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  featured: boolean('featured').notNull().default(false),
  /** Admin overrides merged over the built-in template definition. */
  overrides: jsonb('overrides').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: updatedAt(),
});

export const savedPrompts = pgTable(
  'saved_prompts',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    prompt: text('prompt').notNull(),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('saved_prompts_user_idx').on(t.userId)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_created_idx').on(t.createdAt), index('audit_logs_actor_idx').on(t.actorUserId)],
);

export const adminConfig = pgTable('admin_config', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
});

/** Durable Postgres-backed work queue (FOR UPDATE SKIP LOCKED). */
export const queueJobs = pgTable(
  'queue_jobs',
  {
    id: id(),
    queue: text('queue').notNull(),
    name: text('name').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: queueStatus('status').notNull().default('pending'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('queue_jobs_ready_idx').on(t.queue, t.status, t.runAt),
    uniqueIndex('queue_jobs_dedupe_uq').on(t.dedupeKey),
  ],
);

/** Daily provider spend counters for the global spending kill-switch. */
export const providerSpend = pgTable(
  'provider_spend',
  {
    day: text('day').notNull(),
    providerKey: text('provider_key').notNull(),
    usd: usd('usd').notNull().default(0),
    jobs: integer('jobs').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.providerKey] })],
);

// ----------------------------------------------------------------- chat (Movie Maker & Ad Studio)

/**
 * A conversation with the AI Director. `kind` movie: idea → screenplay → approval → film.
 * `kind` ad: business brief (info, links, logo, photos) → ad concepts → chosen ad → film.
 * `state` holds the working brief (and for ads the business profile and concepts).
 */
export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // movie | ad
    title: text('title').notNull().default('New conversation'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    state: jsonb('state').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('chat_sessions_user_idx').on(t.userId, t.updatedAt)],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: id(),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // user | assistant
    content: text('content').notNull().default(''),
    /** User uploads attached to the message (images: photos, logo, products). */
    attachments: jsonb('attachments').$type<{ assetId: string; kind: 'photo' | 'logo' | 'product'; token?: string }[]>().notNull().default([]),
    /** Structured card shown under the message: plan, budget, progress, film, ad concepts. */
    card: jsonb('card').$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
  },
  (t) => [index('chat_messages_session_idx').on(t.sessionId, t.createdAt)],
);

// ----------------------------------------------------------------- editor studio

/** Immutable versions of a shot: generations, AI edits, uploads. Never overwritten or deleted by edits. */
export const shotVersions = pgTable(
  'shot_versions',
  {
    id: id(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    shotId: uuid('shot_id').notNull().references(() => shots.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    assetId: uuid('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    parentVersionId: uuid('parent_version_id'),
    label: text('label').notNull().default(''),
    source: text('source').notNull(), // generated | ai_edit | upload
    operationId: uuid('operation_id'),
    prompt: text('prompt'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('shot_versions_number_idx').on(t.shotId, t.number), index('shot_versions_project_idx').on(t.projectId)],
);

/** One requested edit of a shot (AI or deterministic), with its source, scope, result and status. */
export const editOperations = pgTable(
  'edit_operations',
  {
    id: id(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    shotId: uuid('shot_id').notNull().references(() => shots.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sourceVersionId: uuid('source_version_id').notNull(),
    resultVersionId: uuid('result_version_id'),
    commentId: uuid('comment_id'),
    kind: text('kind').notNull().default('ai_edit'),
    mode: text('mode').notNull(),
    instruction: text('instruction').notNull().default(''),
    startSec: real('start_sec').notNull(),
    endSec: real('end_sec').notNull(),
    mask: jsonb('mask').$type<Record<string, unknown> | null>(),
    referenceAssetIds: jsonb('reference_asset_ids').$type<string[]>().notNull().default([]),
    /** Edited still used as guidance (frame edit → video). */
    keyframeAssetId: uuid('keyframe_asset_id'),
    keyframeSec: real('keyframe_sec'),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('queued'), // queued | processing | ready | accepted | rejected | failed
    generationJobId: uuid('generation_job_id'),
    estimateCredits: integer('estimate_credits').notNull().default(0),
    error: jsonb('error').$type<{ message: string } | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('edit_operations_shot_idx').on(t.shotId, t.createdAt)],
);

/** Review comments pinned to a shot, a time range and optionally a spot or mask. */
export const shotComments = pgTable(
  'shot_comments',
  {
    id: id(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    shotId: uuid('shot_id').notNull().references(() => shots.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id'),
    parentId: uuid('parent_id'),
    author: text('author').notNull().default('user'), // user | assistant
    text: text('text').notNull(),
    startSec: real('start_sec'),
    endSec: real('end_sec'),
    x: real('x'),
    y: real('y'),
    mask: jsonb('mask').$type<Record<string, unknown> | null>(),
    referenceAssetIds: jsonb('reference_asset_ids').$type<string[]>().notNull().default([]),
    status: text('status').notNull().default('open'), // open | processing | ready_for_review | accepted | rejected | failed | resolved
    operationId: uuid('operation_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('shot_comments_shot_idx').on(t.shotId, t.createdAt)],
);
export * from './schema-ads';
