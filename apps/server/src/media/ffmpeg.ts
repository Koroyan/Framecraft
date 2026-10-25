import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { piecewiseExpr } from '@framecraft/shared';
import { atempoChain } from './clip-fx';

const require = createRequire(import.meta.url);

export type ProbeResult = {
  durationSec: number;
  width?: number;
  height?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Average video frame rate. */
  fps?: number;
  videoCodec?: string;
  formatName?: string;
  /** Display rotation in degrees (phone footage); width/height above are already display-oriented. */
  rotation?: number;
  /** Frame rate varies (average differs from the nominal rate) — common for phone recordings. */
  vfr?: boolean;
  /** Overall bitrate (bits/s). */
  bitRate?: number;
  pixFmt?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  /** HDR transfer (PQ / HLG): needs conversion to SDR for previews and providers. */
  hdr?: boolean;
  audioCodec?: string;
  audioSampleRate?: number;
  audioChannels?: number;
};

let ffmpegPathCache: string | undefined;
let ffprobePathCache: string | undefined;

export function ffmpegPath(): string {
  if (ffmpegPathCache) return ffmpegPathCache;
  ffmpegPathCache = process.env.FFMPEG_PATH || (require('@ffmpeg-installer/ffmpeg') as { path: string }).path;
  return ffmpegPathCache;
}

export function ffprobePath(): string {
  if (ffprobePathCache) return ffprobePathCache;
  ffprobePathCache = process.env.FFPROBE_PATH || (require('@ffprobe-installer/ffprobe') as { path: string }).path;
  return ffprobePathCache;
}

export class FfmpegError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export function run(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 10 * 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr).split('\n').slice(-15).join('\n');
        reject(new FfmpegError(`${path.basename(bin)} failed: ${err.message.split('\n')[0]}\n${tail}`, String(stderr)));
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export const ffmpeg = (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => run(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], opts);

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60_000 });
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string; bit_rate?: string };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      pix_fmt?: string;
      color_transfer?: string;
      color_primaries?: string;
      sample_rate?: string;
      channels?: number;
      tags?: { rotate?: string };
      side_data_list?: { rotation?: number }[];
      disposition?: { attached_pic?: number };
    }[];
  };
  // Cover art in audio files / HEIF thumbnails is an "attached picture", not footage.
  const v = data.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic) ?? data.streams?.find((s) => s.codec_type === 'video');
  const a = data.streams?.find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  const rate = (r?: string) => {
    const [num, den] = (r ?? '').split('/').map(Number);
    return num && den ? num / den : undefined;
  };
  // Phones store portrait video as landscape frames plus a rotation (tag or display matrix).
  // FFmpeg rotates while decoding, so report the size as it is shown.
  const rawRot = Number(v?.tags?.rotate ?? v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) || 0;
  const rotation = ((Math.round(rawRot / 90) * 90) % 360 + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  const avg = rate(v?.avg_frame_rate);
  const nominal = rate(v?.r_frame_rate);
  const transfer = v?.color_transfer;
  return {
    fps: avg ?? nominal,
    durationSec: Number.isFinite(duration) ? duration : 0,
    width: swap ? v?.height : v?.width,
    height: swap ? v?.width : v?.height,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    videoCodec: v?.codec_name,
    formatName: data.format?.format_name,
    rotation,
    vfr: Boolean(avg && nominal && Math.abs(avg - nominal) / nominal > 0.02),
    bitRate: Number(data.format?.bit_rate) || undefined,
    pixFmt: v?.pix_fmt,
    colorTransfer: transfer,
    colorPrimaries: v?.color_primaries,
    hdr: transfer === 'smpte2084' || transfer === 'arib-std-b67',
    audioCodec: a?.codec_name,
    audioSampleRate: Number(a?.sample_rate) || undefined,
    audioChannels: a?.channels,
  };
}

let featureCache: { xfade: boolean; drawtext: boolean; subtitles: boolean } | undefined;
export async function features() {
  if (featureCache) return featureCache;
  const { stdout } = await run(ffmpegPath(), ['-hide_banner', '-filters'], { timeoutMs: 30_000 });
  const has = (f: string) => new RegExp(`\\s${f}\\s`).test(stdout);
  featureCache = { xfade: has('xfade'), drawtext: has('drawtext'), subtitles: has('subtitles') };
  return featureCache;
}

const FONT_CANDIDATES = [
  process.env.FFMPEG_FONT_FILE,
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
];

export function findFont(): string | undefined {
  return FONT_CANDIDATES.find((f): f is string => Boolean(f && fs.existsSync(f)));
}

/** Temp working dir; ffmpeg runs inside it so filters can use relative file names (avoids Windows path escaping). */
export async function withWorkdir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fc-media-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Copy a font into the workdir as font.ttf; returns the drawtext fontfile option or ''. */
export async function stageFont(dir: string): Promise<string> {
  const font = findFont();
  if (!font) return '';
  await fsp.copyFile(font, path.join(dir, 'font.ttf'));
  return 'fontfile=font.ttf:';
}

export async function extractFrame(input: string, output: string, atSec: number): Promise<void> {
  await ffmpeg(['-ss', String(Math.max(0, atSec)), '-i', input, '-frames:v', '1', '-q:v', '3', output]);
}

export async function extractLastFrame(input: string, output: string): Promise<void> {
  const p = await probe(input);
  await extractFrame(input, output, Math.max(0, p.durationSec - 0.1));
}

export async function thumbnail(input: string, output: string): Promise<void> {
  const p = await probe(input);
  await ffmpeg(['-ss', String(Math.min(1, p.durationSec / 3)), '-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', output]);
}

export type NormalizeOptions = {
  width: number;
  height: number;
  fps?: number;
  /** Fill the frame by cropping (true) or letterbox with padding (false). */
  fill?: boolean;
  inSec?: number;
  outSec?: number;
  volume?: number;
  mute?: boolean;
  /** Playback speed (0.25–4). */
  speed?: number;
  reverse?: boolean;
  /** Hold the frame at `inSec` for this long instead of playing. */
  freezeSec?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  /** Fade towards black (1 = untouched). */
  opacity?: number;
  /** Extra video filters applied at output size (camera, colour grade); a function receives the source size. */
  effects?: string[] | ((src: { width: number; height: number; durationSec: number }) => Promise<string[]>);
  /** Working directory for filter side files (LUTs, masks) referenced by relative name. */
  cwd?: string;
  /** Auto reframe: crop around a moving subject centre (source fractions over source seconds). */
  reframe?: { t: number; x: number; y: number }[];
};

/**
 * Re-encode one clip to a uniform format: exact size, constant fps, yuv420p,
 * and a stereo AAC track (silent if the source has none) so clips can be joined.
 * Speed, reverse, freeze frames, fades and effects are applied here, so the output lasts
 * exactly as long as the clip does on the timeline.
 */
export async function normalizeClip(input: string, output: string, o: NormalizeOptions): Promise<void> {
  const p = await probe(input);
  const fps = o.fps ?? 30;
  const speed = o.freezeSec ? 1 : (o.speed ?? 1);
  const start = Math.min(o.inSec ?? 0, Math.max(0, p.durationSec - 0.05));
  const end = Math.min(o.outSec ?? p.durationSec, p.durationSec || (o.outSec ?? 0));
  const srcDur = o.freezeSec ? 1 / fps : Math.max(0.1, end - start);
  const dur = o.freezeSec ?? srcDur / speed;
  const scale = o.fill
    ? `scale=${o.width}:${o.height}:force_original_aspect_ratio=increase,crop=${o.width}:${o.height}`
    : `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  const v: string[] = [];
  let fitFilter = scale;
  if (o.reframe?.length && o.fill) {
    // Cover-scale, then crop around the subject: x(t) = clamp(cx(t)·iw − W/2, 0, iw − W), in source time.
    const pts = o.reframe.length > 60 ? o.reframe.filter((_, i) => i % Math.ceil(o.reframe!.length / 60) === 0) : o.reframe;
    const src = `(${start}+t*${speed})`;
    const cx = piecewiseExpr(pts.map((p) => p.t), pts.map((p) => p.x), 'linear').replaceAll('T', src);
    const cy = piecewiseExpr(pts.map((p) => p.t), pts.map((p) => p.y), 'linear').replaceAll('T', src);
    fitFilter = `scale=${o.width}:${o.height}:force_original_aspect_ratio=increase,crop=${o.width}:${o.height}:x='clip((${cx})*iw-${o.width}/2,0,iw-${o.width})':y='clip((${cy})*ih-${o.height}/2,0,ih-${o.height})'`;
  }
  if (o.freezeSec) v.push(`loop=loop=${Math.ceil(o.freezeSec * fps) + 1}:size=1:start=0`, `setpts=N/${fps}/TB`);
  if (o.reverse && !o.freezeSec) v.push('reverse');
  if (speed !== 1) v.push(`setpts=(PTS-STARTPTS)/${speed}`);
  const effects = typeof o.effects === 'function' ? await o.effects({ width: p.width ?? o.width, height: p.height ?? o.height, durationSec: dur }) : (o.effects ?? []);
  v.push(fitFilter, 'setsar=1', `fps=${fps}`, ...effects);
  if (o.opacity !== undefined && o.opacity < 1) v.push(`colorchannelmixer=rr=${o.opacity}:gg=${o.opacity}:bb=${o.opacity}`);
  if (o.fadeInSec) v.push(`fade=t=in:st=0:d=${o.fadeInSec}`);
  if (o.fadeOutSec) v.push(`fade=t=out:st=${Math.max(0, dur - o.fadeOutSec)}:d=${o.fadeOutSec}`);
  v.push(`trim=duration=${dur}`, 'format=yuv420p');
  const args = ['-ss', String(start), '-t', String(srcDur), '-i', input];
  const silent = !p.hasAudio || o.mute || Boolean(o.freezeSec);
  if (silent) {
    args.push('-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    args.push('-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-map', '0:v:0', '-map', '0:a:0');
  }
  args.push('-vf', v.join(','));
  const af = ['aresample=48000', 'aformat=channel_layouts=stereo'];
  if (!silent) {
    if (o.reverse) af.push('areverse');
    af.push(...atempoChain(speed));
    if (o.volume !== undefined && o.volume !== 1) af.push(`volume=${o.volume}`);
    if (o.fadeInSec) af.push(`afade=t=in:st=0:d=${o.fadeInSec}`);
    if (o.fadeOutSec) af.push(`afade=t=out:st=${Math.max(0, dur - o.fadeOutSec)}:d=${o.fadeOutSec}`);
  }
  args.push('-af', af.join(','));
  args.push('-t', String(dur), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output);
  await ffmpeg(args, { timeoutMs: 20 * 60_000, cwd: o.cwd });
}

export type JoinTransition = { type: string; durationSec: number } | undefined;

/**
 * Join normalized clips. A soft transition OVERLAPS the two clips by its duration — exactly the
 * timing the editor uses for layers, voices and captions (clipStartTimes); a cut does not.
 * Uses `xfade` when the FFmpeg build has it; otherwise the transitions are blended piece by piece,
 * which works on any build.
 */
export async function joinClips(inputs: string[], transitions: JoinTransition[], output: string, fps = 30): Promise<void> {
  if (!inputs.length) throw new Error('No clips to join');
  if (inputs.length === 1) {
    await fsp.copyFile(inputs[0]!, output);
    return;
  }
  const durations = await Promise.all(inputs.map(async (f) => (await probe(f)).durationSec));
  const { xfade } = await features();
  const args: string[] = [];
  inputs.forEach((f) => args.push('-i', f));
  const filters: string[] = [];
  const soft = (i: number) => {
    const t = transitions[i - 1];
    return t && t.type !== 'cut' && t.durationSec > 0 ? Math.min(t.durationSec, durations[i - 1]! / 2, durations[i]! / 2) : 0;
  };
  // Audio: crossfade over a soft transition, butt-join on a cut.
  let aPrev = '[0:a]';
  for (let i = 1; i < inputs.length; i++) {
    const d = soft(i);
    filters.push(d ? `${aPrev}[${i}:a]acrossfade=d=${d.toFixed(3)}[a${i}]` : `${aPrev}[${i}:a]concat=n=2:v=0:a=1[a${i}]`);
    aPrev = `[a${i}]`;
  }

  if (xfade) {
    let vPrev = '[0:v]';
    let offset = durations[0]!;
    for (let i = 1; i < inputs.length; i++) {
      const d = soft(i);
      const t = transitions[i - 1];
      offset -= d;
      filters.push(d ? `${vPrev}[${i}:v]xfade=transition=${t!.type === 'dissolve' ? 'dissolve' : t!.type}:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[v${i}]` : `${vPrev}[${i}:v]concat=n=2:v=1:a=0[v${i}]`);
      offset += durations[i]!;
      vPrev = `[v${i}]`;
    }
    args.push('-filter_complex', filters.join(';'), '-map', vPrev, '-map', aPrev);
    args.push('-filter_complex', filters.join(';'), '-map', vPrev, '-map', aPrev);
    await encodeJoined(args, output, fps);
    return;
  }
  // Old builds (no xfade): each clip's body and each soft transition are rendered as separate short
  // pieces — one small graph per piece, because big split/overlay graphs buffer every decoded
  // frame and crash these builds at 1080p — then the pieces are concatenated in order.
  await withWorkdir(async (dir) => {
    const n = (x: number) => x.toFixed(3);
    const enc = ['-an', '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p'];
    const pieces: string[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const dIn = i > 0 ? soft(i) : 0;
      const dOut = i < inputs.length - 1 ? soft(i + 1) : 0;
      if (dIn) {
        const h = n(dIn / 2);
        // Dip to black: the outgoing clip darkens in the first half, the incoming one brightens in the second.
        const mix =
          transitions[i - 1]!.type === 'fadeblack'
            ? `[p]fade=t=out:st=0:d=${h}[pa];[q]fade=t=in:st=${h}:d=${h}[qa];[pa][qa]blend=all_expr='if(lt(T,${h}),A,B)'[v]`
            : `[p][q]blend=all_expr='A*(1-T/${n(dIn)})+B*(T/${n(dIn)})'[v]`;
        const x = path.join(dir, `x${i}.mp4`);
        await ffmpeg(['-y', '-ss', n(durations[i - 1]! - dIn), '-t', n(dIn), '-i', inputs[i - 1]!, '-t', n(dIn), '-i', inputs[i]!, '-filter_complex', `[0:v]setpts=PTS-STARTPTS[p];[1:v]setpts=PTS-STARTPTS[q];${mix}`, '-map', '[v]', ...enc, x]);
        pieces.push(x);
      }
      const len = durations[i]! - dIn - dOut;
      if (len > 0.001) {
        const b = path.join(dir, `b${i}.mp4`);
        await ffmpeg(['-y', '-ss', n(dIn), '-t', n(len), '-i', inputs[i]!, '-map', '0:v', ...enc, b]);
        pieces.push(b);
      }
    }
    // Inputs 0..k-1 stay the original clips (their audio feeds the crossfade chain); the pieces follow.
    pieces.forEach((f) => args.push('-i', f));
    const vids = pieces.map((_, k) => `[${inputs.length + k}:v]`).join('');
    filters.push(`${vids}concat=n=${pieces.length}:v=1:a=0[vout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', aPrev);
    await encodeJoined(args, output, fps);
  });
}

async function encodeJoined(args: string[], output: string, fps: number) {
  args.push('-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output);
  await ffmpeg(args, { timeoutMs: 30 * 60_000 });
}

/** Trim/crop a provider output to the exact requested duration and aspect. */
export async function conformOutput(input: string, output: string, o: { width: number; height: number; durationSec: number; fill: boolean }): Promise<void> {
  await normalizeClip(input, output, { width: o.width, height: o.height, fill: o.fill, outSec: o.durationSec, fps: 30 });
}

/**
 * Development fixture clip — a clearly labelled synthetic test pattern.
 * It is NEVER presented as AI output: the label is burned into every frame.
 */
export async function generateFixtureClip(output: string, o: { width: number; height: number; durationSec: number; title: string; subtitle?: string }): Promise<void> {
  await withWorkdir(async (dir) => {
    const font = await stageFont(dir);
    await fsp.writeFile(path.join(dir, 'title.txt'), o.title.slice(0, 80));
    await fsp.writeFile(path.join(dir, 'sub.txt'), (o.subtitle ?? '').slice(0, 120) || ' ');
    await fsp.writeFile(path.join(dir, 'label.txt'), 'DEV FIXTURE - NOT AI GENERATED');
    // Fit the longest line inside ~90% of the width (glyphs average ~0.55em wide).
    const fit = (text: string, max: number) => Math.max(14, Math.min(max, Math.floor((o.width * 0.9) / (Math.max(1, text.length) * 0.55))));
    const big = fit(o.title.slice(0, 80), Math.round(Math.min(o.width, o.height) / 14));
    const small = fit(o.subtitle ?? '', Math.round(Math.min(o.width, o.height) / 25));
    const draw = (file: string, size: number, y: string, color = 'white') =>
      `drawtext=${font}textfile=${file}:fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.55:boxborderw=${Math.round(size / 3)}`;
    const vf = [
      `hue=h=t*12`,
      draw('label.txt', small, `h*0.08`, '#FFD54F'),
      draw('title.txt', big, `(h-text_h)/2`),
      draw('sub.txt', small, `h*0.62`),
    ].join(',');
    const local = 'fixture.mp4';
    await ffmpeg(
      [
        '-f', 'lavfi', '-i', `testsrc2=size=${o.width}x${o.height}:rate=30:duration=${o.durationSec}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${o.durationSec}`,
        '-vf', vf,
        '-af', 'volume=0.05,aformat=channel_layouts=stereo',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', local,
      ],
      { cwd: dir },
    );
    await fsp.copyFile(path.join(dir, local), output);
  });
}

/**
 * Brand end card from the user's own logo file (no AI model involved): the exact logo centred on
 * a dark backdrop with a slow push-in and fades, plus a silent audio track so it joins cleanly.
 */
export async function generateLogoCard(logo: string, output: string, o: { width: number; height: number; durationSec: number; background?: string }): Promise<void> {
  await withWorkdir(async (dir) => {
    await fsp.copyFile(logo, path.join(dir, 'logo'));
    const fps = 30;
    const frames = Math.max(1, Math.round(o.durationSec * fps));
    const box = Math.round(Math.min(o.width, o.height) * 0.62);
    const fadeOut = Math.max(0, o.durationSec - 0.6).toFixed(2);
    // Compose one still (logo fitted inside a square box, centred), then animate it with zoompan.
    const vf = [
      `[1:v]scale=${box}:${box}:force_original_aspect_ratio=decrease[lg]`,
      `[0:v][lg]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p,zoompan=z='min(1+0.06*on/${frames},1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${o.width}x${o.height}:fps=${fps},fade=t=in:st=0:d=0.5,fade=t=out:st=${fadeOut}:d=0.6[v]`,
    ].join(';');
    await ffmpeg(
      [
        '-f', 'lavfi', '-i', `color=c=${o.background ?? '#0b0b0f'}:s=${o.width}x${o.height}:d=1`,
        '-i', 'logo',
        '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`,
        '-filter_complex', vf,
        '-map', '[v]', '-map', '2:a',
        '-t', String(o.durationSec),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', 'card.mp4',
      ],
      { cwd: dir },
    );
    await fsp.copyFile(path.join(dir, 'card.mp4'), output);
  });
}

/**
 * A photo as a video clip (no AI): the exact photo fitted inside the frame over a blurred,
 * darkened cover-fill of itself, plus a silent audio track. Motion comes from the clip's camera.
 */
export async function stillToClip(image: string, output: string, o: { width: number; height: number; durationSec: number }): Promise<void> {
  await withWorkdir(async (dir) => {
    await fsp.copyFile(image, path.join(dir, 'still'));
    const { width: w, height: h } = o;
    const vf = [
      `[0:v]format=yuv420p,split[a][b]`,
      `[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=28:2,eq=brightness=-0.08:saturation=0.85[bg]`,
      `[b]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]`,
    ].join(';');
    await ffmpeg(
      [
        '-loop', '1', '-framerate', '30', '-i', 'still',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-filter_complex', vf,
        '-map', '[v]', '-map', '1:a',
        '-t', o.durationSec.toFixed(2),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-movflags', '+faststart', 'still.mp4',
      ],
      { cwd: dir },
    );
    await fsp.copyFile(path.join(dir, 'still.mp4'), output);
  });
}

/** A labelled placeholder still (storyboard frames when no image model is configured). */
export async function generatePlaceholderImage(output: string, o: { width: number; height: number; title: string; subtitle?: string }): Promise<void> {
  await withWorkdir(async (dir) => {
    const font = await stageFont(dir);
    await fsp.writeFile(path.join(dir, 'title.txt'), o.title.slice(0, 60));
    await fsp.writeFile(path.join(dir, 'sub.txt'), (o.subtitle ?? 'Placeholder frame - not AI generated').slice(0, 90));
    const size = Math.round(Math.min(o.width, o.height) / 12);
    const vf = [
      `drawtext=${font}textfile=title.txt:fontsize=${size}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
      `drawtext=${font}textfile=sub.txt:fontsize=${Math.round(size * 0.5)}:fontcolor=#9aa0b4:x=(w-text_w)/2:y=h*0.62`,
    ].join(',');
    await ffmpeg(['-f', 'lavfi', '-i', `gradients=s=${o.width}x${o.height}:c0=#141427:c1=#2a1f4d:duration=1`, '-frames:v', '1', '-vf', vf, 'out.jpg'], { cwd: dir }).catch(async () => {
      // `gradients` source is missing from older FFmpeg builds.
      await ffmpeg(['-f', 'lavfi', '-i', `color=c=#1b1830:s=${o.width}x${o.height}:d=1`, '-frames:v', '1', '-vf', vf, 'out.jpg'], { cwd: dir });
    });
    await fsp.copyFile(path.join(dir, 'out.jpg'), output);
  });
}
