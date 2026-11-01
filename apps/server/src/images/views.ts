import { and, eq, inArray, sql } from 'drizzle-orm';
import { stillLook, type AspectRatio } from '@framecraft/shared';
import type { AppContext } from '../context';
import { characterReferences, characters, generationJobs, locationReferences, locations } from '../db/schema';
import { getWallet } from '../billing/wallet';
import { AppError, notFound, paymentRequired } from '../lib/errors';
import type { SessionLike } from '../generation/service';
import { createImageJob, estimateImage } from './images';

/*
 * Reference views: four images of one character (front, three-quarter, side, back) or one place
 * (wide, reverse, side, detail), so every shot can draw the same face, outfit and set from any
 * angle. One design: the first view is made first and the other three use it as their reference
 * (or all four use the element's own photo when it already has one). Paid images: the price is
 * shown and approved first; credits are reserved for all four up front.
 */

export type ViewKind = 'character' | 'location';

export const CHARACTER_VIEWS = [
  { key: 'front', label: 'Front', framing: 'Full-body front view, facing the camera, relaxed neutral pose' },
  { key: 'three-quarter', label: 'Three-quarter', framing: 'Full-body three-quarter view, body turned 45 degrees' },
  { key: 'side', label: 'Side', framing: 'Full-body side profile view' },
  { key: 'back', label: 'Back', framing: 'Full-body back view, seen from behind' },
] as const;

export const LOCATION_VIEWS = [
  { key: 'wide', label: 'Wide', framing: 'Wide establishing view of the whole place' },
  { key: 'reverse', label: 'Reverse', framing: 'Reverse angle: the same place seen from the opposite side' },
  { key: 'side', label: 'Side', framing: 'Side angle at eye level, showing depth and layout' },
  { key: 'detail', label: 'Detail', framing: 'Closer view of the characteristic details, materials and textures of the place' },
] as const;

export const VIEW_COUNT = 4;

type Element = { id: string; name: string; description: string; projectId: string | null; styleMeta: Record<string, string>; appearance?: Record<string, string | undefined>; clothing?: string };

async function loadElement(ctx: AppContext, userId: string, kind: ViewKind, id: string): Promise<{ el: Element; refs: string[] }> {
  if (kind === 'character') {
    const [c] = await ctx.db.select().from(characters).where(and(eq(characters.id, id), eq(characters.userId, userId)));
    if (!c) throw notFound('Character');
    const refs = (await ctx.db.select().from(characterReferences).where(eq(characterReferences.characterId, id))).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)).map((r) => r.assetId);
    return { el: c, refs };
  }
  const [l] = await ctx.db.select().from(locations).where(and(eq(locations.id, id), eq(locations.userId, userId)));
  if (!l) throw notFound('Location');
  const refs = (await ctx.db.select().from(locationReferences).where(eq(locationReferences.locationId, id))).map((r) => r.assetId);
  return { el: l, refs };
}

export function viewPrompt(kind: ViewKind, el: Element, view: { framing: string }, style?: string) {
  const look = stillLook(style ?? el.styleMeta?.style);
  if (kind === 'character') {
    const appearance = Object.values(el.appearance ?? {}).filter(Boolean).join(', ');
    return `${view.framing} of ${el.name}. ${el.description}${appearance ? ` ${appearance}.` : ''}${el.clothing ? ` Wearing ${el.clothing}.` : ''} ${look} character reference image on a plain light-grey studio background, soft even lighting, the whole figure in frame. Exactly the same person — face, hair, body and outfit — as in the reference image. No text, no other people.`
      .replace(/\s+/g, ' ')
      .slice(0, 1800);
  }
  return `${view.framing} of ${el.name}. ${el.description} ${look} location reference image, natural light, no people. Exactly the same architecture, materials, colours and layout as in the reference image. No text.`.replace(/\s+/g, ' ').slice(0, 1800);
}

/** The price of four views (the first without a reference unless the element has a photo, the rest with one). */
export async function estimateViews(ctx: AppContext, hasPhoto: boolean) {
  const withRef = await estimateImage(ctx, true);
  const first = hasPhoto ? withRef : await estimateImage(ctx, false);
  if (!withRef.available || !first.available) return { available: false as const, credits: 0, perImage: 0 };
  return { available: true as const, credits: first.credits + withRef.credits * (VIEW_COUNT - 1), perImage: withRef.credits };
}

export async function viewsEstimateFor(ctx: AppContext, user: SessionLike, kind: ViewKind, id: string) {
  const { refs } = await loadElement(ctx, user.id, kind, id);
  return estimateViews(ctx, refs.length > 0);
}

/** Create the four views of a character or location. Returns the image jobs (first one first). */
export async function createReferenceViews(ctx: AppContext, user: SessionLike, kind: ViewKind, id: string, p: { idempotencyKey: string; style?: string; projectId?: string }) {
  const { el, refs } = await loadElement(ctx, user.id, kind, id);
  // Views already being made for this element: return those instead of paying twice.
  const running = await ctx.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.userId, user.id), eq(generationJobs.kind, 'image'), inArray(generationJobs.status, ['draft', 'queued', 'generating']), sql`${generationJobs.request}->>${kind === 'character' ? 'characterId' : 'locationId'} = ${id}`, sql`${generationJobs.request}->>'view' is not null`));
  if (running.length) return running;

  const est = await estimateViews(ctx, refs.length > 0);
  if (est.available) {
    const w = await getWallet(ctx.db, user.id);
    if (w.available < est.credits) throw paymentRequired(`Four views need ${est.credits} credits but you have ${w.available} available.`, { required: est.credits, available: w.available });
  }
  const views = kind === 'character' ? CHARACTER_VIEWS : LOCATION_VIEWS;
  const aspectRatio: AspectRatio = kind === 'character' ? '9:16' : '16:9';
  const base = { aspectRatio, purpose: kind, projectId: p.projectId ?? el.projectId ?? undefined, ...(kind === 'character' ? { characterId: id } : { locationId: id }) } as const;
  const jobs = [];
  try {
    if (refs.length) {
      // The element's own photo is the reference for all four: they can run side by side.
      for (const v of views) jobs.push(await createImageJob(ctx, user, { ...base, prompt: viewPrompt(kind, el, v, p.style), view: v.key, referenceAssetIds: [refs[0]!], idempotencyKey: `${p.idempotencyKey}:${v.key}` }));
    } else {
      // No photo yet: the first view defines the design; the others wait for it (draft) and use it.
      const [first, ...rest] = views;
      const lead = await createImageJob(ctx, user, { ...base, prompt: viewPrompt(kind, el, first, p.style), view: first.key, idempotencyKey: `${p.idempotencyKey}:${first.key}` });
      jobs.push(lead);
      for (const v of rest) jobs.push(await createImageJob(ctx, user, { ...base, prompt: viewPrompt(kind, el, v, p.style), view: v.key, waitForJobId: lead.id, idempotencyKey: `${p.idempotencyKey}:${v.key}` }, { draft: true }));
    }
  } catch (err) {
    if (!jobs.length) throw err;
    if (err instanceof AppError) ctx.log.warn('some reference views were not started', { error: err.message });
  }
  return jobs;
}

/** Reference views still being made, per character / location id (ids are unique across both). */
export async function pendingViews(ctx: AppContext, userId: string): Promise<Map<string, number>> {
  const rows = await ctx.db
    .select({ request: generationJobs.request })
    .from(generationJobs)
    .where(and(eq(generationJobs.userId, userId), eq(generationJobs.kind, 'image'), inArray(generationJobs.status, ['draft', 'queued', 'generating']), sql`${generationJobs.request}->>'view' is not null`));
  const m = new Map<string, number>();
  for (const r of rows) {
    const req = r.request as { characterId?: string; locationId?: string };
    const id = req.characterId ?? req.locationId;
    if (id) m.set(id, (m.get(id) ?? 0) + 1);
  }
  return m;
}
