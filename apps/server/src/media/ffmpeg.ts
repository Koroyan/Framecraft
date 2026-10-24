import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

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
    format?: { duration?: string; format_name?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; avg_frame_rate?: string; r_frame_rate?: string }[];
  };
  const v = data.streams?.find((s) => s.codec_type === 'video');
  const a = data.streams?.find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  const rate = (r?: string) => {
    const [num, den] = (r ?? '').split('/').map(Number);
    return num && den ? num / den : undefined;
  };
  return {
    fps: rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate),
    durationSec: Number.isFinite(duration) ? duration : 0,
    width: v?.width,
    height: v?.height,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    videoCodec: v?.codec_name,
    formatName: data.format?.format_name,
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
  /** Extra video filters applied at output size (camera, colour grade). */
  effects?: string[];
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
  if (o.freezeSec) v.push(`loop=loop=${Math.ceil(o.freezeSec * fps) + 1}:size=1:start=0`, `setpts=N/${fps}/TB`);
  if (o.reverse && !o.freezeSec) v.push('reverse');
  if (speed !== 1) v.push(`setpts=(PTS-STARTPTS)/${speed}`);
  v.push(scale, 'setsar=1', `fps=${fps}`, ...(o.effects ?? []));
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
  await ffmpeg(args, { timeoutMs: 20 * 60_000 });
}

export type JoinTransition = { type: string; durationSec: number } | undefined;

/**
 * Join normalized clips. Uses `xfade`/`acrossfade` when the FFmpeg build has
 * them; otherwise falls back to fade-through-black, which works on any build.
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
  const hasSoft = transitions.some((t) => t && t.type !== 'cut' && t.durationSec > 0);

  if (xfade && hasSoft) {
    let vPrev = '[0:v]';
    let aPrev = '[0:a]';
    let offset = durations[0]!;
    for (let i = 1; i < inputs.length; i++) {
      const t = transitions[i - 1];
      const soft = t && t.type !== 'cut' && t.durationSec > 0;
      const d = soft ? Math.min(t!.durationSec, durations[i - 1]! / 2, durations[i]! / 2) : 0.04;
      const kind = soft ? (t!.type === 'dissolve' ? 'dissolve' : t!.type) : 'fade';
      offset -= d;
      const vOut = `[v${i}]`;
      const aOut = `[a${i}]`;
      filters.push(`${vPrev}[${i}:v]xfade=transition=${kind}:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}${vOut}`);
      filters.push(`${aPrev}[${i}:a]acrossfade=d=${d.toFixed(3)}${aOut}`);
      offset += durations[i]!;
      vPrev = vOut;
      aPrev = aOut;
    }
    args.push('-filter_complex', filters.join(';'), '-map', vPrev, '-map', aPrev);
  } else {
    // Fade-through-black on each side of a soft transition, then concat.
    const parts: string[] = [];
    inputs.forEach((_, i) => {
      const inT = i > 0 ? transitions[i - 1] : undefined;
      const outT = transitions[i];
      const vf: string[] = [];
      const af: string[] = [];
      const dur = durations[i]!;
      if (inT && inT.type !== 'cut') {
        const d = Math.min(inT.durationSec / 2, dur / 3);
        vf.push(`fade=t=in:st=0:d=${d.toFixed(3)}`);
        af.push(`afade=t=in:st=0:d=${d.toFixed(3)}`);
      }
      if (outT && outT.type !== 'cut' && i < inputs.length - 1) {
        const d = Math.min(outT.durationSec / 2, dur / 3);
        vf.push(`fade=t=out:st=${(dur - d).toFixed(3)}:d=${d.toFixed(3)}`);
        af.push(`afade=t=out:st=${(dur - d).toFixed(3)}:d=${d.toFixed(3)}`);
      }
      filters.push(`[${i}:v]${vf.length ? vf.join(',') : 'null'}[v${i}]`);
      filters.push(`[${i}:a]${af.length ? af.join(',') : 'anull'}[a${i}]`);
      parts.push(`[v${i}][a${i}]`);
    });
    filters.push(`${parts.join('')}concat=n=${inputs.length}:v=1:a=1[vout][aout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]');
  }
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
