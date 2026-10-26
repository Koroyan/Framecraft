import { colorName, LOOKS, type PlanOp, type Timeline } from '@framecraft/shared';
import { seconds } from '@/lib/utils';

const adjustWords = (a: Record<string, unknown>) =>
  Object.entries(a)
    .filter(([, v]) => typeof v === 'number' && v !== 0)
    .map(([k, v]) => `${k} ${(v as number) > 0 ? '+' : ''}${Math.round((v as number) * (k === 'hue' ? 1 : 100))}${k === 'hue' ? '°' : ''}`)
    .join(', ');

/** One line, plain words: what this operation will change. */
export function describeOp(op: PlanOp, t?: Timeline | null): string {
  const clipNo = (id: string) => {
    const i = t?.clips.findIndex((c) => c.id === id) ?? -1;
    return i >= 0 ? `clip ${i + 1}` : 'the clip';
  };
  const clips = (ids: string[]) => (ids.length ? ids.map(clipNo).join(', ') : 'every clip');
  const objName = (clipId: string, objectId: string) => t?.clips.find((c) => c.id === clipId)?.objects?.find((o) => o.id === objectId)?.name ?? 'the selected object';
  switch (op.op) {
    case 'trim': return `Trim shot ${op.shot}${op.durationSec ? ` to ${op.durationSec} s` : ''}`;
    case 'speed': return `Shot ${op.shot} at ${op.speed}× speed`;
    case 'transition': return `${op.type} from shot ${op.shot} into the next (${op.durationSec} s)`;
    case 'color': return `Colour of shot ${op.shot}: ${adjustWords(op.adjust)}`;
    case 'match_color': return `Match shot ${op.shot}’s colour to shot ${op.fromShot}`;
    case 'camera': return `Camera on shot ${op.shot}: ${op.preset.replaceAll('_', ' ')}`;
    case 'fade': return `Fade shot ${op.shot} (in ${op.inSec} s, out ${op.outSec} s)`;
    case 'move': return `Move shot ${op.shot} ${op.afterShot ? `after shot ${op.afterShot}` : 'to the start'}`;
    case 'remove': return `Take shot ${op.shot} out of the movie`;
    case 'text': return `Title “${op.text}” at ${seconds(op.startSec)}`;
    case 'color_all': return `Colour of every shot: ${adjustWords(op.adjust)}`;
    case 'logo': return `Logo ${op.position.replace('-', ' ')}${op.lastSec ? ` for the last ${op.lastSec} s` : ''}`;
    case 'duck_music': return 'Music ducks under the voice-over';
    case 'animated_captions': return `Animated captions (${op.style})`;
    case 'ai_edit': return `AI ${op.mode.replaceAll('_', ' ')} on shot ${op.shot}${op.startSec != null ? ` (${seconds(op.startSec)}–${seconds(op.endSec ?? op.startSec)})` : ''}: ${op.instruction}`;
    case 'volume': return op.factor === 0 ? `Mute the ${op.target === 'all' ? 'sound' : op.target}` : `${op.target === 'all' ? 'All sound' : op.target === 'clips' ? 'Clip sound' : op.target[0]!.toUpperCase() + op.target.slice(1)} ${op.factor < 1 ? `${Math.round((1 - op.factor) * 100)}% quieter` : `${Math.round((op.factor - 1) * 100)}% louder`}`;
    case 'look': return `Look “${LOOKS.find((l) => l.key === op.key)?.label ?? op.key}” on ${clips(op.clipIds)}`;
    case 'clip_adjust': return `${clips(op.clipIds)[0]!.toUpperCase()}${clips(op.clipIds).slice(1)}: ${adjustWords(op.delta)}`;
    case 'clip_speed': return `${op.factor > 1 ? 'Speed up' : 'Slow down'} ${clips(op.clipIds)} (×${op.factor})`;
    case 'object_adjust': return `${objName(op.clipId, op.objectId)} only: ${adjustWords(op.delta)}`;
    case 'object_recolor': return `${objName(op.clipId, op.objectId)} → ${colorName(op.to)}`;
    case 'object_blur': return `Blur ${objName(op.clipId, op.objectId)}`;
    case 'cut_range': return `Cut ${seconds(op.startSec)}–${seconds(op.endSec)} out and close the gap`;
    case 'transitions_all': return `${op.type} transition${op.clipIds.length ? ` after ${clips(op.clipIds)}` : ' between all clips'} (${op.durationSec} s)`;
    case 'edge_fade': return [op.inSec !== undefined ? `fade in ${op.inSec} s` : '', op.outSec !== undefined ? `fade out ${op.outSec} s` : ''].filter(Boolean).join(' and ').replace(/^./, (c) => c.toUpperCase());
    case 'title': return `Title “${op.text}” ${seconds(op.startSec)}–${seconds(op.endSec)}`;
    case 'mute_original': return op.muted ? 'Mute the original clip sound' : 'Unmute the original clip sound';
    case 'remove_clip': return `Remove ${clipNo(op.clipId)} (the file stays in Media)`;
  }
}

/** What the operation touches — shown so nothing changes by surprise. */
export function opScope(op: PlanOp): 'object' | 'clip' | 'movie' | 'audio' {
  if (op.op.startsWith('object_')) return 'object';
  if (op.op === 'volume' || op.op === 'duck_music' || op.op === 'mute_original') return 'audio';
  if ('clipIds' in op && op.clipIds.length) return 'clip';
  if ('shot' in op || op.op === 'remove_clip') return 'clip';
  return 'movie';
}
