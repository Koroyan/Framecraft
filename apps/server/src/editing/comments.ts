import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { editMaskSchema } from '@framecraft/shared';
import type { AppContext } from '../context';
import { assets, shotComments, shotVersions } from '../db/schema';
import { downloadAssetToTemp, getOwnedAsset, storeAsset, type Asset } from '../services/assets';
import { extractFrame } from '../media/ffmpeg';
import { badRequest, notFound } from '../lib/errors';
import type { SessionLike } from '../generation/service';
import { ownedShot } from './versions';

/* Review comments pinned to a shot version, a time range and optionally a spot or a mask. */

export const COMMENT_STATUSES = ['open', 'processing', 'ready_for_review', 'accepted', 'rejected', 'failed', 'resolved'] as const;

export const commentInputSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  versionId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  startSec: z.number().min(0).optional(),
  endSec: z.number().min(0).optional(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  mask: editMaskSchema.nullable().optional(),
  referenceAssetIds: z.array(z.string().uuid()).max(4).default([]),
});

export async function addComment(ctx: AppContext, user: SessionLike, shotId: string, input: z.infer<typeof commentInputSchema>) {
  const { shot } = await ownedShot(ctx, user, shotId);
  for (const id of input.referenceAssetIds) await getOwnedAsset(ctx, user.id, id);
  if (input.startSec != null && input.endSec != null && input.endSec < input.startSec) throw badRequest('The comment’s end time is before its start');
  const [c] = await ctx.db
    .insert(shotComments)
    .values({ projectId: shot.projectId, shotId, userId: user.id, versionId: input.versionId ?? shot.activeVersionId, parentId: input.parentId, text: input.text, startSec: input.startSec, endSec: input.endSec, x: input.x, y: input.y, mask: input.mask ?? null, referenceAssetIds: input.referenceAssetIds })
    .returning();
  return c!;
}

export async function updateComment(ctx: AppContext, user: SessionLike, commentId: string, patch: { text?: string; status?: (typeof COMMENT_STATUSES)[number] }) {
  const [c] = await ctx.db.select().from(shotComments).where(eq(shotComments.id, commentId));
  if (!c) throw notFound('Comment');
  await ownedShot(ctx, user, c.shotId);
  await ctx.db.update(shotComments).set({ ...patch, updatedAt: new Date() }).where(eq(shotComments.id, commentId));
}

export async function deleteComment(ctx: AppContext, user: SessionLike, commentId: string) {
  const [c] = await ctx.db.select().from(shotComments).where(eq(shotComments.id, commentId));
  if (!c) throw notFound('Comment');
  await ownedShot(ctx, user, c.shotId);
  await ctx.db.delete(shotComments).where(and(eq(shotComments.id, commentId)));
}

/** Grab one frame of a shot version as an image asset (free; used for frame editing and references). */
export async function grabFrame(ctx: AppContext, user: SessionLike, versionId: string, atSec: number) {
  const [v] = await ctx.db.select().from(shotVersions).where(eq(shotVersions.id, versionId));
  if (!v) throw notFound('Version');
  await ownedShot(ctx, user, v.shotId);
  const [a] = await ctx.db.select().from(assets).where(eq(assets.id, v.assetId));
  if (!a) throw notFound('Media');
  const src = await downloadAssetToTemp(ctx, a as Asset);
  const out = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'fc-frame-')), 'frame.jpg');
  try {
    await extractFrame(src, out, Math.max(0, Math.min(atSec, (a.durationMs ?? 0) / 1000 - 0.05)));
    return await storeAsset(ctx, { userId: user.id, projectId: v.projectId, kind: 'frame', mediaType: 'image', filePath: out, mimeType: 'image/jpeg', source: { fromVersionId: v.id, atSec, aiGenerated: false } });
  } finally {
    await fsp.rm(src, { force: true });
    await fsp.rm(path.dirname(out), { recursive: true, force: true });
  }
}
