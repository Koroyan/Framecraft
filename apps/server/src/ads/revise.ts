import crypto from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { adMode, adPlanSchema, endCardSeconds, timelineDuration, timelineSchema, type AdPlan } from '@framecraft/shared';
import type { AppContext } from '../context';
import { adCampaigns, footageSegments, projects, scenes, shots } from '../db/schema';
import type { SessionLike } from '../generation/service';
import { badRequest, conflict, notFound, paymentRequired } from '../lib/errors';
import { estimateShotRegeneration, isLogoShot, regenerateShot, updateShot } from '../movie/movie';
import { createRenderJob, getTimeline, saveTimeline } from '../editor/editor';
import { chooseConcept, updatePlan } from './campaigns';

/*
 * Revisions after a preview — "Improve the hook", "Make it more emotional", "Show more product
 * details", "Shorten the logo ending", "Improve shot 2" — that touch only what the request needs.
 * Footage ads: the plan is edited (free) and re-assembled. AI-scene ads: only the affected shots
 * get a new prompt and are regenerated after the user approves their exact price; every other
 * approved shot is kept. The logo ending is rebuilt locally (free).
 */

export const REVISION_PRESETS = ['improve_hook', 'more_emotional', 'more_details', 'shorten_ending', 'improve_shot'] as const;
export type RevisionPreset = (typeof REVISION_PRESETS)[number];
export const revisionSchema = z.object({ preset: z.enum(REVISION_PRESETS), shotIndex: z.number().int().min(0).optional(), note: z.string().max(500).optional() });
export type RevisionInput = z.infer<typeof revisionSchema>;

type Segment = typeof footageSegments.$inferSelect;
const sc = (s: Segment, k: string) => (s.scores as Record<string, number>)[k] ?? 0;
const room = (s: Segment) => ((s.tags ?? []).includes('photo') ? 5 : s.endSec - s.startSec);

// ------------------------------------------------------------------ footage ads (free plan edits)

export async function reviseCampaign(ctx: AppContext, user: SessionLike, campaignId: string, input: RevisionInput) {
  const [c] = await ctx.db.select().from(adCampaigns).where(eq(adCampaigns.id, campaignId));
  if (!c || (c.userId !== user.id && user.role !== 'admin')) throw notFound('Campaign');
  if (!c.plan) throw badRequest('Plan the ad first');
  const plan: AdPlan = adPlanSchema.parse(c.plan);
  const segs = await ctx.db.select().from(footageSegments).where(eq(footageSegments.campaignId, campaignId)).orderBy(asc(footageSegments.index));
  const used = new Set(plan.scenes.map((s) => s.segmentId));
  const mode = adMode(plan.mode);
  const changes: string[] = [];

  if (input.preset === 'more_emotional') {
    const emotional = ((c.concepts ?? []) as { key: string; mode?: string; angle?: string }[]).find((k) => k.mode === 'emotional_story' || k.angle === 'emotional_story');
    if (emotional && emotional.key !== plan.conceptKey) {
      await chooseConcept(ctx, user, campaignId, emotional.key);
      return { changes: ['Re-planned with the Emotional Storytelling concept'], replanned: true };
    }
    // No emotional concept: slower rhythm, softer transitions, warmer music.
    for (const s of plan.scenes) {
      const seg = segs.find((x) => x.id === s.segmentId);
      if (seg) s.durationSec = Math.round(Math.min(room(seg) - s.inSec, s.durationSec * 1.15) * 100) / 100;
      if (s.transition === 'cut') s.transition = 'dissolve';
      if (!s.camera || s.camera === 'static') s.camera = 'dolly';
    }
    plan.musicMood = 'emotional piano building to a warm swell';
    changes.push('Slower, softer cut with dissolves and gentle camera moves', 'Warmer, emotional music');
  }

  if (input.preset === 'improve_hook') {
    const best = [...segs].filter((s) => !s.duplicateOf).sort((a, b) => sc(b, 'closeup') + sc(b, 'appeal') + sc(b, 'motion') - (sc(a, 'closeup') + sc(a, 'appeal') + sc(a, 'motion')))[0];
    const first = plan.scenes[0]!;
    if (best && best.id !== first.segmentId) {
      plan.scenes[0] = { ...first, segmentId: best.id, inSec: 0, crop: null, durationSec: Math.min(room(best), Math.max(1.2, Math.min(2.2, first.durationSec))) };
      changes.push('Opens on the most striking close-up of the footage');
    }
    plan.scenes[0] = { ...plan.scenes[0]!, role: 'hook', camera: mode.editing.pacing === 'fast' ? 'zoom_to' : 'push_in', framing: 'close', transition: 'cut', durationSec: Math.min(plan.scenes[0]!.durationSec, mode.editing.pacing === 'fast' ? 1.2 : 2.2) };
    changes.push('A shorter, moving first shot that cuts on action');
  }

  if (input.preset === 'more_details') {
    const candidates = segs.filter((s) => !s.duplicateOf && !used.has(s.id)).sort((a, b) => sc(b, 'closeup') - sc(a, 'closeup'));
    let swapped = 0;
    for (let i = 1; i < plan.scenes.length - 1 && swapped < 2; i++) {
      const s = plan.scenes[i]!;
      if (s.role === 'detail') continue;
      const alt = candidates.shift();
      if (alt) plan.scenes[i] = { ...s, segmentId: alt.id, inSec: 0, crop: null, role: 'detail', framing: 'close', durationSec: Math.min(room(alt), s.durationSec) };
      else plan.scenes[i] = { ...s, role: 'detail', framing: 'detail', crop: { x: 0.5, y: 0.45, scale: 1.7 }, camera: 'push_in' };
      swapped++;
    }
    changes.push(`${swapped} shot${swapped === 1 ? '' : 's'} now show product details up close`);
  }

  if (input.preset === 'shorten_ending') {
    const now = plan.endCardSec ?? endCardSeconds(plan.scenes.reduce((t, s) => t + s.durationSec, 0), mode.editing.endCardRatio);
    plan.endCardSec = Math.max(1.5, Math.round((now - 0.7) * 10) / 10);
    changes.push(`Brand ending shortened to ${plan.endCardSec} s`);
  }

  if (input.preset === 'improve_shot') {
    const i = input.shotIndex ?? 0;
    const s = plan.scenes[i];
    if (!s) throw notFound('Shot');
    const alt = segs.filter((x) => !x.duplicateOf && !used.has(x.id)).sort((a, b) => sc(b, 'overall') - sc(a, 'overall'))[0];
    if (alt) plan.scenes[i] = { ...s, segmentId: alt.id, inSec: 0, crop: null, durationSec: Math.min(room(alt), s.durationSec) };
    else plan.scenes[i] = { ...s, camera: s.camera === 'push_in' ? 'pan_right' : 'push_in', crop: s.crop ? null : { x: 0.5, y: 0.45, scale: 1.5 } };
    changes.push(alt ? `Shot ${i + 1} uses better footage` : `Shot ${i + 1} gets a new framing and camera move`);
  }

  const r = await updatePlan(ctx, user, campaignId, plan);
  return { changes, replanned: false, plan: r.plan, review: r.review, estimate: r.estimate };
}

// ------------------------------------------------------------------ AI-scene ads (only affected shots)

type ShotRow = typeof shots.$inferSelect;

function rewrite(preset: RevisionPreset, prompt: string, modeKey: string | undefined, note?: string) {
  const mode = adMode(modeKey);
  const extra =
    preset === 'improve_hook'
      ? 'Make the first second striking: begin in extreme macro on the most distinctive detail of the product with a confident push-in and sculpted rim light; the product must be recognisable by second 2.'
      : preset === 'more_emotional'
        ? 'More emotional: warmer, softer golden light, slower and more intimate camera movement, gentle haze, a feeling of a precious personal gift.'
        : preset === 'more_details'
          ? 'Show more product detail: slow macro passes over the finest painted and sculpted details, shallow depth of field, crisp textures.'
          : `Improve this shot: cleaner composition, more cinematic light, smoother ${mode.editing.camera[0] ?? 'camera'} movement.`;
  return `${prompt.replace(/\s*\[Revision:[^\]]*\]/g, '')} [Revision: ${extra}${note ? ` ${note}` : ''} Keep the product exactly as in the reference photos.]`.slice(0, 2000);
}

/** Which shots a request touches (logo cards are never regenerated by a model). */
function targets(list: ShotRow[], input: RevisionInput): ShotRow[] {
  const content = list.filter((s) => !isLogoShot(s));
  if (input.preset === 'improve_hook') return content.slice(0, 1);
  if (input.preset === 'improve_shot') return content.filter((_, i) => i === (input.shotIndex ?? 0));
  if (input.preset === 'more_details') return content.slice(1, -1).slice(0, 2);
  if (input.preset === 'more_emotional') return [content[0], content.at(-1)].filter((s, i, a): s is ShotRow => Boolean(s) && a.indexOf(s) === i);
  return [];
}

async function projectShots(ctx: AppContext, projectId: string) {
  const rows = await ctx.db.select({ shot: shots, sceneIndex: scenes.index }).from(shots).innerJoin(scenes, eq(scenes.id, shots.sceneId)).where(eq(shots.projectId, projectId)).orderBy(asc(scenes.index), asc(shots.index));
  return rows.map((r) => r.shot);
}

/** Step 1: what would change and what it costs. Nothing is changed or charged. */
export async function proposeSceneRevision(ctx: AppContext, user: SessionLike, projectId: string, input: RevisionInput) {
  const [p] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  if (!p || p.userId !== user.id || p.kind !== 'ad') throw notFound('Ad project');
  const modeKey = (p.settings as { ad?: { mode?: string } }).ad?.mode;
  const list = await projectShots(ctx, projectId);
  if (input.preset === 'shorten_ending') {
    const card = list.find((s) => isLogoShot(s));
    if (!card) throw badRequest('This ad has no brand ending to shorten');
    return { id: crypto.randomUUID(), input, shots: [{ shotId: card.id, index: list.indexOf(card), description: card.description, newPrompt: null, newDurationSec: Math.max(2, card.durationSec - 1), credits: 0 }], totalCredits: 0, free: true };
  }
  const chosen = targets(list, input);
  if (!chosen.length) throw badRequest('No shot matches this request');
  const items = [];
  for (const s of chosen) items.push({ shotId: s.id, index: list.indexOf(s), description: s.description, newPrompt: rewrite(input.preset, s.prompt, modeKey, input.note), newDurationSec: null as number | null, credits: await estimateShotRegeneration(ctx, user, s.id) });
  return { id: crypto.randomUUID(), input, shots: items, totalCredits: items.reduce((t, x) => t + x.credits, 0), free: false };
}

/** Step 2: apply an approved proposal — only its shots change; the film is re-rendered when they are ready. */
export async function applySceneRevision(ctx: AppContext, user: SessionLike, projectId: string, input: RevisionInput, approvedCredits: number) {
  const proposal = await proposeSceneRevision(ctx, user, projectId, input);
  if (proposal.totalCredits > approvedCredits) throw paymentRequired(`This change needs ${proposal.totalCredits} credits — approve that amount to start it.`, { required: proposal.totalCredits });
  const busy = (await projectShots(ctx, projectId)).filter((s) => ['queued', 'generating'].includes(s.status));
  if (busy.length) throw conflict('Some shots are still being generated — wait for them first.');
  const started: string[] = [];
  for (const it of proposal.shots) {
    if (it.newPrompt) await updateShot(ctx, user, it.shotId, { prompt: it.newPrompt });
    if (it.newDurationSec) await updateShot(ctx, user, it.shotId, { durationSec: it.newDurationSec });
    const r = await regenerateShot(ctx, user, it.shotId, `ad-revise:${it.shotId}:${Date.now()}`);
    if (r.job) started.push(r.job.id);
  }
  // Free changes (logo ending) re-render at once; regenerated shots re-render from the editor when ready.
  let renderJobId: string | null = null;
  if (proposal.free) {
    // Swap the rebuilt logo card into the saved timeline (user edits kept) and pull the ending texts in.
    const { timeline } = await getTimeline(ctx, user, projectId);
    const tl = timelineSchema.parse(timeline);
    const before = timelineDuration(tl);
    for (const it of proposal.shots) {
      const [card] = await ctx.db.select().from(shots).where(eq(shots.id, it.shotId));
      const clip = tl.clips.find((c) => c.shotId === it.shotId);
      if (card?.currentAssetId && clip) {
        clip.assetId = card.currentAssetId;
        clip.outSec = clip.inSec + (it.newDurationSec ?? clip.outSec - clip.inSec);
      }
    }
    const after = timelineDuration(tl);
    for (const l of tl.layers) if (l.endSec > after) l.endSec = Math.max(l.startSec + 0.3, Math.round((l.endSec - (before - after)) * 100) / 100);
    for (const l of tl.layers) if (l.startSec >= after) l.startSec = Math.max(0, Math.round((after - 1) * 100) / 100);
    for (const a of tl.audio) a.outSec = Math.min(a.outSec, a.inSec + Math.max(0.5, after - a.startSec));
    await saveTimeline(ctx, user, projectId, tl, { label: 'Shorter brand ending' });
    renderJobId = (await createRenderJob(ctx, user, projectId, { timeline: tl, preset: 'master', idempotencyKey: `ad-revise-render:${projectId}:${Date.now()}` })).id;
  }
  return { proposal, started, renderJobId };
}
