import fsp from 'node:fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context';
import { assets, brandKits, brandProducts, consents } from '../db/schema';
import type { SessionLike } from '../generation/service';
import { TERMS_VERSION } from '../auth/auth';
import { badRequest, notFound } from '../lib/errors';
import { assetUrl, getOwnedAsset, sha256File, sniffMime, storeAsset, tmpFile } from '../services/assets';

/* Brand workspace: the product catalog and imports of the brand's own public images. */

export const productInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  category: z.string().max(120).default(''),
  price: z.string().max(60).default(''),
  url: z.string().max(500).nullable().optional(),
  claims: z.array(z.string().trim().min(1).max(240)).max(20).default([]),
  references: z.array(z.object({ assetId: z.string().uuid(), view: z.enum(['front', 'side', 'back', 'detail', 'packaging', 'logo', 'other']) })).max(12).default([]),
  mediaAssetIds: z.array(z.string().uuid()).max(60).default([]),
});

async function ownedBrand(ctx: AppContext, user: SessionLike, brandKitId: string) {
  const [b] = await ctx.db.select().from(brandKits).where(and(eq(brandKits.id, brandKitId), eq(brandKits.userId, user.id)));
  if (!b) throw notFound('Brand');
  return b;
}

export async function listProducts(ctx: AppContext, user: SessionLike, brandKitId: string) {
  await ownedBrand(ctx, user, brandKitId);
  const rows = await ctx.db.select().from(brandProducts).where(eq(brandProducts.brandKitId, brandKitId)).orderBy(desc(brandProducts.updatedAt));
  return Promise.all(
    rows.map(async (p) => {
      const cover = p.references[0]?.assetId ?? p.mediaAssetIds[0];
      const a = cover ? await getOwnedAsset(ctx, user.id, cover).catch(() => null) : null;
      return { ...p, coverUrl: a ? await assetUrl(ctx, a.thumbnailAssetId ? await getOwnedAsset(ctx, user.id, a.thumbnailAssetId).catch(() => a) : a) : null };
    }),
  );
}

export async function saveProduct(ctx: AppContext, user: SessionLike, brandKitId: string, raw: z.input<typeof productInputSchema>, id?: string) {
  await ownedBrand(ctx, user, brandKitId);
  const input = productInputSchema.parse(raw);
  for (const a of [...input.references.map((r) => r.assetId), ...input.mediaAssetIds]) await getOwnedAsset(ctx, user.id, a);
  if (id) {
    const [u] = await ctx.db.update(brandProducts).set({ ...input, url: input.url ?? null, updatedAt: new Date() }).where(and(eq(brandProducts.id, id), eq(brandProducts.userId, user.id), eq(brandProducts.brandKitId, brandKitId))).returning();
    if (!u) throw notFound('Product');
    return u;
  }
  const [p] = await ctx.db.insert(brandProducts).values({ userId: user.id, brandKitId, ...input, url: input.url ?? null }).returning();
  return p!;
}

export async function deleteProduct(ctx: AppContext, user: SessionLike, brandKitId: string, id: string) {
  const [d] = await ctx.db.delete(brandProducts).where(and(eq(brandProducts.id, id), eq(brandProducts.userId, user.id), eq(brandProducts.brandKitId, brandKitId))).returning({ id: brandProducts.id });
  if (!d) throw notFound('Product');
  return { ok: true };
}

/**
 * Import an image the brand published on its own website (found by the website analysis), as a
 * normal upload. The owner confirms the rights; the file type is checked by its content.
 */
export async function importBrandImage(ctx: AppContext, user: SessionLike, url: string, o: { rightsConfirmed: boolean; ip?: string }) {
  if (!o.rightsConfirmed) throw badRequest('Please confirm this image belongs to your brand or you may use it.');
  const r = await ctx.webFetch(url, { accept: 'image', maxBytes: 15 * 1024 * 1024 });
  if (r.status >= 400) throw badRequest(`The image could not be downloaded (HTTP ${r.status})`);
  const file = tmpFile();
  try {
    await fsp.writeFile(file, r.body);
    const mime = await sniffMime(file);
    if (!mime || !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw badRequest('Only JPG, PNG or WebP images can be imported');
    const sha = await sha256File(file);
    const [dup] = await ctx.db.select().from(assets).where(and(eq(assets.userId, user.id), eq(assets.sha256, sha)));
    if (dup && !dup.deletedAt) return { asset: { ...dup, url: await assetUrl(ctx, dup) }, deduplicated: true };
    const asset = await storeAsset(ctx, { userId: user.id, kind: 'upload', mediaType: 'image', filePath: file, mimeType: mime, originalName: decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'image').slice(0, 120), source: { uploaded: true, importedFrom: r.url } });
    await ctx.db.insert(consents).values({ userId: user.id, kind: 'copyright', version: TERMS_VERSION, subjectRef: asset.id, ip: o.ip });
    return { asset: { ...asset, url: await assetUrl(ctx, asset) }, deduplicated: false };
  } finally {
    await fsp.rm(file, { force: true });
  }
}
