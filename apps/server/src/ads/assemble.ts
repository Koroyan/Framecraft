import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { adStyle, ASPECT_DIMENSIONS, cameraPreset, LOOKS, timelineSchema, type AdBrief, type AdPlan, type LayerInput, type TimelineInput } from '@framecraft/shared';
import type { AppContext } from '../context';
import { assets, brandKits, footageSegments, projects, scenes, shots } from '../db/schema';
import type { SessionLike } from '../generation/service';
import { recordShotVersion } from '../editing/versions';
import { saveTimeline } from '../editor/editor';
import { downloadAssetToTemp, storeAsset, type Asset } from '../services/assets';
import { generateLogoCard, stillToClip } from '../media/ffmpeg';

/*
 * Turn an approved plan into a normal, fully editable Framecraft project: every scene is a shot
 * whose version is the client's ORIGINAL file, and every timeline clip keeps the source file and
 * the exact interval it was cut from. Colour, camera, titles, logo and end card are deterministic
 * (no AI); voice-over and music are added when their audio jobs finish (see campaigns.ts).
 */

// Text sits above heads (title) or in the lower third, clear of the bottom ~20% that social apps cover.
const ROLE_POS = { title: 0.1, lower_third: 0.72, caption: 0.74, price: 0.64, cta: 0.68 } as const;

export async function assembleAd(ctx: AppContext, user: SessionLike, p: { campaignId: string; brief: AdBrief; plan: AdPlan; title: string; aspectRatio?: AdBrief['aspectRatio']; lengthScale?: number }) {
  const aspect = p.aspectRatio ?? p.brief.aspectRatio;
  const style = adStyle(p.brief.style);
  const brand = p.brief.brandKitId ? (await ctx.db.select().from(brandKits).where(eq(brandKits.id, p.brief.brandKitId)))[0] : undefined;
  const segIds = [...new Set(p.plan.scenes.map((s) => s.segmentId))];
  const segs = await ctx.db.select().from(footageSegments).where(inArray(footageSegments.id, segIds));
  const srcRows = await ctx.db.select().from(assets).where(inArray(assets.id, [...new Set(segs.map((s) => s.assetId))]));

  const [project] = await ctx.db
    .insert(projects)
    .values({ userId: user.id, kind: 'ad', title: p.title.slice(0, 120), aspectRatio: aspect, settings: { ad: { campaignId: p.campaignId, mode: p.brief.mode, preservation: p.brief.preservation, style: style.key, cta: p.plan.cta }, productRefAssetIds: p.brief.productRefAssetIds } })
    .returning();
  // A failed assembly leaves nothing behind: the half-built project (and its shots) goes too.
  try {
    const [scene] = await ctx.db.insert(scenes).values({ projectId: project!.id, index: 0, title: p.plan.title || 'Ad' }).returning();
    const look = LOOKS.find((l) => l.key === style.look)?.grade ?? {};

    const clips: TimelineInput['clips'] = [];
    const layers: LayerInput[] = [];
    let t = 0;
    for (let i = 0; i < p.plan.scenes.length; i++) {
      const sc = p.plan.scenes[i]!;
      const seg = segs.find((s) => s.id === sc.segmentId);
      const src = seg && srcRows.find((a) => a.id === seg.assetId);
      if (!seg || !src) continue;
      const room = src.mediaType === 'image' ? 30 : seg.endSec - seg.startSec - sc.inSec;
      const dur = Math.max(0.5, Math.min(room, sc.durationSec * (p.lengthScale ?? 1)));
      const imageSrc = src.mediaType === 'image';
      // Timeline clips are videos: a photo becomes a clip of the exact photo (local, no AI).
      const clipAsset = imageSrc ? await photoClip(ctx, user.id, project!.id, src as Asset, aspect, dur + 0.7) : src;
      const [shot] = await ctx.db
        .insert(shots)
        .values({ projectId: project!.id, sceneId: scene!.id, index: i, description: seg.description || sc.purpose || `Scene ${i + 1}`, prompt: sc.purpose, durationSec: Math.max(1, Math.round(dur)), referenceAssetIds: p.brief.productRefAssetIds, status: 'ready', currentAssetId: clipAsset.id })
        .returning();
      const v = await recordShotVersion(ctx.db, { projectId: project!.id, shotId: shot!.id, assetId: clipAsset.id, source: 'upload', label: imageSrc ? 'Original photo' : 'Original footage', prompt: null, settings: { segmentId: seg.id, sourceStartSec: seg.startSec + sc.inSec, ...(imageSrc ? { sourcePhotoAssetId: src.id } : {}) }, activate: true });
      const m = seg.metrics as Record<string, number>;
      // Deterministic exposure correction from the analysed brightness, on top of the style's look.
      const exposureFix = m.exposure ? Math.max(-0.6, Math.min(0.6, (0.48 - m.exposure) * 1.6)) : 0;
      const inSec = imageSrc ? 0 : seg.startSec + sc.inSec;
      // A still never sits frozen: static styles still get a gentle push-in on photos.
      const move = style.camera && style.camera !== 'static' ? style.camera : imageSrc ? 'push_in' : null;
      clips.push({
        id: `clip-${i + 1}`,
        assetId: clipAsset.id,
        shotId: shot!.id,
        versionId: v.id,
        label: (seg.description || sc.purpose).slice(0, 120) || undefined,
        inSec,
        outSec: inSec + dur,
        volume: p.brief.voiceover ? 0 : 0.6,
        transition: i < p.plan.scenes.length - 1 && sc.transition !== 'cut' ? { type: sc.transition, durationSec: Math.min(0.6, dur / 3) } : undefined,
        adjust: { ...look, exposure: Math.round(((look.exposure ?? 0) + exposureFix) * 100) / 100 },
        camera: move ? cameraPreset(move, dur, style.pacing === 'fast' ? 0.5 : move === style.camera ? 0.3 : 0.2) : undefined,
      });
      if (sc.overlay) {
        const isCta = sc.overlay.kind === 'cta' || sc.overlay.kind === 'price';
        layers.push({
          id: `txt-${i + 1}`,
          name: sc.overlay.kind,
          kind: isCta ? 'shape' : 'text',
          track: 2,
          startSec: Math.round((t + 0.15) * 100) / 100,
          endSec: Math.round((t + dur - 0.1) * 100) / 100,
          x: 0.5,
          y: ROLE_POS[sc.overlay.kind],
          w: isCta ? 0.62 : sc.overlay.kind === 'title' ? 0.82 : 0.78,
          ...(isCta
            ? { shape: { type: 'pill', fill: brand?.colors.primary ?? '#7C5CFF', aspect: Math.max(2.4, Math.min(7, sc.overlay.text.length / 3)), label: sc.overlay.text, labelColor: brand?.colors.text ?? '#FFFFFF' } }
            : // A soft dark backing keeps white text readable on light product shots.
            // Captions use a sturdy weight (thin serifs break up at caption size); the title keeps the style's font.
            { text: { content: sc.overlay.text, font: sc.overlay.kind === 'title' ? style.font : style.font === 'serif' ? 'semibold' : style.font, size: sc.overlay.kind === 'title' ? 78 : 56, color: '#FFFFFF', shadow: { color: '#000000', opacity: 0.55, offset: 3 }, background: { color: '#000000', opacity: sc.overlay.kind === 'title' ? 0.32 : 0.5, padding: 18 } } }),
          animIn: { type: style.textAnim, durationSec: style.textAnim === 'typewriter' || style.textAnim === 'words' ? Math.min(1.6, dur * 0.6) : 0.45 },
          animOut: { type: 'fade', durationSec: 0.3 },
        });
      }
      t += dur - (clips.at(-1)!.transition?.durationSec ?? 0);
    }

    // Brand: logo in the corner, then a logo end card built from the exact file.
    const dims = ASPECT_DIMENSIONS[aspect]['1080p'];
    if (brand?.logoAssetId) {
      // A title hook keeps the top of the frame to itself; the logo comes in after it.
    const logoFrom = p.plan.scenes[0]?.overlay?.kind === 'title' && clips.length > 1 ? Math.round((clips[0]!.outSec - clips[0]!.inSec) * 100) / 100 : 0;
    layers.push({ id: 'logo', name: 'logo', kind: 'image', track: 3, assetId: brand.logoAssetId, startSec: logoFrom, endSec: Math.max(logoFrom + 1, t), x: 0.86, y: 0.08, w: 0.18, opacity: 0.92, ...(logoFrom ? { animIn: { type: 'fade', durationSec: 0.4 } } : {}) });
      if (p.plan.endCard) {
        const [logo] = await ctx.db.select().from(assets).where(eq(assets.id, brand.logoAssetId));
        if (logo) {
          const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fc-card-'));
          try {
            const file = await downloadAssetToTemp(ctx, logo as Asset);
            const out = path.join(dir, 'card.mp4');
            await generateLogoCard(file, out, { width: dims.width, height: dims.height, durationSec: 3, background: brand.colors.secondary });
            const card = await storeAsset(ctx, { userId: user.id, projectId: project!.id, kind: 'generated', mediaType: 'video', filePath: out, mimeType: 'video/mp4', source: { logoCard: true, aiGenerated: false } });
            await fsp.rm(file, { force: true });
            const [shot] = await ctx.db.insert(shots).values({ projectId: project!.id, sceneId: scene!.id, index: p.plan.scenes.length, description: 'Brand end card', durationSec: 3, status: 'ready', currentAssetId: card.id }).returning();
            const v = await recordShotVersion(ctx.db, { projectId: project!.id, shotId: shot!.id, assetId: card.id, source: 'generated', label: 'Logo end card (from your logo file)', activate: true });
            if (clips.length) clips[clips.length - 1]!.transition ??= { type: 'fade', durationSec: 0.4 };
            clips.push({ id: 'clip-endcard', assetId: card.id, shotId: shot!.id, versionId: v.id, inSec: 0, outSec: 3, volume: 0, label: 'Brand end card' });
            if (p.plan.cta) layers.push({ id: 'cta-end', name: 'cta', kind: 'text', track: 2, startSec: Math.round((t + 0.4) * 100) / 100, endSec: Math.round((t + 2.9) * 100) / 100, x: 0.5, y: 0.78, w: 0.8, text: { content: p.plan.cta, font: 'bold', size: 60, color: brand.colors.text ?? '#FFFFFF' }, animIn: { type: 'slide_up', durationSec: 0.5 } });
            t += 3 - 0.4;
          } finally {
            await fsp.rm(dir, { recursive: true, force: true });
          }
        }
      }
    }

    const timeline = timelineSchema.parse({ aspectRatio: aspect, resolution: '1080p', fps: 30, clips, layers, burnSubtitles: false, loudnorm: true });
    await saveTimeline(ctx, user, project!.id, timeline, { label: 'Assembled ad' });
    return { projectId: project!.id, durationSec: t, timeline };
  } catch (err) {
    await ctx.db.delete(projects).where(eq(projects.id, project!.id));
    throw err;
  }
}

async function photoClip(ctx: AppContext, userId: string, projectId: string, photo: Asset, aspect: AdBrief['aspectRatio'], durationSec: number) {
  const dims = ASPECT_DIMENSIONS[aspect]['1080p'];
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fc-photo-'));
  try {
    const file = await downloadAssetToTemp(ctx, photo);
    const out = path.join(dir, 'photo.mp4');
    await stillToClip(file, out, { width: dims.width, height: dims.height, durationSec: Math.round(durationSec * 100) / 100 });
    await fsp.rm(file, { force: true });
    return await storeAsset(ctx, { userId, projectId, kind: 'generated', mediaType: 'video', filePath: out, mimeType: 'video/mp4', source: { fromPhoto: photo.id, aiGenerated: false } });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
