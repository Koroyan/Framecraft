import { index, integer, jsonb, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('brand_kits_user_idx').on(t.userId)],
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
