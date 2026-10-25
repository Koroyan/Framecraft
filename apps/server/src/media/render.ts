import fsp from 'node:fs/promises';
import path from 'node:path';
import { ASPECT_DIMENSIONS, timelineDuration, type Timeline } from '@framecraft/shared';
import { ffmpeg, joinClips, normalizeClip, probe, stageFont, withWorkdir, features } from './ffmpeg';
import { toSrt } from './subtitles';
import { parseCube, type Lut3d } from '@framecraft/shared';
import { cameraFilters, lookFilters } from './clip-fx';
import { layerFilters } from './layers-render';

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
  const luts = new Map<string, Lut3d>();
  const loadLut = async (assetId: string) => {
    if (!luts.has(assetId)) luts.set(assetId, parseCube(await fsp.readFile(await resolve(assetId), 'utf8')));
    return luts.get(assetId)!;
  };
  return withWorkdir(async (dir) => {
    // 1. Normalize every clip to identical size/fps/audio layout.
    const normalized: string[] = [];
    for (let i = 0; i < timeline.clips.length; i++) {
      const c = timeline.clips[i]!;
      const src = await resolve(c.assetId);
      const out = path.join(dir, `clip${i}.mp4`);
      await normalizeClip(src, out, {
        width: dims.width,
        height: dims.height,
        fps: timeline.fps,
        fill: true,
        inSec: c.inSec,
        outSec: c.outSec,
        volume: c.volume,
        mute: timeline.muteClipAudio,
        speed: c.speed,
        reframe: c.reframe?.points,
        reverse: c.reverse,
        freezeSec: c.freezeSec,
        fadeInSec: c.fadeInSec,
        fadeOutSec: c.fadeOutSec,
        opacity: c.opacity,
        cwd: dir,
        // Colour (and masked recolours, in source coordinates) first, then the 2D camera.
        effects: async (srcInfo) => [
          ...(await lookFilters(c.adjust, { dir, key: `c${i}`, width: dims.width, height: dims.height, fps: timeline.fps, durationSec: srcInfo.durationSec, srcWidth: srcInfo.width, srcHeight: srcInfo.height, inSec: c.inSec, speed: c.speed || 1, customLut: c.adjust?.lut ? await loadLut(c.adjust.lut.assetId) : null })),
          ...cameraFilters(c.camera, dims.width, dims.height, timeline.fps),
        ],
      });
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
    const filters: string[] = [];

    const audible = timeline.audio.filter((a) => !a.muted);
    const voices: string[] = [];
    const beds: { label: string; duck: boolean }[] = [];
    for (let i = 0; i < audible.length; i++) {
      const a = audible[i]!;
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
        a.denoise ? 'afftdn=nr=18:nf=-35' : '',
        `adelay=${Math.round(a.startSec * 1000)}|${Math.round(a.startSec * 1000)}`,
      ].filter(Boolean);
      filters.push(`[${inputIndex}:a]${chain.join(',')}[aud${i}]`);
      if (a.kind === 'voice') voices.push(`[aud${i}]`);
      else beds.push({ label: `[aud${i}]`, duck: a.duck });
      inputIndex++;
    }
    // Sound of picture-in-picture video layers (when their volume is up).
    for (let i = 0; i < timeline.layers.length; i++) {
      const L = timeline.layers[i]!;
      if (L.kind !== 'video' || !L.assetId || L.volume <= 0) continue;
      const src = await resolve(L.assetId);
      if (!(await probe(src)).hasAudio) continue;
      const local = `lyaudio${i}${path.extname(src) || '.mp4'}`;
      await fsp.copyFile(src, path.join(dir, local));
      args.push('-ss', String(L.inSec), '-t', String(L.endSec - L.startSec), '-i', local);
      filters.push(`[${inputIndex}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${L.volume},adelay=${Math.round(L.startSec * 1000)}|${Math.round(L.startSec * 1000)}[lya${i}]`);
      beds.push({ label: `[lya${i}]`, duck: false });
      inputIndex++;
    }
    const mix: string[] = ['[0:a]'];
    const ducked = voices.length ? beds.filter((b) => b.duck) : [];
    if (voices.length) {
      let vbus = voices[0]!;
      if (voices.length > 1) {
        filters.push(`${voices.join('')}amix=inputs=${voices.length}:duration=longest:dropout_transition=0,volume=${voices.length}[vbus]`);
        vbus = '[vbus]';
      }
      if (ducked.length) {
        // Music ducks under the narration: the voice bus drives a sidechain compressor.
        filters.push(`${vbus}asplit=${ducked.length + 1}[vmix]${ducked.map((_, j) => `[vsc${j}]`).join('')}`);
        ducked.forEach((b, j) => filters.push(`[vsc${j}]apad[vscp${j}];${b.label}[vscp${j}]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=450:makeup=1[duck${j}]`));
        mix.push('[vmix]', ...ducked.map((_, j) => `[duck${j}]`));
      } else mix.push(vbus);
    }
    mix.push(...beds.filter((b) => !ducked.includes(b)).map((b) => b.label));
    let audioOut = '[0:a]';
    const finish = timeline.loudnorm ? ',loudnorm=I=-14:TP=-1.5:LRA=11' : '';
    if (mix.length > 1) {
      // amix lowers each input's level; compensate so narration/music keep their set volume.
      filters.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=0,volume=${mix.length}${finish}[amixed]`);
      audioOut = '[amixed]';
    } else if (finish) {
      filters.push(`[0:a]${finish.slice(1)}[amixed]`);
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
    // Overlay track (V2): images and videos above the main picture.
    for (let i = 0; i < timeline.overlays.length; i++) {
      const o = timeline.overlays[i]!;
      const src = await resolve(o.assetId);
      const ext = path.extname(src) || '.png';
      const local = `overlay${i}${ext}`;
      await fsp.copyFile(src, path.join(dir, local));
      const isImage = /\.(png|jpe?g|webp)$/i.test(ext);
      const len = Math.max(0.1, o.endSec - o.startSec);
      if (isImage) args.push('-loop', '1', '-t', String(len), '-i', local);
      else args.push('-ss', String(o.inSec), '-t', String(len), '-i', local);
      const w = Math.max(2, Math.round((dims.width * o.w) / 2) * 2);
      filters.push(`[${inputIndex}:v]scale=${w}:-2,format=rgba,colorchannelmixer=aa=${o.opacity},setpts=PTS-STARTPTS+${o.startSec}/TB[ov${i}]`);
      filters.push(`${videoOut}[ov${i}]overlay=x='W*${o.x.toFixed(4)}':y='H*${o.y.toFixed(4)}':enable='between(t,${o.startSec},${o.endSec})':eof_action=pass[vov${i}]`);
      videoOut = `[vov${i}]`;
      inputIndex++;
    }

    // Layer tracks (PiP, images, text, shapes) above the overlays, below the brand logo.
    if (timeline.layers.length) {
      const lr = await layerFilters({ timeline, width: dims.width, height: dims.height, dir, inputIndex, videoIn: videoOut === '[0:v]' ? '[0:v]' : videoOut, resolve });
      args.push(...lr.args);
      filters.push(...lr.filters);
      if (lr.filters.length) videoOut = lr.videoOut;
      inputIndex = lr.inputIndex;
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
