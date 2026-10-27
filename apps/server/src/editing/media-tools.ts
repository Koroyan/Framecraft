import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { layerSchema, parseCube, rasterHash, type LayerInput } from '@framecraft/shared';
import type { AppContext } from '../context';
import { assets } from '../db/schema';
import { assetUrl, downloadAssetToTemp, getOwnedAsset, storeAsset, type Asset } from '../services/assets';
import { ffmpeg, probe } from '../media/ffmpeg';
import { rasterizeLayer } from '../media/raster';
import { trackBox, type TrackBox } from '../media/tracker';
import { badRequest } from '../lib/errors';
import type { SessionLike } from '../generation/service';

/*
 * Editor media helpers: cached waveform and filmstrip images, server-rendered text/shape rasters
 * (the preview shows exactly what the export composites), object tracking and LUT import.
 * Derived images are stored once per source and reused.
 */

async function derived(ctx: AppContext, userId: string, key: string) {
  const [a] = await ctx.db
    .select()
    .from(assets)
    .where(and(eq(assets.userId, userId), sql`${assets.source}->>'derivedKey' = ${key}`))
    .limit(1);
  return a as Asset | undefined;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fc-tools-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** Audio waveform (PNG, 1600×96) for the timeline. */
export async function waveform(ctx: AppContext, user: SessionLike, assetId: string) {
  const a = await getOwnedAsset(ctx, user.id, assetId);
  const key = `waveform:${a.id}`;
  const hit = await derived(ctx, user.id, key);
  if (hit) return { url: await assetUrl(ctx, hit) };
  const src = await downloadAssetToTemp(ctx, a);
  try {
    if (!(await probe(src)).hasAudio) throw badRequest('This file has no sound');
    return await withTemp(async (dir) => {
      const out = path.join(dir, 'wave.png');
      await ffmpeg(['-i', src, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1600x96:colors=0xB9AEFF', '-frames:v', '1', out]);
      const asset = await storeAsset(ctx, { userId: user.id, projectId: a.projectId, kind: 'thumbnail', mediaType: 'image', filePath: out, mimeType: 'image/png', makeThumbnail: false, source: { derivedKey: key } });
      return { url: await assetUrl(ctx, asset) };
    });
  } finally {
    await fsp.rm(src, { force: true });
  }
}

/** Filmstrip: N evenly spaced frames tiled horizontally (each 96 px tall). */
export async function filmstrip(ctx: AppContext, user: SessionLike, assetId: string, frames = 10) {
  const a = await getOwnedAsset(ctx, user.id, assetId);
  if (a.mediaType !== 'video') throw badRequest('Filmstrips are made from videos');
  const key = `filmstrip:${a.id}:${frames}`;
  const hit = await derived(ctx, user.id, key);
  if (hit) return { url: await assetUrl(ctx, hit), frames };
  const src = await downloadAssetToTemp(ctx, a);
  try {
    const dur = (await probe(src)).durationSec || 1;
    return await withTemp(async (dir) => {
      const out = path.join(dir, 'strip.jpg');
      await ffmpeg(['-i', src, '-vf', `fps=${frames / dur},scale=-2:96,tile=${frames}x1`, '-frames:v', '1', '-q:v', '4', out]);
      const asset = await storeAsset(ctx, { userId: user.id, projectId: a.projectId, kind: 'thumbnail', mediaType: 'image', filePath: out, mimeType: 'image/jpeg', makeThumbnail: false, source: { derivedKey: key } });
      return { url: await assetUrl(ctx, asset), frames };
    });
  } finally {
    await fsp.rm(src, { force: true });
  }
}

/** Server-rendered text / shape layer at a frame height (the same raster the export uses). */
export async function rasterLayer(ctx: AppContext, user: SessionLike, input: LayerInput, frameHeight: number) {
  const layer = layerSchema.parse(input);
  if (layer.kind !== 'text' && layer.kind !== 'shape') throw badRequest('Only text and shape layers need a raster');
  const h = Math.min(2160, Math.max(240, Math.round(frameHeight)));
  const hash = rasterHash(layer);
  // v2: Georgian text no longer falls back to boxes in fonts without Georgian glyphs.
  const key = `raster:v2:${hash}:${h}`;
  const hit = await derived(ctx, user.id, key);
  if (hit) return { assetId: hit.id, url: await assetUrl(ctx, hit), hash, ...(hit.source as { width: number; height: number; rows: number }) };
  return withTemp(async (dir) => {
    const r = await rasterizeLayer(layer, h, path.join(dir, 'layer.png'));
    const asset = await storeAsset(ctx, { userId: user.id, kind: 'thumbnail', mediaType: 'image', filePath: r.file, mimeType: 'image/png', makeThumbnail: false, source: { derivedKey: key, width: r.width, height: r.height, rows: r.rows } });
    return { assetId: asset.id, url: await assetUrl(ctx, asset), hash, width: r.width, height: r.height, rows: r.rows };
  });
}

/** Track a box through a video asset (source seconds). */
export async function trackInAsset(ctx: AppContext, user: SessionLike, assetId: string, o: { box: TrackBox; atSec: number; startSec: number; endSec: number; smoothing?: number; region?: [number, number][] }) {
  const a = await getOwnedAsset(ctx, user.id, assetId);
  if (a.mediaType !== 'video') throw badRequest('Tracking needs a video');
  if (o.endSec - o.startSec > 120) throw badRequest('Track at most 2 minutes at a time');
  // The editing proxy has the same timeline and orientation (positions are fractions of the frame).
  const src = await downloadAssetToTemp(ctx, a, { prefer: 'proxy' });
  try {
    return await trackBox(src, o);
  } finally {
    await fsp.rm(src, { force: true });
  }
}

/** Import a 3D .cube LUT (validated) as a reusable asset. */
export async function importLut(ctx: AppContext, user: SessionLike, name: string, text: string) {
  if (text.length > 12 * 1024 * 1024) throw badRequest('LUT file is too large');
  let size: number;
  try {
    size = parseCube(text).size;
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  return withTemp(async (dir) => {
    const file = path.join(dir, 'look.cube');
    await fsp.writeFile(file, text);
    const asset = await storeAsset(ctx, { userId: user.id, kind: 'upload', mediaType: 'text', filePath: file, mimeType: 'text/plain', originalName: name.slice(0, 120), makeThumbnail: false, source: { lut: true, size } });
    return { assetId: asset.id, name, size, url: await assetUrl(ctx, asset) };
  });
}
