import fsp from 'node:fs/promises';
import path from 'node:path';
import { ASPECT_DIMENSIONS, timelineDuration, type Timeline } from '@framecraft/shared';
import { ffmpeg, joinClips, normalizeClip, probe, stageFont, withWorkdir, features } from './ffmpeg';
import { toSrt } from './subtitles';

export type RenderInputs = {
  timeline: Timeline;
  /** Resolve an asset id to a local file path (downloaded from storage by the caller). */
  resolve: (assetId: string) => Promise<string>;
  output: string;
  onProgress?: (phase: string, fraction: number) => Promise<void> | void;
};

const POS_Y = { top: 'h*0.12', center: '(h-text_h)/2', bottom: 'h*0.74' } as const;

const LOGO_POS = {
  'top-left': 'x=W*0.04:y=H*0.04',
  'top-right': 'x=W-w-W*0.04:y=H*0.04',
  'bottom-left': 'x=W*0.04:y=H-h-H*0.04',
  'bottom-right': 'x=W-w-W*0.04:y=H-h-H*0.04',
} as const;

/**
 * Render an editor timeline to MP4 using only FFmpeg (no paid AI services):
 * trim → normalize → transitions → audio mix → text/subtitles → logo → H.264/AAC.
 */
export async function renderTimeline({ timeline, resolve, output, onProgress }: RenderInputs): Promise<{ durationSec: number; width: number; height: number }> {
  if (!timeline.clips.length) throw new Error('Timeline has no clips');
  const dims = ASPECT_DIMENSIONS[timeline.aspectRatio][timeline.resolution];
  return withWorkdir(async (dir) => {
    // 1. Normalize every clip to identical size/fps/audio layout.
    const normalized: string[] = [];
    for (let i = 0; i < timeline.clips.length; i++) {
      const c = timeline.clips[i]!;
      const src = await resolve(c.assetId);
      const out = path.join(dir, `clip${i}.mp4`);
      await normalizeClip(src, out, { width: dims.width, height: dims.height, fps: timeline.fps, fill: true, inSec: c.inSec, outSec: c.outSec, volume: c.volume, mute: timeline.muteClipAudio });
      normalized.push(out);
      await onProgress?.('Preparing clips', (i + 1) / timeline.clips.length / 2);
    }

    // 2. Join with transitions.
    const joined = path.join(dir, 'joined.mp4');
    await joinClips(normalized, timeline.clips.map((c) => c.transition), joined, timeline.fps);
    await onProgress?.('Joining clips', 0.6);
    const total = (await probe(joined)).durationSec || timelineDuration(timeline);

    // 3. Overlays, audio mix and final encode.
    const args: string[] = ['-i', 'joined.mp4'];
    const font = await stageFont(dir);
    let inputIndex = 1;
    const audioLabels: string[] = ['[0:a]'];
    const filters: string[] = [];

    for (let i = 0; i < timeline.audio.length; i++) {
      const a = timeline.audio[i]!;
      const src = await resolve(a.assetId);
      const local = `audio${i}${path.extname(src) || '.mp3'}`;
      await fsp.copyFile(src, path.join(dir, local));
      args.push('-i', local);
      const len = Math.max(0.1, a.outSec - a.inSec);
      const chain = [
        `atrim=start=${a.inSec}:end=${a.outSec}`,
        'asetpts=PTS-STARTPTS',
        'aresample=48000',
        'aformat=channel_layouts=stereo',
        `volume=${a.volume}`,
        a.fadeInSec > 0 ? `afade=t=in:st=0:d=${a.fadeInSec}` : '',
        a.fadeOutSec > 0 ? `afade=t=out:st=${Math.max(0, len - a.fadeOutSec)}:d=${a.fadeOutSec}` : '',
        `adelay=${Math.round(a.startSec * 1000)}|${Math.round(a.startSec * 1000)}`,
      ].filter(Boolean);
      filters.push(`[${inputIndex}:a]${chain.join(',')}[aud${i}]`);
      audioLabels.push(`[aud${i}]`);
      inputIndex++;
    }
    let audioOut = '[0:a]';
    if (audioLabels.length > 1) {
      // amix lowers each input's level; compensate so narration/music keep their set volume.
      filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=first:dropout_transition=0,volume=${audioLabels.length}[amixed]`);
      audioOut = '[amixed]';
    }

    // Video overlays.
    const vf: string[] = [];
    for (let i = 0; i < timeline.texts.length; i++) {
      const t = timeline.texts[i]!;
      await fsp.writeFile(path.join(dir, `text${i}.txt`), t.text);
      const size = Math.round(t.fontSize * (dims.width / 1080));
      vf.push(
        `drawtext=${font}textfile=text${i}.txt:fontsize=${size}:fontcolor=${t.color}:x=(w-text_w)/2:y=${POS_Y[t.position]}${
          t.background ? `:box=1:boxcolor=black@0.5:boxborderw=${Math.round(size / 3)}` : ':shadowcolor=black@0.7:shadowx=2:shadowy=2'
        }:enable='between(t,${t.startSec},${t.endSec})'`,
      );
    }
    if (timeline.burnSubtitles && timeline.subtitles.length) {
      const { subtitles } = await features();
      const fontSize = Math.round(dims.height / 32);
      if (subtitles && !process.env.FC_DRAWTEXT_SUBTITLES) {
        await fsp.writeFile(path.join(dir, 'subs.srt'), toSrt(timeline.subtitles));
        if (font) await fsp.copyFile(path.join(dir, 'font.ttf'), path.join(dir, 'subfont.ttf'));
        // libass sizes are relative to its default PlayResY of 288 lines, not output pixels.
        const assSize = timeline.aspectRatio === '9:16' ? 11 : 15;
        vf.push(`subtitles=subs.srt:fontsdir=.:force_style='FontSize=${assSize},Outline=1.5,Shadow=0,MarginV=${timeline.aspectRatio === '9:16' ? 40 : 18}'`);
      } else {
        for (let i = 0; i < timeline.subtitles.length; i++) {
          const s = timeline.subtitles[i]!;
          await fsp.writeFile(path.join(dir, `sub${i}.txt`), s.text);
          vf.push(`drawtext=${font}textfile=sub${i}.txt:fontsize=${fontSize}:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.82:enable='between(t,${s.startSec},${s.endSec})'`);
        }
      }
    }

    let videoOut = '[0:v]';
    if (vf.length) {
      filters.push(`[0:v]${vf.join(',')}[vtxt]`);
      videoOut = '[vtxt]';
    }
    if (timeline.logo) {
      const src = await resolve(timeline.logo.assetId);
      const local = `logo${path.extname(src) || '.png'}`;
      await fsp.copyFile(src, path.join(dir, local));
      args.push('-i', local);
      const w = Math.round(dims.width * timeline.logo.scale);
      filters.push(`[${inputIndex}:v]scale=${w}:-1,format=rgba,colorchannelmixer=aa=${timeline.logo.opacity}[logo]`);
      const { x, y } = timeline.logo;
      // Free placement from the editor (clamped so the logo stays fully inside the frame), else a corner preset.
      const place = x !== undefined && y !== undefined ? `x='min(W-w,W*${x.toFixed(4)})':y='min(H-h,H*${y.toFixed(4)})'` : LOGO_POS[timeline.logo.position];
      filters.push(`${videoOut}[logo]overlay=${place}[vlogo]`);
      videoOut = '[vlogo]';
      inputIndex++;
    }

    const out = 'final.mp4';
    if (filters.length) args.push('-filter_complex', filters.join(';'));
    args.push('-map', videoOut === '[0:v]' ? '0:v' : videoOut, '-map', audioOut === '[0:a]' ? '0:a' : audioOut);
    args.push('-t', String(total), '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out);
    await onProgress?.('Encoding', 0.75);
    await ffmpeg(args, { cwd: dir, timeoutMs: 60 * 60_000 });
    await fsp.copyFile(path.join(dir, out), output);
    await onProgress?.('Done', 1);
    const p = await probe(output);
    return { durationSec: p.durationSec, width: p.width ?? dims.width, height: p.height ?? dims.height };
  });
}
