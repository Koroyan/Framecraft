import fsp from 'node:fs/promises';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { adMode, timelineSchema, type Timeline } from '@framecraft/shared';
import type { AppContext } from '../context';
import { adCampaigns, assets, generationJobs, projects, projectVersions, qualityReports } from '../db/schema';
import type { LlmImage } from '../director/llm';
import { downloadAssetToTemp, type Asset } from '../services/assets';
import { framesAt, hueDistance, hueSignature, measureRender, type RenderMeasurements } from '../media/qc';
import { notFound } from '../lib/errors';
import { enqueue, type JobResult, type QueueJob } from '../queue/queue';

/*
 * Quality control of a finished ad, from the rendered file — not from the plan. Measurements are
 * deterministic (cuts, repeats, black/frozen frames, jumps, loudness, silence, text timing, brand
 * ending, watermark). Product identity is checked by comparing each shot's frame with the client's
 * original product images: a colour signature always, and an AI vision comparison (face,
 * proportions, accessories, clothing, surface details, geometry) when the AI Director is
 * configured. Suspicious shots are flagged for the user's approval. The result is stored as a
 * *verified* report, separate from the plan's predicted score.
 */

export type QualityIssue = { severity: 'error' | 'warning' | 'info'; area: 'identity' | 'pacing' | 'repetition' | 'picture' | 'audio' | 'captions' | 'brand' | 'story'; message: string; shot?: number; atSec?: number };
export type IdentityResult = { shot: number; atSec: number; method: 'vision' | 'colour'; verdict: 'consistent' | 'suspicious' | 'changed' | 'unchecked'; changes: string[]; colourDistance: number; aspects?: Record<string, 'same' | 'changed' | 'unclear'>; approved?: boolean };

const visionSchema = z.object({
  shots: z.array(
    z.object({
      frame: z.number().int(),
      productVisible: z.boolean(),
      face: z.enum(['same', 'changed', 'unclear', 'n/a']),
      proportions: z.enum(['same', 'changed', 'unclear', 'n/a']),
      accessories: z.enum(['same', 'changed', 'unclear', 'n/a']),
      clothing: z.enum(['same', 'changed', 'unclear', 'n/a']),
      surfaceDetails: z.enum(['same', 'changed', 'unclear', 'n/a']),
      geometry: z.enum(['same', 'changed', 'unclear', 'n/a']),
      /** AI artefacts only (melted, warped, extra/missing parts) — not lighting or reflections. */
      artefacts: z.array(z.string()).max(6),
      changes: z.array(z.string()).max(6),
    }),
  ),
});

const VISION_SYSTEM = `You are a strict product-fidelity reviewer for advertising. The first images are REFERENCE photos of the client's real product. The following images are FRAMES from a generated or edited ad, one per shot (Frame 1, Frame 2, …).
For each frame, compare the product with the references and answer for each aspect: face (for figurines/characters), proportions, accessories (held objects, props attached to the product), clothing, surfaceDetails (paint, texture, printed marks), geometry (shape, parts, count of limbs/fingers): "same", "changed", "unclear" (not visible enough) or "n/a" (aspect does not apply).
Report ONLY changes to the product itself ("the syringe is shorter", "the collar is now white", "a watch is missing") and AI artefacts (melted or warped parts, extra or missing fingers or limbs, smeared face). These are NOT changes and must never be reported: camera angle, distance, zoom, tilt, which side of the product is visible, the product being rotated or held by a hand, lighting, reflections, gloss, shadows, colour grading, depth of field, background. If the frame shows a side the references do not show, answer "unclear" for what cannot be compared. Be conservative: report a change only when you are confident.`;

async function referenceImages(ctx: AppContext, projectId: string): Promise<Asset[]> {
  const [p] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) return [];
  const settings = p.settings as { ad?: { campaignId?: string; references?: string[] }; productRefAssetIds?: string[]; brief?: { references?: { assetId: string; note?: string }[] } };
  let ids = [...(settings.ad?.references ?? []), ...(settings.productRefAssetIds ?? []), ...(settings.brief?.references ?? []).filter((r) => r.note !== 'brand logo').map((r) => r.assetId)];
  const campaignId = settings.ad?.campaignId;
  if (!ids.length && campaignId) {
    const [c] = await ctx.db.select().from(adCampaigns).where(eq(adCampaigns.id, campaignId));
    ids = ((c?.brief as { productRefAssetIds?: string[] } | undefined)?.productRefAssetIds ?? []).slice(0, 4);
  }
  ids = [...new Set(ids)].slice(0, 4);
  if (!ids.length) return [];
  const rows = await ctx.db.select().from(assets).where(inArray(assets.id, ids));
  return rows.filter((r) => r.mediaType === 'image') as Asset[];
}

/** Score 0–100 from the issues: errors weigh most; a report with any error cannot pass. */
function scoreOf(issues: QualityIssue[]) {
  return Math.max(0, 100 - issues.reduce((t, x) => t + (x.severity === 'error' ? 20 : x.severity === 'warning' ? 8 : 2), 0));
}

export function judgeRender(m: Pick<RenderMeasurements, 'durationSec' | 'shots' | 'duplicateShots' | 'black' | 'frozen' | 'jumps' | 'audio' | 'width' | 'height'>, tl: Timeline | null, o: { modeKey?: string; cta?: string | null; expectedAspect?: string; logoCard?: { startSec: number; endSec: number } | null; clipBounds?: { startSec: number; endSec: number; soft: number }[] }): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const mode = adMode(o.modeKey);
  const dur = m.durationSec;
  // The timeline knows the real shot boundaries (soft transitions are invisible to cut detection).
  const shotsOf = o.clipBounds?.length ? o.clipBounds : m.shots;
  const content = o.logoCard ? shotsOf.filter((s) => s.endSec <= o.logoCard!.startSec + 0.2) : shotsOf;
  // Pacing against the mode.
  const lens = content.map((s) => s.endSec - s.startSec);
  const longest = lens.length ? Math.max(...lens) : 0;
  if (longest > mode.editing.shotSec[1] * 2.2 && longest > 4) issues.push({ severity: 'warning', area: 'pacing', message: `A ${longest.toFixed(1)} s shot is long for ${mode.label} (shots of ${mode.editing.shotSec[0]}–${mode.editing.shotSec[1]} s)`, shot: lens.indexOf(longest) });
  if (content[0] && content[0].endSec > 3.5) issues.push({ severity: 'info', area: 'pacing', message: `The first cut comes at ${content[0].endSec.toFixed(1)} s — the hook could be tighter` });
  // Repetition in the actual picture.
  for (const [a, b] of m.duplicateShots) if (!(o.logoCard && m.shots[b] && m.shots[b]!.startSec >= o.logoCard.startSec - 0.2)) issues.push({ severity: 'warning', area: 'repetition', message: `Shots ${a + 1} and ${b + 1} look almost the same`, shot: b });
  // Picture faults.
  for (const bl of m.black) if (bl.startSec > 0.3 && bl.endSec < dur - 0.3) issues.push({ severity: 'warning', area: 'picture', message: `Black frames ${bl.startSec.toFixed(1)}–${bl.endSec.toFixed(1)} s`, atSec: bl.startSec });
  for (const f of m.frozen) if (!(o.logoCard && f.startSec >= o.logoCard.startSec - 0.3)) issues.push({ severity: 'warning', area: 'picture', message: `Picture frozen ${f.startSec.toFixed(1)}–${f.endSec.toFixed(1)} s`, atSec: f.startSec });
  // A dissolve or fade is a planned change of picture, not a glitch.
  const near = (t: number) => (o.clipBounds ?? []).some((b) => Math.abs(b.startSec - t) < 0.4 + b.soft || Math.abs(b.endSec - t) < 0.4 + b.soft);
  const jumps = m.jumps.filter((t) => !near(t));
  if (jumps.length) issues.push({ severity: jumps.length > 3 ? 'warning' : 'info', area: 'picture', message: `${jumps.length} abrupt jump${jumps.length > 1 ? 's' : ''} inside shots (flicker or morphing) at ${jumps.slice(0, 4).map((t) => `${t}s`).join(', ')}`, atSec: jumps[0] });
  // Audio.
  if (!m.audio) issues.push({ severity: 'warning', area: 'audio', message: 'The ad has no sound' });
  else {
    if (m.audio.maxDb > -0.3) issues.push({ severity: 'warning', area: 'audio', message: `Audio peaks at ${m.audio.maxDb} dB (risk of clipping)` });
    if (m.audio.meanDb < -30) issues.push({ severity: 'warning', area: 'audio', message: `Audio is very quiet (mean ${m.audio.meanDb} dB)` });
    const silent = m.audio.silent.filter((s) => s.endSec - s.startSec > 1.5 && s.startSec < dur - 1);
    if (silent.length) issues.push({ severity: 'info', area: 'audio', message: `Silence ${silent.map((s) => `${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)} s`).join(', ')}` });
  }
  // Brand ending and watermark.
  if (o.logoCard) {
    const end = o.logoCard.endSec - o.logoCard.startSec;
    const max = Math.max(2, dur * (mode.editing.endCardRatio + 0.06));
    if (end > max) issues.push({ severity: 'warning', area: 'brand', message: `The brand ending lasts ${end.toFixed(1)} s (${Math.round((end / dur) * 100)}% of the ad) — ${Math.max(1.5, Math.round(dur * mode.editing.endCardRatio * 10) / 10)} s is enough` });
  }
  if (tl) {
    const logoLayers = tl.layers.filter((l) => l.kind === 'image' && /logo/i.test(l.name ?? ''));
    const covered = logoLayers.reduce((t, l) => t + (l.endSec - l.startSec), 0) + (tl.logo ? dur : 0);
    if (covered > dur * 0.6) issues.push({ severity: 'warning', area: 'brand', message: 'A logo stays on screen for most of the ad (watermark) — keep it to the brand ending' });
    // Captions: reading speed and safe area.
    const texts = [...tl.layers.filter((l) => l.kind === 'text' && l.text).map((l) => ({ text: l.text!.content, start: l.startSec, end: l.endSec, y: l.y })), ...tl.subtitles.map((s) => ({ text: s.text, start: s.startSec, end: s.endSec, y: 0.8 }))];
    for (const x of texts) {
      const cps = x.text.length / Math.max(0.1, x.end - x.start);
      if (cps > 22 && x.text.length > 12) issues.push({ severity: 'warning', area: 'captions', message: `"${x.text.slice(0, 40)}" is on screen too briefly to read (${(x.end - x.start).toFixed(1)} s)`, atSec: x.start });
      if (x.y > 0.86 || x.y < 0.05) issues.push({ severity: 'info', area: 'captions', message: `"${x.text.slice(0, 40)}" sits where social apps cover the frame`, atSec: x.start });
    }
    if (o.cta && !texts.some((x) => x.text.includes(o.cta!.slice(0, 12)))) issues.push({ severity: 'warning', area: 'brand', message: 'The approved call to action is not shown on screen' });
    if (!o.cta) issues.push({ severity: 'warning', area: 'story', message: 'No call to action' });
    if (texts.length === 0 && !tl.audio.some((a) => a.kind === 'voice')) issues.push({ severity: 'warning', area: 'story', message: 'Nothing in the ad says what the product is or why it matters (no text, no narration) — it is a showcase, not yet an ad' });
  }
  if (o.expectedAspect) {
    const [w, h] = o.expectedAspect.split(':').map(Number) as [number, number];
    if (m.width && m.height && Math.abs(m.width / m.height - w / h) > 0.02) issues.push({ severity: 'error', area: 'picture', message: `Exported ${m.width}×${m.height}, expected ${o.expectedAspect}` });
  }
  return issues;
}

/** Compare every product shot with the original product images. */
async function checkIdentity(ctx: AppContext, m: RenderMeasurements, refs: Asset[], skip: (shot: number) => boolean): Promise<{ results: IdentityResult[]; source: 'vision' | 'colour' | 'none' | 'not_needed' }> {
  if (!refs.length) return { results: [], source: 'none' };
  const refFiles: string[] = [];
  try {
    for (const r of refs) refFiles.push(await downloadAssetToTemp(ctx, r));
    const refSigs = await Promise.all(refFiles.map((f) => hueSignature(f)));
    const frames = m.frames.filter((f) => !skip(f.shot)).slice(0, 10);
    if (!frames.length) return { results: [], source: 'not_needed' };
    const results: IdentityResult[] = [];
    for (const f of frames) {
      const sig = await hueSignature(f.file);
      const d = Math.min(...refSigs.map((r) => hueDistance(sig, r)));
      // Colour alone is a weak signal (a new set and light change the palette): only large differences count.
      results.push({ shot: f.shot, atSec: f.atSec, method: 'colour', verdict: d > 0.75 ? 'suspicious' : 'unchecked', changes: d > 0.75 ? [`Colours differ strongly from the product photos (distance ${d.toFixed(2)})`] : [], colourDistance: Math.round(d * 100) / 100 });
    }
    if (!ctx.director.llmAvailable || !frames.length) return { results, source: 'colour' };
    const images: LlmImage[] = [
      ...(await Promise.all(refFiles.slice(0, 3).map(async (f, i) => ({ label: `Reference ${i + 1}`, mediaType: 'image/jpeg' as const, data: await jpegBase64(f) })))),
      ...(await Promise.all(frames.map(async (f, i) => ({ label: `Frame ${i + 1}`, mediaType: 'image/jpeg' as const, data: (await fsp.readFile(f.file)).toString('base64') })))),
    ];
    const res = await ctx.director.converse({ system: VISION_SYSTEM, prompt: `${Math.min(3, refFiles.length)} reference photos, then ${frames.length} frames (Frame 1–${frames.length}).`, schema: visionSchema, images, tier: 'fast', maxTokens: 3000 }, () => ({ shots: [] }));
    if (res.source !== 'llm') return { results, source: 'colour' };
    for (const v of res.shots) {
      const r = results[v.frame - 1];
      if (!r) continue;
      const aspects = { face: v.face, proportions: v.proportions, accessories: v.accessories, clothing: v.clothing, surfaceDetails: v.surfaceDetails, geometry: v.geometry };
      const changed = Object.entries(aspects).filter(([, x]) => x === 'changed').map(([k]) => k);
      r.method = 'vision';
      r.aspects = Object.fromEntries(Object.entries(aspects).filter(([, x]) => x !== 'n/a')) as IdentityResult['aspects'];
      // The vision comparison replaces the colour signal (which stays recorded as a number).
      r.changes = [...v.changes, ...v.artefacts.map((x) => `AI artefact: ${x}`)].slice(0, 8);
      r.verdict = !v.productVisible ? 'unchecked' : changed.length >= 2 || v.artefacts.length ? 'changed' : changed.length === 1 ? 'suspicious' : 'consistent';
    }
    return { results, source: 'vision' };
  } finally {
    await Promise.all(refFiles.map((f) => fsp.rm(f, { force: true })));
  }
}

async function jpegBase64(file: string) {
  const { ffmpeg } = await import('../media/ffmpeg');
  const out = `${file}.ref.jpg`;
  await ffmpeg(['-i', file, '-vf', 'scale=512:-2', '-q:v', '4', out]);
  const data = (await fsp.readFile(out)).toString('base64');
  await fsp.rm(out, { force: true });
  return data;
}

/** Full QC of a render; stores and returns the verified report. */
export async function runQualityCheck(ctx: AppContext, p: { projectId: string; renderJobId: string }) {
  const [job] = await ctx.db.select().from(generationJobs).where(eq(generationJobs.id, p.renderJobId));
  if (!job?.outputAssetId || job.status !== 'completed') throw notFound('Finished render');
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, p.projectId));
  if (!project) throw notFound('Project');
  const [out] = await ctx.db.select().from(assets).where(eq(assets.id, job.outputAssetId));
  const [version] = await ctx.db.select().from(projectVersions).where(eq(projectVersions.projectId, p.projectId)).orderBy(desc(projectVersions.version)).limit(1);
  const tl = version ? (timelineSchema.safeParse(version.timeline).data ?? null) : null;
  const ad = (project.settings as { ad?: { mode?: string; cta?: string; campaignId?: string } }).ad ?? {};
  let modeKey = ad.mode;
  let cta = ad.cta ?? null;
  if (ad.campaignId) {
    const [c] = await ctx.db.select().from(adCampaigns).where(eq(adCampaigns.id, ad.campaignId));
    const plan = c?.plan as { mode?: string; cta?: string } | null;
    modeKey ??= plan?.mode;
    cta ??= plan?.cta ?? null;
  }
  // Where the brand ending is, from the timeline (logo card clip).
  let logoCard: { startSec: number; endSec: number } | null = null;
  const clipBounds: { startSec: number; endSec: number; soft: number }[] = [];
  // Only AI-made or AI-edited clips can differ from the product; the client's own footage cannot.
  const aiClip: boolean[] = [];
  if (tl) {
    const ids = tl.clips.map((c) => c.assetId);
    const rows = ids.length ? await ctx.db.select({ id: assets.id, source: assets.source }).from(assets).where(inArray(assets.id, ids)) : [];
    let t = 0;
    for (const c of tl.clips) {
      const len = c.outSec - c.inSec;
      if ((rows.find((r) => r.id === c.assetId)?.source as { logoCard?: boolean } | undefined)?.logoCard) logoCard = { startSec: t, endSec: t + len };
      const src = rows.find((r) => r.id === c.assetId)?.source as { aiGenerated?: boolean; operationId?: string; editedFrom?: string } | undefined;
      aiClip.push(Boolean(src?.aiGenerated || src?.operationId || src?.editedFrom));
      const soft = c.transition && c.transition.type !== 'cut' ? c.transition.durationSec : 0;
      clipBounds.push({ startSec: Math.round(t * 100) / 100, endSec: Math.round((t + len) * 100) / 100, soft });
      t += len - soft;
    }
  }
  const file = await downloadAssetToTemp(ctx, out as Asset);
  let m: RenderMeasurements | undefined;
  try {
    m = await measureRender(file);
    // Identity is checked per timeline clip (each shot once), when the timeline is known.
    if (clipBounds.length) m.frames = await framesAt(file, clipBounds.map((b) => (b.startSec + b.endSec) / 2), m.dir);
    const issues = judgeRender(m, tl, { modeKey, cta, expectedAspect: project.aspectRatio, logoCard, clipBounds });
    const refs = await referenceImages(ctx, p.projectId);
    const shotList = clipBounds.length ? clipBounds : m.shots;
    const onCard = (shot: number) => Boolean(logoCard && shotList[shot] && shotList[shot]!.startSec >= logoCard.startSec - 0.2);
    const skip = (shot: number) => onCard(shot) || (clipBounds.length > 0 && !aiClip[shot]);
    const identity = await checkIdentity(ctx, m, refs, skip);
    for (const r of identity.results)
      if (r.verdict === 'changed' || r.verdict === 'suspicious') issues.push({ severity: r.verdict === 'changed' ? 'error' : 'warning', area: 'identity', message: `Shot ${r.shot + 1}: ${r.changes[0] ?? 'the product may differ from your photos'} — approve or regenerate`, shot: r.shot, atSec: r.atSec });
    const score = scoreOf(issues);
    const status = issues.some((i) => i.severity === 'error') ? 'needs_review' : issues.some((i) => i.severity === 'warning') ? 'review_suggested' : 'passed';
    const { frames: _f, dir: _d, ...measurements } = m;
    void _f;
    void _d;
    const [row] = await ctx.db
      .insert(qualityReports)
      .values({ projectId: p.projectId, renderJobId: p.renderJobId, kind: 'render', score, status, measurements: measurements as unknown as Record<string, unknown>, issues: issues as unknown as Record<string, unknown>[], identity: identity.results as unknown as Record<string, unknown>[], identitySource: identity.source })
      .returning();
    return row!;
  } finally {
    await fsp.rm(file, { force: true });
    if (m) await fsp.rm(m.dir, { recursive: true, force: true });
  }
}

export async function latestQuality(ctx: AppContext, projectId: string) {
  const [row] = await ctx.db.select().from(qualityReports).where(eq(qualityReports.projectId, projectId)).orderBy(desc(qualityReports.createdAt)).limit(1);
  return row ?? null;
}

/** The user accepts a flagged shot as it is (recorded on the report). */
export async function approveIdentity(ctx: AppContext, projectId: string, reportId: string, shot: number) {
  const [row] = await ctx.db.select().from(qualityReports).where(and(eq(qualityReports.id, reportId), eq(qualityReports.projectId, projectId)));
  if (!row) throw notFound('Quality report');
  const identity = (row.identity as unknown as IdentityResult[]).map((r) => (r.shot === shot ? { ...r, approved: true } : r));
  const issues = (row.issues as unknown as QualityIssue[]).filter((i) => !(i.area === 'identity' && i.shot === shot));
  const status = issues.some((i) => i.severity === 'error') ? 'needs_review' : issues.some((i) => i.severity === 'warning') ? 'review_suggested' : 'passed';
  const [u] = await ctx.db.update(qualityReports).set({ identity: identity as unknown as Record<string, unknown>[], issues: issues as unknown as Record<string, unknown>[], status, score: scoreOf(issues) }).where(eq(qualityReports.id, reportId)).returning();
  return u!;
}

/** Queue handler: QC after an ad render. */
export async function runQualityJob(ctx: AppContext, qj: QueueJob): Promise<JobResult> {
  const { projectId, renderJobId } = qj.payload as { projectId: string; renderJobId: string };
  try {
    await runQualityCheck(ctx, { projectId, renderJobId });
  } catch (err) {
    ctx.log.warn('quality check failed', { projectId, message: (err as Error).message });
  }
}

/** Called when a render completes: ads get an automatic quality check. */
export async function queueQualityCheck(ctx: AppContext, projectId: string, renderJobId: string) {
  const [p] = await ctx.db.select({ kind: projects.kind }).from(projects).where(eq(projects.id, projectId));
  if (p?.kind !== 'ad') return;
  await enqueue(ctx.db, 'ad.quality', { projectId, renderJobId }, { queue: 'media', dedupeKey: `ad-quality:${renderJobId}`, maxAttempts: 1 });
}

