import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context';
import { adCampaigns, assets, footageSegments } from '../db/schema';
import { downloadAssetToTemp, storeAsset, type Asset } from '../services/assets';
import { extractFrame, ffmpeg, ffmpegPath, probe, run } from '../media/ffmpeg';
import type { LlmImage } from '../director/llm';

/*
 * Footage analysis: scene boundaries, technical quality per segment (sharpness, exposure, motion,
 * shake, sound), a representative frame, duplicate detection, and — when the AI Director is
 * configured — a vision pass that describes each segment and scores product presence, close-ups,
 * demonstrations and visual appeal. Nothing is deleted: weak or duplicate segments are only marked.
 */

export type SegmentMetrics = { sharpness: number; exposure: number; motion: number; shake: number; audio: number; durationSec: number };

const MAX_SEG = 6;
const MIN_SEG = 0.8;

/** Scene cut times (seconds) from FFmpeg's scene score. */
export async function sceneCuts(file: string, threshold = 0.32): Promise<number[]> {
  const { stderr } = await run(ffmpegPath(), ['-hide_banner', '-i', file, '-vf', `select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-'], { timeoutMs: 15 * 60_000 });
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1])).filter((t) => Number.isFinite(t));
}

/** Split [0, dur] at the cuts, merge slivers, and cut long takes into ≤6 s pieces. */
export function segmentsFromCuts(dur: number, cuts: number[]): [number, number][] {
  const bounds = [0, ...cuts.filter((c) => c > MIN_SEG && c < dur - MIN_SEG), dur].sort((a, b) => a - b);
  const raw: [number, number][] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i]!;
    const b = bounds[i + 1]!;
    if (b - a < MIN_SEG && raw.length) raw[raw.length - 1]![1] = b;
    else raw.push([a, b]);
  }
  const out: [number, number][] = [];
  for (const [a, b] of raw) {
    const n = Math.ceil((b - a) / MAX_SEG);
    for (let i = 0; i < n; i++) out.push([a + ((b - a) * i) / n, a + ((b - a) * (i + 1)) / n]);
  }
  return out.map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100]);
}

/** Per-frame stats from small greyscale frames (4 fps): sharpness (Laplacian variance), brightness, change. */
async function frameStats(file: string, dur: number) {
  const W = 160;
  const meta = await probe(file);
  const H = Math.max(2, Math.round((((meta.height ?? 720) / (meta.width ?? 1280)) * W) / 2) * 2);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fc-an-'));
  try {
    const raw = path.join(dir, 'g.raw');
    await ffmpeg(['-i', file, '-vf', `fps=4,scale=${W}:${H},format=gray`, '-t', String(Math.min(dur, 600)), '-f', 'rawvideo', '-pix_fmt', 'gray', raw], { timeoutMs: 15 * 60_000 });
    const buf = await fsp.readFile(raw);
    const size = W * H;
    const frames: { t: number; sharp: number; luma: number; diff: number; dx: number }[] = [];
    let prev: Buffer | null = null;
    for (let i = 0, k = 0; i + size <= buf.length; i += size, k++) {
      const f = buf.subarray(i, i + size);
      let sum = 0, lap = 0, lap2 = 0, cnt = 0;
      for (let y = 1; y < H - 1; y++)
        for (let x = 1; x < W - 1; x++) {
          const c = f[y * W + x]!;
          const l = 4 * c - f[y * W + x - 1]! - f[y * W + x + 1]! - f[(y - 1) * W + x]! - f[(y + 1) * W + x]!;
          lap += l;
          lap2 += l * l;
          sum += c;
          cnt++;
        }
      let diff = 0, dx = 0;
      if (prev) {
        for (let j = 0; j < size; j += 3) diff += Math.abs(f[j]! - prev[j]!);
        diff /= size / 3;
        // Global horizontal shift (cheap shake estimate): best of a few 1-D offsets on the middle row band.
        let best = Infinity;
        for (const s of [-6, -4, -2, 0, 2, 4, 6]) {
          let e = 0;
          for (let y = Math.floor(H / 3); y < (2 * H) / 3; y += 2) for (let x = 8; x < W - 8; x += 2) e += Math.abs(f[y * W + x]! - prev[y * W + x + s]!);
          if (e < best) [best, dx] = [e, Math.abs(s)];
        }
      }
      frames.push({ t: k / 4, sharp: lap2 / cnt - (lap / cnt) ** 2, luma: sum / cnt / 255, diff: diff / 255, dx });
      prev = Buffer.from(f);
    }
    return frames;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** Loudness (dBFS mean) of a range, or −91 when silent / no audio. */
async function meanVolume(file: string, a: number, b: number): Promise<number> {
  const { stderr } = await run(ffmpegPath(), ['-hide_banner', '-ss', String(a), '-t', String(Math.max(0.1, b - a)), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 120_000 }).catch(() => ({ stderr: '' }));
  const m = stderr.match(/mean_volume:\s*(-?[0-9.]+)/);
  return m ? Number(m[1]) : -91;
}

/** 64-bit average hash of a JPEG frame (for duplicate detection). */
async function aHash(img: string): Promise<bigint> {
  const raw = `${img}.ah`;
  await ffmpeg(['-i', img, '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', raw]);
  const b = await fsp.readFile(raw);
  await fsp.rm(raw, { force: true });
  const avg = b.reduce((s, v) => s + v, 0) / b.length;
  let h = 0n;
  for (let i = 0; i < 64; i++) if (b[i]! > avg) h |= 1n << BigInt(i);
  return h;
}
const hamming = (a: bigint, b: bigint) => {
  let x = a ^ b, c = 0;
  while (x) {
    c += Number(x & 1n);
    x >>= 1n;
  }
  return c;
};

const visionSchema = z.object({
  segments: z.array(
    z.object({
      index: z.number().int(),
      description: z.string(),
      product: z.number().min(0).max(1),
      closeup: z.number().min(0).max(1),
      demonstration: z.number().min(0).max(1),
      appeal: z.number().min(0).max(1),
      emotion: z.number().min(0).max(1),
      tags: z.array(z.string()).max(8),
      text_in_frame: z.string(),
    }),
  ),
});

const VISION_SYSTEM = `You are a commercial video editor reviewing a client's raw product footage. For each numbered frame (one per footage segment) describe what is visible in one short factual sentence and score 0–1: product (the product is clearly visible), closeup (detail/close-up shot), demonstration (product being made, used or shown working), appeal (visual beauty and polish), emotion (people's genuine reactions). Tags: short words (e.g. hands, packaging, finished product, workshop, painting, printing, table, gift, person, logo). text_in_frame: any readable text, else "". Only describe what is actually visible — never guess brand claims.`;

/** Analyse every uploaded file of a campaign and fill its segment catalog. */
export async function analyzeCampaign(ctx: AppContext, campaignId: string, onProgress: (phase: string, p: number) => Promise<void>) {
  const [c] = await ctx.db.select().from(adCampaigns).where(eq(adCampaigns.id, campaignId));
  if (!c) throw new Error('Campaign not found');
  const brief = c.brief as { footageAssetIds?: string[]; imageAssetIds?: string[]; referenceAdAssetId?: string | null; productNotes?: string };
  await ctx.db.delete(footageSegments).where(eq(footageSegments.campaignId, campaignId));
  const ids = [...(brief.footageAssetIds ?? []), ...(brief.imageAssetIds ?? [])];
  const rows = ids.length ? await ctx.db.select().from(assets).where(eq(assets.userId, c.userId)) : [];
  const files = ids.map((id) => rows.find((r) => r.id === id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  let index = 0;
  const hashes: { id: string; h: bigint }[] = [];
  const frameImages: { segId: string; label: string; data: string }[] = [];
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'fc-ads-'));
  try {
    for (let fi = 0; fi < files.length; fi++) {
      const a = files[fi]!;
      await onProgress(`Analysing ${a.originalName ?? `file ${fi + 1}`} (${fi + 1}/${files.length})`, 0.05 + (0.6 * fi) / Math.max(1, files.length));
      const src = await downloadAssetToTemp(ctx, a as Asset);
      try {
        const meta = await probe(src);
        const isImage = a.mediaType === 'image';
        const dur = isImage ? 3 : meta.durationSec;
        const parts = isImage ? ([[0, 3]] as [number, number][]) : segmentsFromCuts(dur, await sceneCuts(src));
        const stats = isImage ? [] : await frameStats(src, dur);
        for (const [s, e] of parts) {
          const fr = stats.filter((x) => x.t >= s && x.t < e);
          const sharpness = fr.length ? fr.reduce((m, x) => m + x.sharp, 0) / fr.length : 500;
          const best = fr.length ? fr.reduce((m, x) => (x.sharp > m.sharp ? x : m), fr[0]!) : { t: (s + e) / 2 };
          const metrics: SegmentMetrics = {
            durationSec: Math.round((e - s) * 100) / 100,
            sharpness: Math.round(Math.min(1, sharpness / 900) * 100) / 100,
            exposure: Math.round((fr.length ? fr.reduce((m, x) => m + x.luma, 0) / fr.length : 0.5) * 100) / 100,
            motion: Math.round(Math.min(1, (fr.length ? fr.reduce((m, x) => m + x.diff, 0) / fr.length : 0) * 8) * 100) / 100,
            shake: Math.round(Math.min(1, (fr.length ? fr.reduce((m, x) => m + x.dx, 0) / fr.length : 0) / 4) * 100) / 100,
            audio: isImage || !meta.hasAudio ? -91 : Math.round(await meanVolume(src, s, e)),
          };
          const frameFile = path.join(work, `f${index}.jpg`);
          if (isImage) await ffmpeg(['-i', src, '-vf', 'scale=480:-2', '-frames:v', '1', frameFile]);
          else {
            await extractFrame(src, frameFile, Math.min(e - 0.05, Math.max(s, best.t)));
            await ffmpeg(['-i', frameFile, '-vf', 'scale=480:-2', '-y', `${frameFile}.s.jpg`]);
            await fsp.rename(`${frameFile}.s.jpg`, frameFile);
          }
          const frame = await storeAsset(ctx, { userId: c.userId, kind: 'frame', mediaType: 'image', filePath: frameFile, mimeType: 'image/jpeg', makeThumbnail: false, source: { campaignId, segmentOf: a.id, atSec: best.t } });
          const h = await aHash(frameFile);
          const dup = hashes.find((x) => hamming(x.h, h) <= 5);
          const [seg] = await ctx.db
            .insert(footageSegments)
            .values({ campaignId, assetId: a.id, index: index++, startSec: s, endSec: e, frameAssetId: frame.id, metrics: metrics as unknown as Record<string, number>, duplicateOf: dup?.id ?? null, tags: [isImage ? 'photo' : 'video', ...(dup ? ['duplicate'] : [])] })
            .returning();
          hashes.push({ id: seg!.id, h });
          if (frameImages.length < 48) frameImages.push({ segId: seg!.id, label: `Frame ${frameImages.length + 1}`, data: (await fsp.readFile(frameFile)).toString('base64') });
        }
      } finally {
        await fsp.rm(src, { force: true });
      }
    }

    // Vision pass (AI Director, fast tier, ≤12 frames per request).
    await onProgress('Looking at the footage (AI)', 0.7);
    const notes = new Map<string, z.infer<typeof visionSchema>['segments'][number]>();
    let visionUsed = false;
    for (let i = 0; i < frameImages.length; i += 12) {
      const batch = frameImages.slice(i, i + 12);
      const images: LlmImage[] = batch.map((b, k) => ({ label: `Frame ${k + 1}`, mediaType: 'image/jpeg', data: b.data }));
      const res = await ctx.director.converse(
        { system: VISION_SYSTEM, prompt: `${batch.length} frames, numbered 1–${batch.length}.${brief.productNotes ? ` The client describes the product as: ${brief.productNotes.slice(0, 400)}` : ''}`, schema: visionSchema, images, tier: 'fast', maxTokens: 4000 },
        () => ({ segments: [] }),
      );
      visionUsed ||= res.source === 'llm';
      for (const s of res.segments) {
        const b = batch[s.index - 1];
        if (b) notes.set(b.segId, s);
      }
    }
    const segs = await ctx.db.select().from(footageSegments).where(eq(footageSegments.campaignId, campaignId)).orderBy(asc(footageSegments.index));
    for (const s of segs) {
      const m = s.metrics as unknown as SegmentMetrics;
      const v = notes.get(s.id);
      const exposureOk = 1 - Math.min(1, Math.abs(m.exposure - 0.5) * 2);
      const quality = 0.5 * m.sharpness + 0.3 * exposureOk + 0.2 * (1 - m.shake);
      const scores: Record<string, number> = v
        ? { product: v.product, closeup: v.closeup, demo: v.demonstration, appeal: v.appeal, emotion: v.emotion, quality: round(quality), overall: round(0.3 * v.appeal + 0.25 * v.product + 0.15 * v.closeup + 0.1 * v.demonstration + 0.2 * quality - (s.duplicateOf ? 0.25 : 0)) }
        : { quality: round(quality), overall: round(quality - (s.duplicateOf ? 0.25 : 0)) };
      await ctx.db
        .update(footageSegments)
        .set({ description: v?.description ?? '', tags: [...new Set([...(s.tags ?? []), ...(v?.tags ?? []).map((t) => t.toLowerCase().slice(0, 30))])].slice(0, 12), scores })
        .where(eq(footageSegments.id, s.id));
    }
    return { segments: segs.length, files: files.length, vision: visionUsed };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

const round = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
