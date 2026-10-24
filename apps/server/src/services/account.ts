import { and, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { assets, users } from '../db/schema';
import { audit } from './common';
import { notFound } from '../lib/errors';

/**
 * Delete an account: removes stored media from object storage first, then the user row
 * (cascades to projects, jobs, characters, wallet and sessions). Audit and payment
 * records needed for accounting are retained without personal media.
 */
export async function deleteAccount(ctx: AppContext, userId: string) {
  const rows = await ctx.db.select({ key: assets.storageKey }).from(assets).where(eq(assets.userId, userId));
  for (const r of rows) await ctx.storage.delete(r.key).catch((err) => ctx.log.warn('storage delete failed', (err as Error).message));
  await audit(ctx.db, { actorUserId: null, action: 'user.deleted', targetType: 'user', targetId: userId, metadata: { assets: rows.length } });
  await ctx.db.delete(users).where(eq(users.id, userId));
}

/** Soft-delete an asset and remove its bytes. */
export async function deleteAsset(ctx: AppContext, userId: string, assetId: string) {
  const [a] = await ctx.db
    .update(assets)
    .set({ deletedAt: new Date() })
    .where(and(eq(assets.id, assetId), eq(assets.userId, userId), isNull(assets.deletedAt)))
    .returning();
  if (!a) throw notFound('Asset');
  await ctx.storage.delete(a.storageKey).catch(() => undefined);
}
