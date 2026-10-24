import { TEMPLATES } from '@framecraft/shared';
import type { Db } from './client';
import { creditPacks, plans, templates } from './schema';

/**
 * Plans are priced so that subscription credits stay above the minimum-margin floor:
 * with markup 0.6 a credit costs at most $0.00625 in provider spend, so any price
 * ≥ ~$0.0096/credit keeps ≥35% gross margin. All values are admin-editable.
 */
export const DEFAULT_PLANS: (typeof plans.$inferInsert)[] = [
  {
    key: 'free',
    name: 'Free Trial',
    description: 'Try the studio with free trial credits.',
    priceCents: 0,
    monthlyCredits: 0,
    sort: 0,
    limits: { maxConcurrentJobs: 1, maxClipSeconds: 10, maxMovieSeconds: 30, maxResolution: '720p', qualityModes: ['economy', 'balanced'], watermark: true, commercialUse: false, storageGb: 2 },
    features: ['300 trial credits', 'Economy & Balanced quality', '720p exports', 'Social templates'],
  },
  {
    key: 'creator',
    name: 'Creator',
    description: 'For everyday social media creators.',
    priceCents: 1900,
    monthlyCredits: 1900,
    sort: 1,
    limits: { maxConcurrentJobs: 2, maxClipSeconds: 20, maxMovieSeconds: 60, maxResolution: '1080p', qualityModes: ['economy', 'balanced', 'high'], watermark: false, commercialUse: true, storageGb: 25 },
    features: ['1,900 credits / month', 'Up to High quality', '1080p exports', 'Commercial use', 'Brand kit'],
  },
  {
    key: 'pro',
    name: 'Pro',
    description: 'For professionals and small businesses.',
    priceCents: 4900,
    monthlyCredits: 5000,
    sort: 2,
    limits: { maxConcurrentJobs: 4, maxClipSeconds: 30, maxMovieSeconds: 180, maxResolution: '1080p', qualityModes: ['economy', 'balanced', 'high', 'cinematic'], watermark: false, commercialUse: true, storageGb: 100 },
    features: ['5,000 credits / month', 'Cinematic quality', 'AI Movie Maker up to 3 min', 'Manual model choice', 'Priority queue'],
  },
  {
    key: 'studio',
    name: 'Studio',
    description: 'For studios and teams producing films.',
    priceCents: 14900,
    monthlyCredits: 15000,
    sort: 3,
    limits: { maxConcurrentJobs: 8, maxClipSeconds: 60, maxMovieSeconds: 600, maxResolution: '4k', qualityModes: ['economy', 'balanced', 'high', 'cinematic'], watermark: false, commercialUse: true, storageGb: 500 },
    features: ['15,000 credits / month', 'Films up to 10 min', '4K where models support it', 'Highest concurrency'],
  },
];

export const DEFAULT_PACKS: (typeof creditPacks.$inferInsert)[] = [
  { key: 'pack-1000', name: '1,000 credits', credits: 1000, priceCents: 1200 },
  { key: 'pack-5000', name: '5,000 credits', credits: 5000, priceCents: 5500 },
  { key: 'pack-20000', name: '20,000 credits', credits: 20000, priceCents: 20000 },
];

export async function seedReferenceData(db: Db) {
  for (const p of DEFAULT_PLANS) await db.insert(plans).values(p).onConflictDoNothing();
  for (const p of DEFAULT_PACKS) await db.insert(creditPacks).values(p).onConflictDoNothing();
  for (const [i, t] of TEMPLATES.entries()) {
    await db.insert(templates).values({ key: t.key, sort: i, featured: i < 6 }).onConflictDoNothing();
  }
}
