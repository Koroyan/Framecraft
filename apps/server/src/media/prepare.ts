import fsp from 'node:fs/promises';
import { ffmpeg, FfmpegError, probe, type ProbeResult } from './ffmpeg';

/*
 * Source media preparation. The uploaded file is the master and is never replaced; from it we make
 *  - an editing proxy: H.264/AAC MP4, ≤1080p, constant frame rate, SDR — plays in every browser;
 *  - AI inputs: a copy that fits one provider's exact limits (size, length, resolution), made on
 *    demand from the chosen part of the master. A provider's 5 MB limit is never applied to uploads.
 */

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** HDR (PQ/HLG) → SDR BT.709, so previews and providers do not show washed-out colours. */
export const HDR_TO_SDR = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

/** Optional hardware encoder (FFMPEG_HWENC=nvenc|qsv|amf); software x264 is the fallback. */
function hwEncoder(): string | null {
  const hw = (process.env.FFMPEG_HWENC ?? '').toLowerCase();
  return hw === 'nvenc' ? 'h264_nvenc' : hw === 'qsv' ? 'h264_qsv' : hw === 'amf' ? 'h264_amf' : null;
}

async function encodeH264(args: { pre: string[]; post: string[]; output: string; quality: string[]; hwQuality: string[] }) {
  const hw = hwEncoder();
  if (hw) {
    try {
      await ffmpeg([...args.pre, '-c:v', hw, ...args.hwQuality, ...args.post, args.output], { timeoutMs: 60 * 60_000 });
      return;
    } catch (err) {
      if (!(err instanceof FfmpegError)) throw err;
      // No such device / driver here: software encoding below.
    }
  }
  await ffmpeg([...args.pre, '-c:v', 'libx264', ...args.quality, ...args.post, args.output], { timeoutMs: 60 * 60_000 });
}

/** Whether a browser can play the file as is (otherwise a proxy is needed for preview/editing). */
export function needsProxy(meta: ProbeResult, mimeType: string, sizeBytes: number): boolean {
  if (!meta.hasVideo) return false;
  const longSide = Math.max(meta.width ?? 0, meta.height ?? 0);
  const bitRate = meta.bitRate ?? (meta.durationSec ? (sizeBytes * 8) / meta.durationSec : 0);
  return mimeType !== 'video/mp4' || meta.videoCodec !== 'h264' || (meta.pixFmt !== undefined && meta.pixFmt !== 'yuv420p') || longSide > 1920 || bitRate > 16_000_000 || Boolean(meta.hdr) || Boolean(meta.vfr) || (meta.hasAudio && meta.audioCodec !== 'aac');
}

/** Fit inside a long side without upscaling. */
export function fitSize(w: number, h: number, longSide: number) {
  const k = Math.min(1, longSide / Math.max(w, h));
  return { width: even(w * k), height: even(h * k) };
}

const proxyFps = (meta: ProbeResult) => Math.max(15, Math.min(60, Math.round(meta.fps ?? 30)));

/** Editing proxy: same timeline as the master (CFR, same duration), browser-friendly. */
export async function makeProxy(input: string, output: string, meta?: ProbeResult): Promise<{ width: number; height: number; sizeBytes: number; fps: number }> {
  const m = meta ?? (await probe(input));
  const { width, height } = fitSize(m.width ?? 1280, m.height ?? 720, 1920);
  const fps = proxyFps(m);
  const vf = [...(m.hdr ? [HDR_TO_SDR] : []), `scale=${width}:${height}`, 'format=yuv420p'].join(',');
  await encodeH264({
    pre: ['-i', input, '-map', '0:v:0', '-map', '0:a:0?'],
    quality: ['-preset', 'veryfast', '-crf', '22', '-maxrate', '10M', '-bufsize', '20M'],
    hwQuality: ['-b:v', '8M', '-maxrate', '10M', '-bufsize', '20M'],
    post: ['-vf', vf, '-r', String(fps), '-vsync', 'cfr', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart'],
    output,
  });
  return { width, height, fps, sizeBytes: (await fsp.stat(output)).size };
}

export type ProviderInputLimits = {
  /** Hard size limit of the provider for this input (bytes). */
  maxBytes: number;
  /** Longest clip the provider accepts (s). */
  maxDurationSec: number;
  /** Largest useful resolution (long side, px). */
  maxLongSide: number;
  /** Keep the audio track (most video-to-video models ignore it). */
  audio: boolean;
};

export type AiInputResult = { width: number; height: number; bytes: number; startSec: number; durationSec: number; partial: boolean; videoKbps: number };

/**
 * Make a copy of [startSec, startSec+durationSec) that fits the provider's limits. The bitrate is
 * computed from the byte budget (audio and container overhead included), the resolution from the
 * bitrate (enough bits per pixel to keep detail), then verified and retried smaller if needed.
 * Longer sources are never silently truncated: the caller gets `partial: true` and the range used.
 */
export async function fitToProviderLimits(input: string, output: string, limits: ProviderInputLimits, range: { startSec?: number; durationSec?: number } = {}, meta?: ProbeResult): Promise<AiInputResult> {
  const m = meta ?? (await probe(input));
  const total = m.durationSec || 0;
  const startSec = Math.max(0, Math.min(range.startSec ?? 0, Math.max(0, total - 0.2)));
  const wanted = range.durationSec ?? total - startSec;
  const durationSec = Math.max(0.2, Math.min(wanted, limits.maxDurationSec, total - startSec || wanted));
  const partial = durationSec + 0.05 < wanted;
  const fps = Math.min(30, proxyFps(m));
  const audioKbps = limits.audio && m.hasAudio ? 64 : 0;
  // 6% container overhead + 24 kbit/s safety.
  let videoKbps = Math.floor(((limits.maxBytes * 8 * 0.94) / durationSec - audioKbps * 1000 - 24_000) / 1000);
  if (videoKbps < 80) throw new Error(`The provider accepts at most ${(limits.maxBytes / 1024 / 1024).toFixed(1)} MB; ${durationSec.toFixed(1)} s cannot fit. Choose a shorter part.`);
  videoKbps = Math.min(videoKbps, 12_000);
  const w0 = m.width ?? 1280;
  const h0 = m.height ?? 720;
  for (let attempt = 0; attempt < 4; attempt++) {
    // ~0.07 bits per pixel keeps product detail for H.264 at these rates.
    const sides = [limits.maxLongSide, 1920, 1280, 1024, 960, 854, 720, 640, 540, 480].filter((s) => s <= limits.maxLongSide);
    const side = sides.find((s) => {
      const { width, height } = fitSize(w0, h0, s);
      return (videoKbps * 1000) / (width * height * fps) >= 0.07;
    }) ?? sides.at(-1)!;
    const { width, height } = fitSize(w0, h0, side);
    const vf = [...(m.hdr ? [HDR_TO_SDR] : []), `scale=${width}:${height}`, 'format=yuv420p'].join(',');
    await ffmpeg(
      [
        '-ss', String(startSec), '-t', String(durationSec), '-i', input,
        '-map', '0:v:0', ...(audioKbps ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-ac', '2'] : ['-an']),
        '-vf', vf, '-r', String(fps), '-vsync', 'cfr',
        '-c:v', 'libx264', '-preset', 'medium', '-b:v', `${videoKbps}k`, '-maxrate', `${Math.round(videoKbps * 1.15)}k`, '-bufsize', `${videoKbps}k`,
        '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', output,
      ],
      { timeoutMs: 30 * 60_000 },
    );
    const bytes = (await fsp.stat(output)).size;
    if (bytes <= limits.maxBytes) return { width, height, bytes, startSec, durationSec, partial, videoKbps };
    videoKbps = Math.floor(videoKbps * (limits.maxBytes / bytes) * 0.9);
    if (videoKbps < 80) break;
  }
  throw new Error('Could not compress this part of the video under the provider limit; choose a shorter part.');
}
