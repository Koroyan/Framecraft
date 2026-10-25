import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { adBriefSchema, adMode, adPlanSchema, endCardSeconds, type AdBrief, type AdModeKey } from '@framecraft/shared';
import type { AppContext } from '../context';
import { adCampaigns, assets, brandKits, footageSegments } from '../db/schema';
import type { SessionLike } from '../generation/service';
import { badRequest, conflict, notFound } from '../lib/errors';
import { extractFrame } from '../media/ffmpeg';
import { createMovie } from '../movie/movie';
import { downloadAssetToTemp, storeAsset, type Asset } from '../services/assets';

/*
 * "Only my product, somewhere completely new": instead of cutting the client's footage, take the
 * product itself — the sharpest, most product-visible frames from different moments (angles) of
 * the footage — and have the film pipeline stage it in a new environment: each shot's keyframe is
 * drawn from those photos, then animated (turntable orbit, macro details, hero reveal), with music,
 * narration and the brand's exact logo end card. Generative: the product is re-created from the
 * photos, so every shot is reviewed. The screenplay and its price are shown before anything is
 * generated (the normal film approval).
 */

const LANG = { ka: 'Georgian', en: 'English', ru: 'Russian' } as const;

type Segment = typeof footageSegments.$inferSelect;
const score = (s: Segment) => {
  const sc = s.scores as Record<string, number>;
  return 0.55 * (sc.product ?? 0.5) + 0.3 * (sc.quality ?? 0.5) + 0.15 * (sc.closeup ?? 0.5);
};

/** Up to `n` product frames from different moments of the footage (different sides of the product). */
function pickAngles(segs: Segment[], n: number): Segment[] {
  const usable = segs.filter((s) => s.role === 'footage' && !s.duplicateOf).sort((a, b) => score(b) - score(a));
  const picked: Segment[] = [];
  for (const s of usable) {
    if (picked.length >= n) break;
    // Prefer moments at least ~1.5 s apart in the same take: the product has turned.
    if (picked.some((p) => p.assetId === s.assetId && Math.abs(p.startSec - s.startSec) < 1.5)) continue;
    picked.push(s);
  }
  return picked;
}

export async function createAiScenes(ctx: AppContext, user: SessionLike, campaignId: string, o: { environment: string; lengthSec?: number; mode?: AdModeKey }) {
  const [c] = await ctx.db.select().from(adCampaigns).where(eq(adCampaigns.id, campaignId));
  if (!c || (c.userId !== user.id && user.role !== 'admin')) throw notFound('Campaign');
  if (['analyzing', 'planning'].includes(c.status)) throw conflict('Wait until the footage analysis finishes');
  const brief: AdBrief = adBriefSchema.parse(c.brief);
  const segs = await ctx.db.select().from(footageSegments).where(eq(footageSegments.campaignId, campaignId));
  const angles = pickAngles(segs, 4);
  if (!angles.length) throw badRequest('No usable product moment was found in the footage');
  const sources = await ctx.db.select().from(assets).where(inArray(assets.id, [...new Set(angles.map((a) => a.assetId))]));
  const frames = await ctx.db.select().from(assets).where(inArray(assets.id, angles.map((a) => a.frameAssetId).filter((x): x is string => Boolean(x))));

  // Full-resolution stills of the product (the analysis frames are small previews).
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fc-angles-'));
  const references: { token: string; assetId: string; note: string }[] = [];
  try {
    const local = new Map<string, string>();
    for (const [i, seg] of angles.entries()) {
      const src = sources.find((a) => a.id === seg.assetId)!;
      let assetId = src.id;
      if (src.mediaType === 'video') {
        if (!local.has(src.id)) local.set(src.id, await downloadAssetToTemp(ctx, src as Asset, { prefer: 'proxy' }));
        const at = (frames.find((f) => f.id === seg.frameAssetId)?.source as { atSec?: number } | undefined)?.atSec ?? (seg.startSec + seg.endSec) / 2;
        const out = path.join(dir, `angle-${i + 1}.jpg`);
        await extractFrame(local.get(src.id)!, out, at);
        const still = await storeAsset(ctx, { userId: c.userId, kind: 'reference', mediaType: 'image', filePath: out, mimeType: 'image/jpeg', originalName: `${src.originalName ?? 'footage'} @${at.toFixed(1)}s`, source: { productAngleOf: src.id, atSec: at, campaignId }, makeThumbnail: false });
        assetId = still.id;
      }
      references.push({ token: `photo${i + 1}`, assetId, note: `the product${seg.description ? ` — ${seg.description.slice(0, 120)}` : ''}` });
    }
    for (const f of local.values()) await fsp.rm(f, { force: true });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }

  const [brand] = brief.brandKitId ? await ctx.db.select().from(brandKits).where(eq(brandKits.id, brief.brandKitId)) : [];
  if (brand?.logoAssetId) references.push({ token: `photo${references.length + 1}`, assetId: brand.logoAssetId, note: 'brand logo' });
  const plan = c.plan ? adPlanSchema.safeParse(c.plan) : null;
  const cta = brief.cta || (plan?.success ? plan.data.cta : '') || brand?.ctas[0] || '';
  const tokens = references.filter((r) => r.note !== 'brand logo').map((r) => r.token);
  const logo = references.find((r) => r.note === 'brand logo')?.token;
  const lengthSec = Math.max(15, Math.min(60, o.lengthSec ?? brief.lengthSec));
  const planned = plan?.success ? plan.data : null;
  const mode = adMode(o.mode ?? brief.adMode ?? (planned?.mode || 'luxury_commercial'));
  const endSec = Math.max(2, Math.round(endCardSeconds(lengthSec, mode.editing.endCardRatio)));
  // What the ad must say (approved texts only), placed on the shots of the mode's shot list.
  const say = planned?.messaging;
  const messages = [
    { text: say?.what?.text ?? '', shot: 1 },
    { text: say?.unique?.text ?? '', shot: Math.min(3, mode.aiShots.length - 1) },
    { text: say?.why?.text ?? '', shot: Math.min(4, mode.aiShots.length - 1) },
  ].filter((m) => m.text.trim());
  const facts = (brand?.knowledge?.facts ?? []).filter((f) => f.status === 'approved').map((f) => f.text).slice(0, 8);

  const idea = [
    `A premium ${lengthSec}-second product commercial${brand ? ` for ${brand.name}` : ''}.`,
    `The ONLY subject is the product shown in ${tokens.join(', ')} (the same object photographed from different sides). No people, no hands, no other products, none of the original surroundings.`,
    `New setting: ${o.environment.trim()}.`,
    `Creative Director mode: ${mode.label} — ${mode.purpose} Shots, in this order: ${mode.aiShots.map((x, i) => `${i + 1}) ${x}`).join('; ')}. Pacing: ${mode.editing.pacing}. Camera language: ${mode.editing.camera.join(', ')}. Each shot continues the previous one (same light, same set, matching direction of movement).`,
    'Keep the product exactly as in the photos: same shape, proportions, colours, clothing, accessories and every detail. Realistic materials and lighting, shallow depth of field, cinematic camera moves.',
    `The client's request: ${brief.request.slice(0, 600)}`,
    facts.length ? `Facts that may be said: ${facts.join(' | ')}.` : 'Say nothing factual about the business beyond the brand name.',
    brief.voiceover ? `A Narrator speaks a few short ${LANG[brief.language]} lines (third person), ending with the call to action${cta ? ` "${cta}"` : ''}.` : 'No speech.',
    logo ? `Final shot (${endSec} seconds): "Logo end card" showing the brand logo (${logo}).` : '',
    'The video model must not draw logos or any on-screen text; titles and the logo end card are made in editing.',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 3900);

  const key = `ad-ai-scenes:${campaignId}:${Date.now()}`;
  const { projectId, planJobId } = await createMovie(
    ctx,
    user,
    { idea, lengthSec, aspectRatio: brief.aspectRatio, style: 'commercial', genre: 'commercial', language: brief.language, withDialogue: brief.voiceover, withMusic: brief.music !== 'none', keyframes: true, references },
    key,
    { kind: 'ad', settings: { ad: { brand: brand?.name ?? '', cta, logoAssetId: brand?.logoAssetId ?? null, website: brand?.website ?? null, concept: 'AI product scenes', campaignId, mode: mode.key, messages, references: references.filter((r) => r.note !== 'brand logo').map((r) => r.assetId) } } },
  );
  const prev = ((c.analysis ?? {}) as { aiScenes?: unknown[] }).aiScenes ?? [];
  await ctx.db
    .update(adCampaigns)
    .set({ analysis: { ...(c.analysis ?? {}), aiScenes: [...prev, { projectId, environment: o.environment.slice(0, 300), angles: references.filter((r) => r.note !== 'brand logo').map((r) => r.assetId), createdAt: new Date().toISOString() }] }, updatedAt: new Date() })
    .where(eq(adCampaigns.id, campaignId));
  return { projectId, planJobId, angles: tokens.length };
}
