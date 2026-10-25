import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AI_EDIT_MODES, CAMERA_MOVES, clipDuration, editMaskSchema, planOpSchema, sequenceOf, timelineSchema, type PlanOp } from '@framecraft/shared';
import type { AppContext } from '../context';
import { editOperations, projectVersions, shotComments, shots } from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import type { SessionLike } from '../generation/service';
import { estimateAiEdit } from './ai-edit';
import { ownedProject, ownedShot } from './versions';

/*
 * Editing assistant. It reads the project, proposes an explicit plan of operations within the
 * user's scope, and never applies anything itself: deterministic operations are applied by the
 * editor (free, undoable); generative ones become AI edit jobs only after the user approves the cost.
 */

export const copilotRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  scope: z
    .object({
      shotId: z.string().uuid().optional(),
      startSec: z.number().min(0).optional(),
      endSec: z.number().min(0).optional(),
      mask: editMaskSchema.nullable().optional(),
    })
    .default({}),
  /** The editor's current (possibly unsaved) timeline; falls back to the last saved one. */
  timeline: z.unknown().optional(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) })).max(12).default([]),
});

// Flat shape for the model (every field optional); each op is validated against planOpSchema after.
const modelOpSchema = z.object({
  op: z.enum(['trim', 'speed', 'transition', 'color', 'color_all', 'match_color', 'camera', 'fade', 'move', 'remove', 'text', 'logo', 'duck_music', 'animated_captions', 'ai_edit']),
  lastSec: z.number().optional(),
  volume: z.number().optional(),
  style: z.string().optional(),
  shot: z.number().int().optional(),
  durationSec: z.number().optional(),
  speed: z.number().optional(),
  type: z.string().optional(),
  adjust: z.record(z.string(), z.number()).optional(),
  fromShot: z.number().int().optional(),
  afterShot: z.number().int().optional(),
  preset: z.string().optional(),
  intensity: z.number().optional(),
  inSec: z.number().optional(),
  outSec: z.number().optional(),
  mode: z.string().optional(),
  instruction: z.string().optional(),
  startSec: z.number().optional(),
  endSec: z.number().optional(),
  text: z.string().optional(),
  position: z.string().optional(),
  why: z.string().optional(),
});
const replySchema = z.object({ reply: z.string(), operations: z.array(modelOpSchema).max(12) });

const SYSTEM = `You are the editing assistant inside Framecraft's video editor. Turn the user's request into a short explicit plan of operations.
Prefer free, exact operations (trim, speed, transition, color, match_color, camera, fade, move, remove, text) and use ai_edit (a paid generative edit of one shot's footage) only when the pixels themselves must change (fix an artifact, replace/remove/add an object, relight, restyle, background, motion).
Shots are numbered by their order in the movie (1-based). Never touch shots outside the scope given in Context. Times are seconds; for ai_edit, startSec/endSec are relative to the shot's start.
Operations: trim{shot,durationSec|inSec,outSec}; speed{shot,speed 0.25–4}; transition{shot,type: cut|fade|dissolve|wipeleft|wiperight|slideup|circleopen|fadeblack,durationSec} (into the next shot); color{shot,adjust:{exposure -2..2, brightness, contrast, saturation, temperature, tint, highlights, shadows -1..1, hue -180..180, blur 0..20, sharpen 0..2, vignette 0..1}}; match_color{shot,fromShot}; camera{shot,preset: ${CAMERA_MOVES.map((c) => c.key).join('|')},intensity 0..1}; fade{shot,inSec,outSec}; move{shot,afterShot (0 = first)}; remove{shot}; text{text,startSec,endSec,position top|center|bottom}; color_all{adjust} (every shot); logo{position top-left|top-right|bottom-left|bottom-right,lastSec} (the project's logo); duck_music{volume} (music quieter under voice-over); animated_captions{style words|pop|typewriter} (from the subtitles); ai_edit{shot,mode: ${AI_EDIT_MODES.map((m) => m.key).join('|')},instruction (English, precise, say what to keep),startSec,endSec}.
Reply in the user's language in 1–3 sentences saying what the plan does. If the request is unclear, ask one question and return no operations.`;

export async function copilotPlan(ctx: AppContext, user: SessionLike, projectId: string, input: z.infer<typeof copilotRequestSchema>) {
  await ownedProject(ctx, user, projectId);
  let timeline;
  if (input.timeline) timeline = timelineSchema.parse(input.timeline);
  else {
    const [latest] = await ctx.db.select().from(projectVersions).where(eq(projectVersions.projectId, projectId)).orderBy(desc(projectVersions.version)).limit(1);
    if (!latest) throw badRequest('Open the editor once so the movie has a timeline');
    timeline = timelineSchema.parse(latest.timeline);
  }
  const seq = sequenceOf(timeline);
  const shotRows = await ctx.db.select().from(shots).where(eq(shots.projectId, projectId));
  const scopeShot = input.scope.shotId ? (await ownedShot(ctx, user, input.scope.shotId)).shot : null;
  if (input.scope.shotId && !scopeShot) throw notFound('Shot');
  const scopeNumber = scopeShot ? seq.findIndex((n) => n.shotId === scopeShot.id) + 1 : 0;

  const lines = seq.map((n, i) => {
    const s = shotRows.find((r) => r.id === n.shotId);
    const clips = timeline.clips.filter((c) => n.clipIds.includes(c.id));
    const len = clips.reduce((a, c) => a + clipDuration(c), 0);
    const fx = clips.some((c) => c.adjust) ? ' graded' : '';
    const cam = clips.find((c) => c.camera)?.camera?.preset;
    return `Shot ${i + 1}: ${(s?.description ?? clips[0]?.label ?? 'clip').slice(0, 140)} — ${len.toFixed(1)} s${fx}${cam ? `, camera ${cam}` : ''}${clips.at(-1)?.transition ? `, ${clips.at(-1)!.transition!.type} into next` : ''}`;
  });
  let shotHistory = '';
  if (scopeShot) {
    const ops = await ctx.db.select().from(editOperations).where(eq(editOperations.shotId, scopeShot.id)).orderBy(asc(editOperations.createdAt));
    const notes = await ctx.db.select().from(shotComments).where(and(eq(shotComments.shotId, scopeShot.id))).orderBy(asc(shotComments.createdAt));
    shotHistory = [
      ...ops.slice(-6).map((o) => `Earlier AI edit (${o.mode}, ${o.status}): ${o.instruction}`),
      ...notes.slice(-8).map((c) => `${c.author === 'assistant' ? 'Assistant' : 'User'} note${c.startSec != null ? ` at ${c.startSec.toFixed(1)}–${(c.endSec ?? c.startSec).toFixed(1)} s` : ''}: ${c.text}`),
    ].join('\n');
  }
  const context = [
    `Movie (${timeline.aspectRatio}, ${seq.length} shots):`,
    ...lines,
    scopeShot
      ? `Scope: ONLY shot ${scopeNumber}${input.scope.startSec != null ? `, from ${input.scope.startSec.toFixed(2)} s to ${(input.scope.endSec ?? input.scope.startSec + 1).toFixed(2)} s of that shot` : ''}${input.scope.mask ? ', inside the area the user selected' : ''}.`
      : 'Scope: the whole project.',
    shotHistory && `This shot's history (refinements build on it):\n${shotHistory}`,
    input.history.length ? `Conversation so far:\n${input.history.map((h) => `${h.role}: ${h.text}`).join('\n')}` : '',
    `User: ${input.message}`,
  ]
    .filter(Boolean)
    .join('\n');

  const res = await ctx.director.converse({ system: SYSTEM, prompt: context, schema: replySchema, tier: 'smart', maxTokens: 3000 }, () => ({ reply: 'The AI assistant is not configured on this server, so I can’t plan edits. You can still make every change by hand.', operations: [] }));

  const plan: { op: PlanOp; generative: boolean; why?: string; estimate?: Awaited<ReturnType<typeof estimateAiEdit>> | null; blocked?: string }[] = [];
  for (const raw of res.operations) {
    const candidate = { ...raw, shot: raw.shot ?? scopeNumber } as Record<string, unknown>;
    if (candidate.op === 'ai_edit' && scopeShot && input.scope.startSec != null) {
      candidate.startSec ??= input.scope.startSec;
      candidate.endSec ??= input.scope.endSec ?? input.scope.startSec + 1;
    }
    const parsed = planOpSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const op = parsed.data;
    const target = 'shot' in op ? op.shot : null;
    if (op.op === 'logo' && !timeline.logo) {
      plan.push({ op, generative: false, why: raw.why, blocked: 'Add your logo first (Clip tab → Brand logo).' });
      continue;
    }
    if (op.op === 'animated_captions' && !timeline.subtitles.length) {
      plan.push({ op, generative: false, why: raw.why, blocked: 'Create subtitles first (Subs tab → Auto-subtitles from speech, or type them).' });
      continue;
    }
    const outOfScope = scopeShot && target !== null && target !== scopeNumber;
    if (outOfScope || (scopeShot && ['move', 'remove', 'text', 'color_all', 'logo', 'duck_music', 'animated_captions'].includes(op.op))) {
      plan.push({ op, generative: op.op === 'ai_edit', why: raw.why, blocked: 'Outside the selected shot — switch the assistant to the whole project to allow it.' });
      continue;
    }
    let estimate = null;
    if (op.op === 'ai_edit') {
      const node = seq[op.shot - 1];
      if (!node?.shotId) {
        plan.push({ op, generative: true, why: raw.why, blocked: 'AI edits work on generated shots only.' });
        continue;
      }
      const clip = timeline.clips.find((c) => c.id === node.clipIds[0])!;
      try {
        estimate = await estimateAiEdit(ctx, user, { shotId: node.shotId, versionId: clip.versionId, mode: op.mode, instruction: op.instruction, startSec: op.startSec ?? clip.inSec, endSec: op.endSec ?? clip.outSec, mask: scopeShot ? (input.scope.mask ?? null) : null, referenceAssetIds: [] });
      } catch (err) {
        plan.push({ op, generative: true, why: raw.why, blocked: (err as Error).message });
        continue;
      }
    }
    plan.push({ op, generative: op.op === 'ai_edit', why: raw.why, estimate });
  }

  // Keep the shot's conversation with the assistant (refinements read it later).
  if (scopeShot) {
    await ctx.db.insert(shotComments).values([
      { projectId, shotId: scopeShot.id, userId: user.id, author: 'user', text: input.message.slice(0, 2000), startSec: input.scope.startSec ?? null, endSec: input.scope.endSec ?? null, status: 'resolved' },
      { projectId, shotId: scopeShot.id, userId: user.id, author: 'assistant', text: res.reply.slice(0, 2000), status: 'resolved' },
    ]);
  }
  return { reply: res.reply, plan, offline: res.source === 'offline' };
}
