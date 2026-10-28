'use client';

import { createContext, memo, useContext, useEffect, useRef, useState } from 'react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import { AudioLines, Check, ChevronDown, ChevronUp, Clapperboard, Copy, Film, GitBranch, Loader2, Maximize2, MessageSquare, MessageSquareQuote, MoreHorizontal, Pause, PanelRight, Pencil, Play, Plus, Sparkles, Trash2, Video, Volume2, VolumeX } from 'lucide-react';
import { CAMERA_PRESETS, type DirectorScope } from '@framecraft/shared';
import { useAssistant } from '@/lib/assistant';
import { scopeLabel, type ShotState } from '@/lib/director';
import type { StudioShot } from '@/lib/studio';
import { cn, seconds } from '@/lib/utils';
import { DirectorPanel, type DirectorDeps } from '../director-chat';
import type { AiActionKey } from './actions';

/*
 * Story graph nodes. They only draw; everything they do goes through the graph's context, so the
 * nodes never rebuild because the page re-rendered.
 */

export type AskTarget = { key: string; scope: DirectorScope; action?: AiActionKey; flow?: { x: number; y: number }; title?: string } | null;

export type GraphApi = {
  deps: DirectorDeps;
  ask: AskTarget;
  setAsk: (a: AskTarget) => void;
  playing: string | null;
  setPlaying: (key: string | null) => void;
  editing: string | null;
  setEditing: (shotId: string | null) => void;
  highlight: string | null;
  credits: Map<string, number>;
  openShot: (clipId: string) => void;
  playFrom: (clipId: string) => void;
  toggleVersions: (key: string) => void;
  saveShot: (shotId: string, patch: Record<string, unknown>) => Promise<void>;
  /** Your own clip becomes a shot (free), so the AI Director can work on it. */
  askClip: (clipId: string) => void;
  askEdgeFromClip: (clipId: string, toShotId: string | null, edgeId: string, flow: { x: number; y: number }, title?: string) => void;
  takeOut: (key: string) => void;
  duplicate: (shotId: string) => void;
  openDirector: () => void;
  dockDirector?: () => void;
  directorCollapsed: boolean;
  setDirectorCollapsed: (v: boolean) => void;
  onGenerateMissing: () => void;
  onPlayMovie: () => void;
};
export const GraphCtx = createContext<GraphApi | null>(null);
const useGraph = () => useContext(GraphCtx)!;

export type ShotNodeData = {
  kind: 'shot';
  key: string;
  shotId?: string;
  clipId?: string;
  /** Number in the movie (1-based) or null for planned shots / shots outside the movie. */
  movieNo: number | null;
  /** "2 · 3": scene 2, shot 3 (script position). */
  place: string | null;
  title: string;
  thumb: string | null;
  videoUrl: string | null;
  durationSec: number;
  camera: string | null;
  cast: { id: string; name: string; imageUrl: string | null }[];
  lines: number;
  sfx: boolean;
  versionLabel: string | null;
  versions: number;
  comments: number;
  state: ShotState;
  inMovie: boolean;
  planned: boolean;
  selected: boolean;
  expanded: boolean;
  dimmed: boolean;
  shot?: StudioShot;
};

function Avatar({ c, size = 18 }: { c: { name: string; imageUrl: string | null }; size?: number }) {
  return c.imageUrl ? (
    <img src={c.imageUrl} alt={c.name} title={c.name} className="rounded-full border border-ink-900 object-cover" style={{ width: size, height: size }} />
  ) : (
    <span title={c.name} className="grid place-items-center rounded-full border border-ink-900 bg-iris-500/70 text-[9px] font-semibold text-white" style={{ width: size, height: size }}>{c.name.slice(0, 1).toUpperCase()}</span>
  );
}

function InlineTitle({ d }: { d: ShotNodeData }) {
  const g = useGraph();
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(d.title);
  useEffect(() => setText(d.title), [d.title]);
  if (!edit || !d.shotId) {
    return (
      <p
        className={cn('line-clamp-2 min-h-[2.4em] text-[12px] font-medium leading-snug text-white', d.shotId && 'cursor-text rounded hover:bg-white/[0.04]')}
        title={d.shotId ? 'Click to edit what happens in this shot' : undefined}
        onClick={(e) => {
          if (!d.shotId) return;
          e.stopPropagation();
          setEdit(true);
        }}
      >
        {d.title}
      </p>
    );
  }
  const save = async () => {
    setEdit(false);
    const v = text.trim();
    if (v && v !== d.title) await g.saveShot(d.shotId!, { description: v.slice(0, 500) });
  };
  return (
    <textarea
      autoFocus
      value={text}
      rows={3}
      aria-label="What happens in this shot"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void save();
        }
        if (e.key === 'Escape') {
          setText(d.title);
          setEdit(false);
        }
      }}
      className="nodrag nowheel w-full resize-none rounded-md border border-iris-400/60 bg-black/40 px-1.5 py-1 text-[12px] leading-snug text-white focus:outline-none"
    />
  );
}

function MoreMenu({ d, onClose }: { d: ShotNodeData; onClose: () => void }) {
  const g = useGraph();
  const item = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] text-fog-200 hover:bg-white/[0.07] hover:text-white';
  return (
    <div className="nodrag absolute right-1 top-full z-50 mt-1 w-48 rounded-xl border hairline bg-ink-900/98 p-1 shadow-2xl" onPointerDown={(e) => e.stopPropagation()}>
      {d.shotId && (
        <button type="button" className={item} onClick={() => (g.setEditing(d.shotId!), onClose())}><Pencil className="size-3.5" /> Shot details</button>
      )}
      {d.shotId && (
        <button type="button" className={item} onClick={() => (g.duplicate(d.shotId!), onClose())}><Copy className="size-3.5" /> Duplicate as a new shot</button>
      )}
      {d.shotId && d.shot && d.shot.versions.length > 0 && (
        <button type="button" className={item} onClick={() => (void g.saveShot(d.shotId!, { approved: !d.shot!.approved }), onClose())}><Check className="size-3.5" /> {d.shot.approved ? 'Unmark approved' : 'Mark approved'}</button>
      )}
      {d.clipId && (
        <button type="button" className={item} onClick={() => (g.openShot(d.clipId!), onClose())}><Film className="size-3.5" /> Open in the shot editor</button>
      )}
      {(d.inMovie || d.planned) && (
        <button type="button" className={cn(item, 'hover:text-signal-red')} onClick={() => (g.takeOut(d.key), onClose())}><Trash2 className="size-3.5" /> {d.planned ? 'Delete this planned shot' : 'Take out of the movie'}</button>
      )}
    </div>
  );
}

export const ShotNode = memo(function ShotNode({ data: d }: NodeProps<Node<ShotNodeData>>) {
  const g = useGraph();
  const [more, setMore] = useState(false);
  const [muted, setMuted] = useState(true);
  const [hover, setHover] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playing = g.playing === d.key;
  const preview = !playing && hover && Boolean(d.videoUrl);
  const credits = d.shotId ? g.credits.get(d.shotId) : undefined;
  const busy = ['queued', 'generating', 'editing'].includes(d.state.key);
  const asking = g.ask?.key === d.key;
  return (
    <div
      className={cn(
        'group w-[248px] rounded-2xl border bg-ink-900 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.8)] transition-[border-color,box-shadow,opacity] duration-200',
        d.selected || asking ? 'border-iris-400 ring-2 ring-iris-500/35' : 'border-white/10 hover:border-white/25',
        d.planned && !d.selected && !asking && 'border-dashed border-white/20',
        !d.inMovie && !d.planned && 'opacity-70',
        d.dimmed && 'opacity-30',
      )}
      onMouseEnter={() => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => setHover(true), 450);
      }}
      onMouseLeave={() => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        setHover(false);
        setMore(false);
      }}
      data-testid="shot-card"
      data-shot={d.shotId ?? ''}
    >
      <Handle type="target" position={Position.Left} className="!size-3 !border-2 !border-ink-900 !bg-iris-400" />
      <div className="relative aspect-video overflow-hidden rounded-t-2xl bg-ink-800">
        {playing && d.videoUrl ? (
          <video src={d.videoUrl} autoPlay muted={muted} playsInline onEnded={() => g.setPlaying(null)} className="size-full object-cover" />
        ) : preview ? (
          <video src={d.videoUrl!} autoPlay muted loop playsInline preload="none" className="pointer-events-none size-full object-cover" />
        ) : d.thumb ? (
          <img src={d.thumb} alt="" loading="lazy" draggable={false} className="size-full object-cover" />
        ) : (
          <div className="grid size-full place-items-center bg-[radial-gradient(circle_at_30%_20%,rgba(139,124,246,0.25),transparent_60%)] text-fog-500">
            <span className="flex flex-col items-center gap-1 text-[10px]"><Clapperboard className="size-5" /> {d.planned ? 'Not generated yet' : 'No preview'}</span>
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white">
          {d.movieNo ? `SHOT ${String(d.movieNo).padStart(2, '0')}` : d.planned ? 'PLANNED' : 'NOT IN MOVIE'}
          {d.place && <span className="ml-1 font-normal text-fog-300">· {d.place}</span>}
        </span>
        <span className="absolute right-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] tabular-nums text-white" data-testid="shot-duration">{seconds(d.durationSec)}</span>
        <span className={cn('absolute bottom-2 left-2 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium', d.state.tone)} data-testid="shot-status">
          {busy && <Loader2 className="size-3 animate-spin" />}
          {d.state.label}
        </span>
        {d.cast.length > 0 && (
          <span className="absolute bottom-2 right-2 flex -space-x-1.5">
            {d.cast.slice(0, 3).map((c) => <Avatar key={c.id} c={c} />)}
            {d.cast.length > 3 && <span className="grid size-[18px] place-items-center rounded-full bg-black/70 text-[9px] text-white">+{d.cast.length - 3}</span>}
          </span>
        )}
        {playing && (
          <span className="nodrag absolute right-2 top-8 flex gap-1">
            <button type="button" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted((m) => !m)} className="grid size-6 place-items-center rounded-md bg-black/70 text-white">{muted ? <VolumeX className="size-3" /> : <Volume2 className="size-3" />}</button>
            {d.clipId && <button type="button" aria-label="Open large" onClick={() => g.openShot(d.clipId!)} className="grid size-6 place-items-center rounded-md bg-black/70 text-white"><Maximize2 className="size-3" /></button>}
          </span>
        )}
      </div>
      <div className="space-y-2 p-2.5">
        <InlineTitle d={d} />
        <div className="flex flex-wrap items-center gap-1 text-[10px] text-fog-300">
          {d.camera && <span className="flex items-center gap-0.5 rounded bg-white/[0.06] px-1.5 py-0.5"><Video className="size-3" />{CAMERA_PRESETS.find((c) => c.key === d.camera)?.label ?? d.camera.replaceAll('_', ' ')}</span>}
          {d.lines > 0 && <span className="flex items-center gap-0.5 rounded bg-white/[0.06] px-1.5 py-0.5" title="Dialogue"><MessageSquareQuote className="size-3" />{d.lines}</span>}
          {d.sfx && <span className="rounded bg-white/[0.06] px-1.5 py-0.5" title="Sound effects"><AudioLines className="size-3" /></span>}
          {d.comments > 0 && <span className="flex items-center gap-0.5 rounded bg-white/[0.06] px-1.5 py-0.5" title="Open notes"><MessageSquare className="size-3" />{d.comments}</span>}
          {d.versionLabel && <span className="rounded bg-white/[0.06] px-1.5 py-0.5">{d.versionLabel}</span>}
          {d.planned && credits !== undefined && <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-200" title="Estimated credits to generate this shot">≈ {credits} cr</span>}
        </div>
        <div className="nodrag relative flex items-center gap-1">
          {!d.shotId && d.clipId && d.inMovie && (
            <button type="button" onClick={() => g.askClip(d.clipId!)} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-iris-500/20 py-1.5 text-[11px] font-medium text-iris-100 transition hover:bg-iris-500/35">
              <Sparkles className="size-3" /> Ask AI
            </button>
          )}
          {d.shotId && (
            <button type="button" onClick={() => g.setAsk(asking ? null : { key: d.key, scope: { kind: 'shot', shotId: d.shotId! } })} className={cn('flex flex-1 items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-medium transition', asking ? 'bg-iris-500 text-white' : 'bg-iris-500/20 text-iris-100 hover:bg-iris-500/35')}>
              <Sparkles className="size-3" /> Ask AI
            </button>
          )}
          {d.videoUrl ? (
            <button type="button" onClick={() => g.setPlaying(playing ? null : d.key)} aria-label={playing ? 'Pause' : 'Play this shot'} title="Play here" className="grid h-7 w-8 place-items-center rounded-lg bg-white/[0.07] text-fog-100 hover:bg-white/[0.12]">{playing ? <Pause className="size-3" /> : <Play className="size-3" />}</button>
          ) : d.shotId ? (
            <button type="button" onClick={() => g.setAsk({ key: d.key, scope: { kind: 'shot', shotId: d.shotId! }, action: 'generate' })} title="Generate this shot (price first)" className="flex h-7 items-center gap-1 rounded-lg bg-white/[0.07] px-2 text-[11px] text-fog-100 hover:bg-white/[0.12]"><Film className="size-3" /> Generate</button>
          ) : null}
          <span className={cn('flex items-center gap-1 transition-opacity', d.selected || asking ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
            {d.shotId && (
              <button type="button" onClick={() => (d.clipId && d.inMovie ? g.openShot(d.clipId) : g.setEditing(d.shotId!))} aria-label="Edit" title={d.clipId && d.inMovie ? 'Open the shot editor' : 'Shot details'} className="grid h-7 w-7 place-items-center rounded-lg bg-white/[0.07] text-fog-200 hover:bg-white/[0.12]"><Pencil className="size-3" /></button>
            )}
            {d.versions > 1 && (
              <button type="button" onClick={() => g.toggleVersions(d.key)} aria-label="Versions" title="Versions" className={cn('flex h-7 items-center gap-0.5 rounded-lg px-1.5 text-[11px]', d.expanded ? 'bg-iris-500/30 text-white' : 'bg-white/[0.07] text-fog-200 hover:bg-white/[0.12]')}><GitBranch className="size-3" />{d.versions}</button>
            )}
            <button type="button" onClick={() => setMore((m) => !m)} aria-label="More" className="grid h-7 w-7 place-items-center rounded-lg bg-white/[0.07] text-fog-200 hover:bg-white/[0.12]"><MoreHorizontal className="size-3.5" /></button>
          </span>
          {more && <MoreMenu d={d} onClose={() => setMore(false)} />}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!size-3 !border-2 !border-ink-900 !bg-iris-400" />
    </div>
  );
});

export type SceneNodeData = { kind: 'scene'; sceneId: string; number: number; title: string; place: string | null; width: number; height: number; collapsed: boolean; count: number; durationSec: number; onToggle: () => void; onAddShot: () => void };

export const SceneNode = memo(function SceneNode({ id, data: d }: NodeProps<Node<SceneNodeData>>) {
  const g = useGraph();
  const asking = g.ask?.key === id;
  return (
    <div className={cn('rounded-[28px] border bg-white/[0.018]', asking ? 'border-iris-400/60' : 'border-white/[0.08]')} style={{ width: d.width, height: d.height }}>
      {d.collapsed && <Handle type="target" position={Position.Left} isConnectable={false} className="!bg-iris-400" />}
      {d.collapsed && <Handle type="source" position={Position.Right} isConnectable={false} className="!bg-iris-400" />}
      <div className="nodrag flex items-center gap-2 px-3 pt-2.5">
        <span className="rounded-md bg-iris-500/20 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-iris-100">SCENE {d.number}</span>
        <span className="min-w-0 truncate text-[13px] font-semibold text-white" title={d.title}>{d.title}</span>
        <span className="shrink-0 text-[10px] text-fog-400">{d.count} shot{d.count === 1 ? '' : 's'} · {seconds(d.durationSec)}{d.place ? ` · ${d.place}` : ''}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => g.setAsk(asking ? null : { key: id, scope: { kind: 'scene', sceneId: d.sceneId } })} className={cn('flex items-center gap-1 rounded-lg px-2 py-1 text-[11px]', asking ? 'bg-iris-500 text-white' : 'bg-iris-500/15 text-iris-100 hover:bg-iris-500/30')}><Sparkles className="size-3" /> Ask AI</button>
          {!d.collapsed && <button type="button" onClick={d.onAddShot} title="Add a shot at the end of this scene" className="flex items-center gap-0.5 rounded-lg bg-white/[0.06] px-1.5 py-1 text-[11px] text-fog-200 hover:bg-white/10"><Plus className="size-3" /> Shot</button>}
          <button type="button" onClick={d.onToggle} aria-label={d.collapsed ? 'Expand scene' : 'Collapse scene'} className="grid size-6 place-items-center rounded-lg bg-white/[0.06] text-fog-300 hover:text-white">{d.collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}</button>
        </span>
      </div>
    </div>
  );
});

export const StartNode = memo(function StartNode() {
  return (
    <div className="rounded-full border border-iris-400/50 bg-iris-500/15 px-3.5 py-2 text-[11px] font-semibold tracking-[0.14em] text-iris-100 shadow-lg">
      FILM START
      <Handle type="source" position={Position.Right} className="!size-3 !bg-iris-400" />
    </div>
  );
});

export type EndNodeData = { kind: 'end'; durationSec: number; shots: number; planned: number };
export const EndNode = memo(function EndNode({ data: d }: NodeProps<Node<EndNodeData>>) {
  const g = useGraph();
  return (
    <div className="w-[200px] rounded-2xl border border-signal-green/40 bg-ink-900 p-3 shadow-xl">
      <Handle type="target" position={Position.Left} isConnectable={false} className="!size-3 !bg-signal-green" />
      <div className="text-[10px] font-semibold tracking-[0.14em] text-signal-green">FINAL MOVIE</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-white">{seconds(d.durationSec)}</div>
      <div className="text-[11px] text-fog-400">{d.shots} shot{d.shots === 1 ? '' : 's'} in the movie{d.planned ? ` · ${d.planned} planned` : ''}</div>
      <div className="nodrag mt-2 flex flex-col gap-1">
        {d.shots > 0 && <button type="button" onClick={g.onPlayMovie} className="flex items-center justify-center gap-1 rounded-lg bg-white/[0.08] py-1.5 text-[11px] text-white hover:bg-white/[0.14]"><Play className="size-3" /> Play the movie</button>}
        {d.planned > 0 && <button type="button" onClick={g.onGenerateMissing} className="flex items-center justify-center gap-1 rounded-lg bg-iris-500 py-1.5 text-[11px] font-medium text-white hover:bg-iris-400"><Film className="size-3" /> Generate {d.planned} planned</button>}
      </div>
    </div>
  );
});

type VersionNodeData = { kind: 'version'; label: string; number: number; thumb: string | null; active: boolean; source: string; onUse: () => void; onCompare: () => void };
export const VersionNode = memo(function VersionNode({ data }: NodeProps<Node<VersionNodeData>>) {
  return (
    <div className={cn('w-[160px] overflow-hidden rounded-xl border bg-ink-900 text-[10px] shadow-lg', data.active ? 'border-signal-green/70 ring-1 ring-signal-green/40' : 'border-white/10')}>
      <Handle type="target" position={Position.Top} isConnectable={false} className="!bg-white/30" />
      <div className="relative aspect-video bg-ink-800">
        {data.thumb && <img src={data.thumb} alt="" loading="lazy" className="size-full object-cover" draggable={false} />}
        <span className="absolute left-1 top-1 rounded bg-black/70 px-1 font-semibold text-white">V{data.number}</span>
        {data.active && <span className="absolute right-1 top-1 rounded bg-signal-green px-1 font-semibold text-black">IN MOVIE</span>}
      </div>
      <div className="p-1.5">
        <div className="truncate text-fog-100" title={data.label}>{data.label || data.source}</div>
        <div className="nodrag mt-1 flex gap-1">
          {!data.active && <button type="button" onClick={data.onUse} className="flex-1 rounded bg-signal-green/20 py-0.5 text-signal-green hover:bg-signal-green/30">Use</button>}
          <button type="button" onClick={data.onCompare} className="flex-1 rounded bg-white/[0.06] py-0.5 text-fog-200 hover:bg-white/10">Compare</button>
        </div>
      </div>
    </div>
  );
});
export type { VersionNodeData };

export type DirectorNodeData = { kind: 'director' };

/** The AI Director on the canvas: the whole conversation, aware of what is selected. */
export const DirectorNode = memo(function DirectorNode({ selected }: NodeProps<Node<DirectorNodeData>>) {
  const g = useGraph();
  const { deps } = g;
  const msgs = useAssistant((s) => s.threads[deps.projectId]?.msgs);
  const busy = useAssistant((s) => Boolean(s.busy[deps.projectId]));
  const scope = useAssistant((s) => s.threads[deps.projectId]?.scope) ?? { kind: 'project' as const };
  const last = msgs?.at(-1);
  const avatar = (
    <span className="relative grid size-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-iris-400 to-fuchsia-500 text-white">
      <Clapperboard className="size-4" />
      {busy && <span className="absolute -right-0.5 -top-0.5 size-2.5 animate-pulse rounded-full bg-amber-300" />}
    </span>
  );
  if (g.directorCollapsed) {
    return (
      <div className="w-[300px] rounded-2xl border border-iris-400/50 bg-ink-900 shadow-2xl" data-testid="director-node">
        <div className="director-drag flex cursor-grab items-center gap-2 p-2.5 active:cursor-grabbing">
          {avatar}
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-white">AI Director</div>
            <div className="truncate text-[10px] text-fog-400">{busy ? 'Planning…' : last ? last.text.slice(0, 80) : `On: ${scopeLabel(deps.studio, scope)}`}</div>
          </div>
          <button type="button" aria-label="Expand the AI Director" onClick={() => g.setDirectorCollapsed(false)} className="nodrag grid size-7 place-items-center rounded-lg bg-white/[0.06] text-fog-200 hover:text-white"><ChevronDown className="size-4" /></button>
        </div>
      </div>
    );
  }
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={320} minHeight={300} maxWidth={720} maxHeight={900} lineClassName="!border-iris-400/50" handleClassName="!size-2.5 !rounded-full !border-iris-400 !bg-ink-900" />
      <div className="size-full rounded-2xl border border-iris-400/50 bg-ink-900/98 shadow-[0_20px_60px_-20px_rgba(124,92,255,0.45)]" data-testid="director-node">
        <DirectorPanel
          deps={deps}
          resizable
          header={
            <div className="director-drag flex cursor-grab items-center gap-2 border-b hairline p-2.5 active:cursor-grabbing">
              {avatar}
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-white">AI Director</div>
                <div className="text-[10px] text-fog-400">Knows your story, cast, scenes and shots</div>
              </div>
              {g.dockDirector && <button type="button" aria-label="Dock beside the canvas" title="Dock beside the canvas" onClick={g.dockDirector} className="nodrag grid size-7 place-items-center rounded-lg text-fog-300 hover:bg-white/[0.06] hover:text-white"><PanelRight className="size-4" /></button>}
              <button type="button" aria-label="Collapse the AI Director" title="Collapse" onClick={() => g.setDirectorCollapsed(true)} className="nodrag grid size-7 place-items-center rounded-lg text-fog-300 hover:bg-white/[0.06] hover:text-white"><ChevronUp className="size-4" /></button>
            </div>
          }
        />
      </div>
    </>
  );
});
