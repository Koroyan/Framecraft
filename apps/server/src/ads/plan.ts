import { z } from 'zod';
import { adPlanSchema, adStyle, AI_EDIT_MODES, type AdBrief, type AdPlan } from '@framecraft/shared';
import type { AppContext } from '../context';
import type { footageSegments } from '../db/schema';

/*
 * AI Creative Director for real-footage ads. The model sees the segment catalog (what is in the
 * footage, scores, timecodes), the brief, the brand facts and the style, and returns an editable
 * plan. The server validates it: only real segments, cuts inside their segment, target length,
 * hook first; in "original" mode generative enhancements are removed.
 */

type Segment = typeof footageSegments.$inferSelect;
type Brand = { name: string; voice: string; products: string; ctas: string[]; slogans: string[]; offers: string; website: string | null } | null;

const LANG = { ka: 'Georgian', en: 'English', ru: 'Russian' } as const;

const modelPlanSchema = z.object({
  title: z.string(),
  audience: z.string(),
  objective: z.string(),
  hook: z.string(),
  narrative: z.string(),
  benefits: z.array(z.string()).max(8),
  scenes: z
    .array(
      z.object({
        segment: z.string(),
        offsetSec: z.number(),
        durationSec: z.number(),
        role: z.enum(['hook', 'story', 'detail', 'demo', 'benefit', 'reveal', 'proof', 'cta']),
        purpose: z.string(),
        overlayText: z.string(),
        overlayKind: z.enum(['none', 'title', 'lower_third', 'caption', 'price', 'cta']),
        transition: z.enum(['cut', 'fade', 'dissolve', 'fadeblack']),
        enhanceMode: z.string(),
        enhanceInstruction: z.string(),
      }),
    )
    .min(1)
    .max(40),
  voiceover: z.array(z.object({ text: z.string(), sceneIndex: z.number().int() })).max(20),
  musicMood: z.string(),
  cta: z.string(),
  notes: z.array(z.string()).max(8),
});

const SYSTEM = `You are an award-winning commercial director and editor. You cut real client footage into an advertisement.
Rules:
- Use ONLY the listed footage segments (by id) and cut inside them: offsetSec + durationSec ≤ the segment's duration.
- Put a compelling hook in the first 2 seconds, build a clear narrative, avoid repeating near-identical shots, end on the product and the call to action.
- Respect the style's pacing (shot length range) and the target length (sum of scene durations ≈ target).
- Write overlay texts, voice-over lines and the CTA in the requested language. Keep on-screen texts short (≤ 6 words).
- NEVER invent facts: no prices, discounts, awards, guarantees, delivery promises, testimonials or product features that are not in the brief or brand facts. Use overlayKind "price" only when the brief gives a price.
- Voice-over: third-person narration unless the brief says otherwise; about 2.3 words per second; one line per scene it covers (sceneIndex = first scene of the line).
- enhanceMode/enhanceInstruction: only when AI enhancement is allowed and a shot clearly benefits (e.g. relight a dark shot, replace a messy background); otherwise "none" and "". Never change the product itself.`;

export async function planAd(ctx: AppContext, p: { brief: AdBrief; segments: Segment[]; brand: Brand; reference?: { shots: number; avgShotSec: number; hookSec: number } | null }): Promise<AdPlan & { source: 'llm' | 'offline' }> {
  const style = adStyle(p.brief.style);
  const segs = p.segments.filter((s) => s.role === 'footage');
  const sid = new Map(segs.map((s, i) => [`S${i + 1}`, s]));
  const catalog = segs
    .map((s, i) => {
      const sc = s.scores as Record<string, number>;
      const m = s.metrics as Record<string, number>;
      return `S${i + 1}: ${(s.endSec - s.startSec).toFixed(1)} s · ${s.description || '(no description)'} · tags: ${(s.tags ?? []).join(', ')} · scores overall ${sc.overall ?? '?'}, product ${sc.product ?? '?'}, close-up ${sc.closeup ?? '?'}, appeal ${sc.appeal ?? '?'}, quality ${sc.quality ?? '?'}${(m.shake ?? 0) > 0.5 ? ' · shaky' : ''}${s.duplicateOf ? ' · near-duplicate' : ''}`;
    })
    .join('\n');
  const prompt = [
    `Client request: ${p.brief.request}`,
    `Style: ${style.label} — pacing ${style.pacing}, shots ${style.shotSec[0]}–${style.shotSec[1]} s, tone ${style.tone}, hook: ${style.hook}, favour: ${style.favour}.`,
    `Target length: ${p.brief.lengthSec} s · aspect ${p.brief.aspectRatio} · language ${LANG[p.brief.language]} · voice-over ${p.brief.voiceover ? 'yes' : 'no'}.`,
    `AI enhancement: ${p.brief.mode === 'enhanced' ? `allowed (product preservation: ${p.brief.preservation}; modes: ${AI_EDIT_MODES.map((m) => m.key).join(', ')})` : 'NOT allowed — original footage only'}.`,
    p.brief.productNotes ? `Product notes from the client: ${p.brief.productNotes}` : '',
    p.brand ? `Brand facts (the only facts you may state): name ${p.brand.name}; voice ${p.brand.voice || 'n/a'}; products ${p.brand.products || 'n/a'}; approved slogans ${p.brand.slogans.join(' | ') || 'n/a'}; CTAs ${p.brand.ctas.join(' | ') || 'n/a'}; offers ${p.brand.offers || 'none given'}; website ${p.brand.website ?? 'n/a'}.` : 'No brand kit — keep the CTA generic unless the brief gives one.',
    p.brief.cta ? `CTA requested: ${p.brief.cta}` : '',
    p.reference ? `Structure inspiration from a reference ad (do not copy its content): ${p.reference.shots} shots, average ${p.reference.avgShotSec.toFixed(1)} s, hook ${p.reference.hookSec.toFixed(1)} s.` : '',
    `Footage segments:\n${catalog}`,
  ]
    .filter(Boolean)
    .join('\n');

  const res = await ctx.director.converse({ system: SYSTEM, prompt, schema: modelPlanSchema, tier: 'smart', maxTokens: 8000 }, () => offlinePlan(p.brief, segs, p.brand));
  const scenes: AdPlan['scenes'] = [];
  for (const [i, s] of res.scenes.entries()) {
    const seg = sid.get(s.segment) ?? segs.find((x) => x.id === s.segment);
    if (!seg) continue;
    const segLen = seg.endSec - seg.startSec;
    const dur = Math.max(0.5, Math.min(segLen, s.durationSec));
    const inSec = Math.max(0, Math.min(segLen - dur, s.offsetSec));
    const mode = AI_EDIT_MODES.find((m) => m.key === s.enhanceMode)?.key;
    scenes.push({
      id: `sc${i + 1}`,
      segmentId: seg.id,
      inSec: round2(inSec),
      durationSec: round2(dur),
      role: s.role,
      purpose: s.purpose.slice(0, 200),
      overlay: s.overlayKind !== 'none' && s.overlayText.trim() ? { text: s.overlayText.trim().slice(0, 120), kind: s.overlayKind } : null,
      transition: s.transition,
      enhance: p.brief.mode === 'enhanced' && mode && s.enhanceInstruction.trim().length >= 3 ? { mode, instruction: s.enhanceInstruction.trim().slice(0, 500) } : null,
    });
  }
  if (!scenes.length) throw new Error('The plan used none of the uploaded footage');
  fitLength(scenes, p.brief.lengthSec, segs);
  const plan = adPlanSchema.parse({
    title: res.title.slice(0, 120),
    audience: res.audience.slice(0, 300),
    objective: res.objective.slice(0, 300),
    hook: res.hook.slice(0, 300),
    narrative: res.narrative.slice(0, 800),
    benefits: res.benefits.map((b) => b.slice(0, 160)),
    scenes,
    voiceover: p.brief.voiceover ? res.voiceover.filter((v) => v.text.trim()).map((v) => ({ text: v.text.trim().slice(0, 400), sceneIndex: Math.max(0, Math.min(scenes.length - 1, v.sceneIndex)) })) : [],
    musicMood: res.musicMood || style.music,
    cta: (res.cta || p.brief.cta).slice(0, 120),
    endCard: true,
    notes: res.notes.map((n) => n.slice(0, 300)),
  });
  return { ...plan, source: res.source === 'llm' ? 'llm' : 'offline' };
}

/** Scale scene lengths (within each segment's limits) so the cut lasts about the target length. */
export function fitLength(scenes: AdPlan['scenes'], target: number, segs: Segment[]) {
  for (let pass = 0; pass < 4; pass++) {
    const total = scenes.reduce((s, x) => s + x.durationSec, 0);
    if (Math.abs(total - target) / target < 0.06) return;
    const k = target / total;
    for (const s of scenes) {
      const seg = segs.find((x) => x.id === s.segmentId)!;
      const room = seg.endSec - seg.startSec - s.inSec;
      s.durationSec = round2(Math.max(0.5, Math.min(room, s.durationSec * k)));
    }
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Without the AI Director: best segments by score, hook = best close-up, in a sensible order. */
function offlinePlan(brief: AdBrief, segs: Segment[], brand: Brand): z.infer<typeof modelPlanSchema> {
  const style = adStyle(brief.style);
  const usable = segs.filter((s) => !s.duplicateOf);
  const score = (s: Segment) => (s.scores as Record<string, number>).overall ?? 0;
  const ranked = [...usable].sort((a, b) => score(b) - score(a));
  const shot = (style.shotSec[0] + style.shotSec[1]) / 2;
  const n = Math.max(1, Math.min(ranked.length, Math.round(brief.lengthSec / shot)));
  const chosen = ranked.slice(0, n);
  const hook = [...chosen].sort((a, b) => ((b.scores as Record<string, number>).closeup ?? 0) - ((a.scores as Record<string, number>).closeup ?? 0))[0]!;
  const rest = chosen.filter((s) => s !== hook).sort((a, b) => a.index - b.index);
  const order = [hook, ...rest];
  const label = (s: Segment) => `S${segs.indexOf(s) + 1}`;
  const name = brand?.name ?? '';
  return {
    title: name ? `${name} — ad` : 'Product ad',
    audience: '',
    objective: 'Show the real product attractively and invite viewers to act.',
    hook: 'Strongest close-up first',
    narrative: 'Best footage in source order, ending on the product and the call to action.',
    benefits: [],
    scenes: order.map((s, i) => ({ segment: label(s), offsetSec: 0, durationSec: Math.min(s.endSec - s.startSec, shot), role: i === 0 ? 'hook' : i === order.length - 1 ? 'reveal' : 'story', purpose: '', overlayText: i === 0 && name ? name : i === order.length - 1 ? brief.cta || brand?.ctas[0] || '' : '', overlayKind: i === 0 && name ? 'title' : i === order.length - 1 && (brief.cta || brand?.ctas[0]) ? 'cta' : 'none', transition: style.transition, enhanceMode: 'none', enhanceInstruction: '' })),
    voiceover: [],
    musicMood: style.music,
    cta: brief.cta || brand?.ctas[0] || '',
    notes: ['Planned without the AI Director (not configured): segments were picked by their quality scores only.'],
  };
}
