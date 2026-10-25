import { bigint, index, integer, jsonb, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { assets, projects, users } from './schema';

/* Product ads from real footage: brand kits, campaigns and the footage segment catalog. */

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Reusable brand facts and assets. Never invented: what is not here is left for the user to fill in. */
export const brandKits = pgTable(
  'brand_kits',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    logoAssetId: uuid('logo_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    colors: jsonb('colors').$type<{ primary: string; secondary: string; text: string }>().notNull().default({ primary: '#7C5CFF', secondary: '#111111', text: '#FFFFFF' }),
    fonts: jsonb('fonts').$type<{ heading: string; body: string }>().notNull().default({ heading: 'black', body: 'semibold' }),
    voice: text('voice').notNull().default(''),
    products: text('products').notNull().default(''),
    ctas: jsonb('ctas').$type<string[]>().notNull().default([]),
    slogans: jsonb('slogans').$type<string[]>().notNull().default([]),
    handles: jsonb('handles').$type<Record<string, string>>().notNull().default({}),
    website: text('website'),
    musicStyle: text('music_style').notNull().default(''),
    offers: text('offers').notNull().default(''),
    description: text('description').notNull().default(''),
    industry: text('industry').notNull().default(''),
    audience: text('audience').notNull().default(''),
    markets: jsonb('markets').$type<string[]>().notNull().default([]),
    languages: jsonb('languages').$type<string[]>().notNull().default([]),
    contact: jsonb('contact').$type<{ email?: string; phone?: string; address?: string }>().notNull().default({}),
    /** Words, claims and visuals the brand never wants in an ad. */
    restrictions: text('restrictions').notNull().default(''),
    vocabulary: jsonb('vocabulary').$type<string[]>().notNull().default([]),
    /** Brand knowledge: facts with their source and the user's decision (only approved facts reach the ads). */
    knowledge: jsonb('knowledge').$type<BrandKnowledge>().notNull().default({ facts: [], sources: [] }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('brand_kits_user_idx').on(t.userId)],
);

export type BrandFact = { id: string; text: string; kind: 'about' | 'product' | 'claim' | 'audience' | 'contact' | 'price' | 'other'; sourceUrl: string | null; confidence: number; status: 'approved' | 'pending' | 'rejected' };
export type BrandKnowledge = { facts: BrandFact[]; sources: { url: string; kind: 'website' | 'social' | 'manual'; fetchedAt: string; status: 'read' | 'blocked' | 'manual'; note?: string }[] };

/** Products of a brand: approved facts and the media that shows exactly this product. */
export const brandProducts = pgTable(
  'brand_products',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    brandKitId: uuid('brand_kit_id').notNull().references(() => brandKits.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull().default(''),
    price: text('price').notNull().default(''),
    url: text('url'),
    /** Claims the owner approved for ads about this product. */
    claims: jsonb('claims').$type<string[]>().notNull().default([]),
    /** Identity references (front/side/back/detail/packaging/logo) used to keep the product faithful. */
    references: jsonb('references').$type<{ assetId: string; view: string }[]>().notNull().default([]),
    /** Footage and photos of this product (selected for its ads). */
    mediaAssetIds: jsonb('media_asset_ids').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('brand_products_brand_idx').on(t.brandKitId)],
);

/** Resumable chunked uploads (large phone videos): chunks are appended to a temp file until complete. */
export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    receivedBytes: bigint('received_bytes', { mode: 'number' }).notNull().default(0),
    chunkSize: integer('chunk_size').notNull(),
    /** Client-side identity (name + size + modified time) to resume after a reload. */
    fingerprint: text('fingerprint').notNull(),
    fields: jsonb('fields').$type<{ kind: 'upload' | 'reference'; projectId?: string; rightsConfirmed: boolean; containsPeople: boolean }>().notNull(),
    status: text('status').notNull().default('uploading'), // uploading | completing | completed | cancelled | failed
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    error: text('error'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('upload_sessions_user_idx').on(t.userId, t.fingerprint)],
);

export const adCampaigns = pgTable(
  'ad_campaigns',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    brandKitId: uuid('brand_kit_id').references(() => brandKits.id, { onDelete: 'set null' }),
    title: text('title').notNull().default('New ad'),
    /** Request, style, mode, product preservation, language, length, aspect, uploads. */
    brief: jsonb('brief').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('draft'), // draft | analyzing | analyzed | planning | planned | assembling | ready | failed
    phase: text('phase'),
    progress: real('progress'),
    analysis: jsonb('analysis').$type<Record<string, unknown> | null>(),
    plan: jsonb('plan').$type<Record<string, unknown> | null>(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    productId: uuid('product_id').references(() => brandProducts.id, { onDelete: 'set null' }),
    /** Three distinct creative concepts proposed before the storyboard. */
    concepts: jsonb('concepts').$type<Record<string, unknown>[] | null>(),
    /** Shot diversity and quality review of the current plan / render. */
    review: jsonb('review').$type<Record<string, unknown> | null>(),
    variants: jsonb('variants').$type<{ projectId: string; label: string; aspectRatio: string; lengthSec: number; language: string; renderJobId?: string }[]>().notNull().default([]),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ad_campaigns_user_idx').on(t.userId, t.updatedAt)],
);

/** Searchable catalog of the user's footage: scene-detected segments with metrics and AI notes. */
export const footageSegments = pgTable(
  'footage_segments',
  {
    id: id(),
    campaignId: uuid('campaign_id').notNull().references(() => adCampaigns.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('footage'), // footage | reference_ad
    index: integer('index').notNull(),
    startSec: real('start_sec').notNull(),
    endSec: real('end_sec').notNull(),
    frameAssetId: uuid('frame_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    metrics: jsonb('metrics').$type<Record<string, number>>().notNull().default({}),
    description: text('description').notNull().default(''),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    scores: jsonb('scores').$type<Record<string, number>>().notNull().default({}),
    duplicateOf: uuid('duplicate_of'),
    createdAt: createdAt(),
  },
  (t) => [index('footage_segments_campaign_idx').on(t.campaignId, t.index)],
);
