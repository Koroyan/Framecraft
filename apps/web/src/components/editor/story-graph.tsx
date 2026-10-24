'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Clapperboard, GitBranch, LayoutGrid, MessageSquare, Pencil, Play, Sparkles, Video } from 'lucide-react';
import { toast } from 'sonner';
import { clipDuration, insertShot, moveNodeAfter, removeNode, sequenceOf, type Timeline } from '@framecraft/shared';
import type { Asset } from '@/lib/api';
import { activeVersion, type StudioData, type StudioShot } from '@/lib/studio';
import { newId } from '@/lib/editor-store';
import { cn, seconds } from '@/lib/utils';

/*
 * Story graph: the movie as connected shot nodes. Edges are the real playback order (the same
 * timeline the editor renders); version nodes branch off a shot and the active one is what plays.
 * Connecting A → B moves B right after A; deleting an edge (or a node) takes that shot out of the
 * movie (it stays in the project, ready to be connected again). All structure edits are undoable.
 */

type ShotNodeData = {
  kind: 'shot';
  number: number;
  title: string;
  thumb: string | null;
  durationSec: number;
  versionLabel: string | null;
  versions: number;
  comments: number;
  processing: boolean;
  review: boolean;
  camera: string | null;
  source: string | null;
  inMovie: boolean;
  selected: boolean;
  shotId?: string;
  onOpen: () => void;
  onPlay: () => void;
  onToggleVersions: () => void;
  expanded: boolean;
};
type VersionNodeData = { kind: 'version'; label: string; number: number; thumb: string | null; active: boolean; source: string; onUse: () => void; onCompare: () => void };
type SceneNodeData = { kind: 'scene'; title: string; width: number; height: number; collapsed: boolean; count: number; onToggle: () => void };

const ShotNode = memo(function ShotNode({ data }: NodeProps<Node<ShotNodeData>>) {
  return (
    <div className={cn('w-[210px] overflow-hidden rounded-2xl border bg-ink-900/95 shadow-xl transition', data.selected ? 'border-iris-400 ring-2 ring-iris-500/40' : 'border-white/10 hover:border-white/25', !data.inMovie && 'border-dashed opacity-75')}>
      <Handle type="target" position={Position.Left} className="!size-3 !border-2 !border-ink-900 !bg-iris-400" />
      <div className="relative aspect-video bg-ink-800" onDoubleClick={data.onOpen}>
        {data.thumb ? <img src={data.thumb} alt="" className="size-full object-cover" draggable={false} /> : <div className="grid size-full place-items-center text-fog-500"><Video className="size-5" /></div>}
        <span className="absolute left-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">{data.inMovie ? `SHOT ${String(data.number).padStart(2, '0')}` : 'NOT IN MOVIE'}</span>
        <span className="absolute right-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] tabular-nums text-white">{seconds(data.durationSec)}</span>
        {data.processing && <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-iris-500/90 px-1.5 py-0.5 text-[10px] text-white"><Sparkles className="size-3 animate-pulse" /> AI editing</span>}
        {data.review && !data.processing && <span className="absolute bottom-1.5 left-1.5 rounded-md bg-signal-amber px-1.5 py-0.5 text-[10px] font-semibold text-black">Review edit</span>}
      </div>
      <div className="space-y-1.5 p-2.5">
        <div className="line-clamp-2 text-xs font-medium leading-snug text-white">{data.title}</div>
        <div className="flex flex-wrap items-center gap-1 text-[10px] text-fog-300">
          {data.versionLabel && <span className="rounded bg-white/[0.06] px-1.5 py-0.5">{data.versionLabel}</span>}
          {data.source && <span className="rounded bg-white/[0.06] px-1.5 py-0.5">{data.source}</span>}
          {data.camera && <span className="rounded bg-white/[0.06] px-1.5 py-0.5">🎥 {data.camera.replaceAll('_', ' ')}</span>}
          {data.comments > 0 && <span className="flex items-center gap-0.5 rounded bg-white/[0.06] px-1.5 py-0.5"><MessageSquare className="size-3" />{data.comments}</span>}
        </div>
        <div className="nodrag flex gap-1">
          <button type="button" onClick={data.onOpen} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-iris-500/20 py-1 text-[11px] text-iris-100 hover:bg-iris-500/35"><Pencil className="size-3" /> Edit</button>
          <button type="button" onClick={data.onPlay} aria-label="Play from this shot" className="grid w-7 place-items-center rounded-lg bg-white/[0.06] text-fog-200 hover:bg-white/10"><Play className="size-3" /></button>
          {data.versions > 1 && (
            <button type="button" onClick={data.onToggleVersions} aria-label="Show versions" className={cn('flex items-center gap-0.5 rounded-lg px-1.5 text-[11px]', data.expanded ? 'bg-iris-500/30 text-white' : 'bg-white/[0.06] text-fog-200 hover:bg-white/10')}>
              <GitBranch className="size-3" />{data.versions}
            </button>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!size-3 !border-2 !border-ink-900 !bg-iris-400" />
    </div>
  );
});

const VersionNode = memo(function VersionNode({ data }: NodeProps<Node<VersionNodeData>>) {
  return (
    <div className={cn('w-[150px] overflow-hidden rounded-xl border bg-ink-900/95 text-[10px]', data.active ? 'border-signal-green/70 ring-1 ring-signal-green/40' : 'border-white/10')}>
      <Handle type="target" position={Position.Top} isConnectable={false} className="!bg-white/30" />
      <div className="relative aspect-video bg-ink-800">
        {data.thumb && <img src={data.thumb} alt="" className="size-full object-cover" draggable={false} />}
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

const SceneNode = memo(function SceneNode({ data }: NodeProps<Node<SceneNodeData>>) {
  return (
    <div className="rounded-3xl border border-white/[0.07] bg-white/[0.02]" style={{ width: data.width, height: data.height }}>
      <button type="button" onClick={data.onToggle} className="nodrag m-2 flex items-center gap-1.5 rounded-lg bg-black/40 px-2 py-1 text-[11px] text-fog-200 hover:text-white">
        <Clapperboard className="size-3" /> {data.title} · {data.count} shot{data.count === 1 ? '' : 's'} {data.collapsed ? '▸ expand' : '▾'}
      </button>
    </div>
  );
});

const StartNode = memo(function StartNode() {
  return (
    <div className="rounded-full border border-iris-400/50 bg-iris-500/15 px-3 py-1.5 text-[11px] font-semibold tracking-wide text-iris-100">
      FILM START
      <Handle type="source" position={Position.Right} className="!size-3 !bg-iris-400" />
    </div>
  );
});

const nodeTypes = { shot: ShotNode, version: VersionNode, scene: SceneNode, start: StartNode };

const COLS = 5;
const autoPos = (i: number) => ({ x: 180 + (i % COLS) * 270, y: 40 + Math.floor(i / COLS) * 300 });

type Props = {
  projectId: string;
  timeline: Timeline;
  studio: StudioData | undefined;
  assets: Map<string, Asset>;
  selectedClipId: string | null;
  savedLayout?: { positions?: Record<string, { x: number; y: number }>; collapsed?: string[] };
  apply: (fn: (t: Timeline) => Timeline) => void;
  onSelectClip: (clipId: string) => void;
  onPlayFrom: (clipId: string) => void;
  onOpenShot: (clipId: string) => void;
  onUseVersion: (shotId: string, versionId: string) => void;
  onCompare: (shotId: string, versionId: string) => void;
  onSaveLayout: (layout: { positions: Record<string, { x: number; y: number }>; collapsed: string[] }) => void;
};

function Graph(props: Props) {
  const { fitView } = useReactFlow();
  // Callbacks via a ref: the page re-renders with every playhead tick, the graph must not rebuild then.
  const cb = useRef(props);
  cb.current = props;
  const p = cb.current;
  const seq = useMemo(() => sequenceOf(p.timeline), [p.timeline]);
  const shotById = useMemo(() => new Map((p.studio?.shots ?? []).map((s) => [s.id, s])), [p.studio]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(p.savedLayout?.positions ?? {});
  const [collapsed, setCollapsed] = useState<string[]>(p.savedLayout?.collapsed ?? []);
  const [expanded, setExpanded] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback(
    (pos: Record<string, { x: number; y: number }>, col: string[]) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => cb.current.onSaveLayout({ positions: pos, collapsed: col }), 800);
    },
    [],
  );

  const selectedNode = seq.find((n) => p.selectedClipId && n.clipIds.includes(p.selectedClipId))?.key;

  const built = useMemo(() => {
    const inMovie = new Set(seq.flatMap((n) => (n.shotId ? [n.shotId] : [])));
    const detached = (p.studio?.shots ?? []).filter((s) => !inMovie.has(s.id) && s.versions.length);
    const nodes: Node[] = [{ id: '__start', type: 'start', position: positions.__start ?? { x: 0, y: 110 }, data: {}, deletable: false }];
    const edges: Edge[] = [];
    const sceneOf = (key: string) => {
      const n = seq.find((x) => x.key === key);
      return n?.shotId ? shotById.get(n.shotId)?.sceneId : undefined;
    };
    const visibleId = (key: string) => {
      const sc = sceneOf(key);
      return sc && collapsed.includes(sc) ? `scene-c:${sc}` : key;
    };
    const shotNode = (key: string, i: number, shot: StudioShot | undefined, clipIds: string[], movie: boolean): Node => {
      const clips = p.timeline.clips.filter((c) => clipIds.includes(c.id));
      const first = clips[0];
      const av = shot ? activeVersion(shot) : null;
      const asset = first ? p.assets.get(first.assetId) : undefined;
      const openOps = shot?.operations ?? [];
      const data: ShotNodeData = {
        kind: 'shot',
        number: i + 1,
        title: shot?.description || first?.label || asset?.originalName || 'Clip',
        thumb: av?.media?.thumbnailUrl ?? asset?.thumbnailUrl ?? shot?.storyboardUrl ?? null,
        durationSec: clips.length ? clips.reduce((s, c) => s + clipDuration(c), 0) : (av?.media?.durationSec ?? shot?.durationSec ?? 0),
        versionLabel: av ? `V${av.number}${shot && shot.versions.length > 1 ? `/${shot.versions.length}` : ''}` : null,
        versions: shot?.versions.length ?? 0,
        comments: shot?.comments.filter((c) => c.author === 'user' && !['resolved', 'accepted'].includes(c.status)).length ?? 0,
        processing: openOps.some((o) => o.status === 'processing' || o.status === 'queued'),
        review: openOps.some((o) => o.status === 'ready'),
        camera: first?.camera?.preset ?? shot?.camera ?? null,
        source: av ? (av.source === 'ai_edit' ? 'AI edit' : av.media?.isFixture ? 'fixture' : 'generated') : first ? 'upload' : null,
        inMovie: movie,
        selected: movie && key === selectedNode,
        shotId: shot?.id,
        expanded: expanded === key,
        onOpen: () => first && cb.current.onOpenShot(first.id),
        onPlay: () => first && cb.current.onPlayFrom(first.id),
        onToggleVersions: () => setExpanded((e) => (e === key ? null : key)),
      };
      return { id: key, type: 'shot', position: positions[key] ?? autoPos(i), data, deletable: movie };
    };

    seq.forEach((n, i) => {
      const shot = n.shotId ? shotById.get(n.shotId) : undefined;
      const node = shotNode(n.key, i, shot, n.clipIds, true);
      const sc = shot?.sceneId;
      if (sc && collapsed.includes(sc)) node.hidden = true;
      nodes.push(node);
      // Branches: every version of the shot hangs below it; the active one is in the movie.
      if (shot && expanded === n.key && !node.hidden) {
        shot.versions.forEach((v, j) => {
          const id = `ver:${v.id}`;
          nodes.push({
            id,
            type: 'version',
            deletable: false,
            position: positions[id] ?? { x: node.position.x + (j - (shot.versions.length - 1) / 2) * 165 + 30, y: node.position.y + 260 },
            data: { kind: 'version', label: v.label, number: v.number, thumb: v.media?.thumbnailUrl ?? null, active: v.id === shot.activeVersionId, source: v.source, onUse: () => cb.current.onUseVersion(shot.id, v.id), onCompare: () => cb.current.onCompare(shot.id, v.id) } satisfies VersionNodeData,
          });
          edges.push({ id: `br:${n.key}:${v.id}`, source: n.key, target: id, type: 'smoothstep', deletable: false, style: { strokeDasharray: '5 5', stroke: v.id === shot.activeVersionId ? '#34d399' : 'rgba(255,255,255,0.25)' } });
        });
      }
    });
    detached.forEach((s, j) => nodes.push(shotNode(`detached:${s.id}`, seq.length + j, s, [], false)));

    // Playback order: FILM START → shot 1 → shot 2 … (collapsed scenes act as one node).
    const order = ['__start', ...seq.map((n) => visibleId(n.key))].filter((id, i, all) => i === 0 || id !== all[i - 1]);
    for (let i = 0; i < order.length - 1; i++) {
      edges.push({ id: `seq:${order[i]}->${order[i + 1]}`, source: order[i]!, target: order[i + 1]!, type: 'default', animated: true, deletable: !order[i + 1]!.startsWith('scene-c:'), markerEnd: { type: MarkerType.ArrowClosed, color: '#8b7cf6' }, style: { stroke: '#8b7cf6', strokeWidth: 2 } });
    }

    // Scene groups: a soft frame behind each scene's shots; collapsed scenes become one node.
    for (const sc of p.studio?.scenes ?? []) {
      const members = nodes.filter((nd) => nd.type === 'shot' && (nd.data as ShotNodeData).inMovie && (nd.data as ShotNodeData).shotId && shotById.get((nd.data as ShotNodeData).shotId!)?.sceneId === sc.id);
      if (!members.length) continue;
      const toggle = () =>
        setCollapsed((c) => {
          const next = c.includes(sc.id) ? c.filter((x) => x !== sc.id) : [...c, sc.id];
          persist(positions, next);
          return next;
        });
      if (collapsed.includes(sc.id)) {
        nodes.push({ id: `scene-c:${sc.id}`, type: 'scene', deletable: false, position: members[0]!.position, data: { kind: 'scene', title: sc.title || `Scene ${sc.index + 1}`, width: 230, height: 56, collapsed: true, count: members.length, onToggle: toggle } satisfies SceneNodeData });
        continue;
      }
      const xs = members.map((m) => m.position.x);
      const ys = members.map((m) => m.position.y);
      const x0 = Math.min(...xs) - 24;
      const y0 = Math.min(...ys) - 52;
      nodes.unshift({ id: `scene:${sc.id}`, type: 'scene', deletable: false, selectable: false, draggable: false, zIndex: -1, position: { x: x0, y: y0 }, data: { kind: 'scene', title: sc.title || `Scene ${sc.index + 1}`, width: Math.max(...xs) - x0 + 234, height: Math.max(...ys) - y0 + 250, collapsed: false, count: members.length, onToggle: toggle } satisfies SceneNodeData });
    }
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, shotById, positions, collapsed, expanded, selectedNode, props.timeline, props.assets, props.studio, persist]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(built.nodes);
  useEffect(() => setNodes(built.nodes), [built.nodes, setNodes]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const after = c.source === '__start' ? null : c.source;
      if (c.target.startsWith('detached:')) {
        const shot = shotById.get(c.target.slice('detached:'.length));
        const v = shot && activeVersion(shot);
        if (!shot || !v) return;
        cb.current.apply((t) => insertShot(t, { shotId: shot.id, assetId: v.assetId, versionId: v.id, durationSec: v.media?.durationSec ?? shot.durationSec, label: shot.description.slice(0, 120) }, after, newId('clip')));
        toast.success(`Shot added to the movie`);
        return;
      }
      cb.current.apply((t) => moveNodeAfter(t, c.target!, after));
    },
    [shotById],
  );

  const isValidConnection = useCallback((c: Connection | Edge) => {
    const bad = (id?: string | null) => !id || id.startsWith('ver:') || id.startsWith('scene') ;
    return c.source !== c.target && !bad(c.source) && !bad(c.target) && c.target !== '__start' && !c.source!.startsWith('detached:');
  }, []);

  const removeFromMovie = useCallback(
    (keys: string[]) => {
      const real = keys.filter((k) => seq.some((n) => n.key === k));
      if (!real.length) return;
      cb.current.apply((t) => real.reduce((acc, k) => removeNode(acc, k), t));
      toast.message(`${real.length === 1 ? 'Shot' : `${real.length} shots`} taken out of the movie — still in the project. Connect it again or press Ctrl+Z.`);
    },
    [seq],
  );

  return (
    <div className="relative h-full min-h-[420px] w-full overflow-hidden rounded-2xl border hairline bg-ink-950">
      <ReactFlow
        nodes={nodes}
        edges={built.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onEdgesDelete={(es) => removeFromMovie(es.filter((e) => e.id.startsWith('seq:')).map((e) => e.target))}
        onNodesDelete={(ns) => removeFromMovie(ns.filter((n) => n.type === 'shot').map((n) => n.id))}
        onNodeClick={(_, n) => {
          if (n.type !== 'shot') return;
          const node = seq.find((x) => x.key === n.id);
          if (node) p.onSelectClip(node.clipIds[0]!);
        }}
        onNodeDoubleClick={(_, n) => {
          const node = seq.find((x) => x.key === n.id);
          if (node) p.onOpenShot(node.clipIds[0]!);
        }}
        onNodeDragStop={(_, __, dragged) => {
          setPositions((pos) => {
            const next = { ...pos };
            for (const d of dragged) if (d.type !== 'scene') next[d.id] = d.position;
            persist(next, collapsed);
            return next;
          });
        }}
        snapToGrid
        snapGrid={[10, 10]}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={2}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(255,255,255,0.08)" />
        {built.nodes.length > 5 && <MiniMap pannable zoomable className="!bg-ink-900" nodeColor={(n) => (n.type === 'shot' ? '#8b7cf6' : n.type === 'version' ? '#34d399' : 'rgba(255,255,255,0.08)')} maskColor="rgba(0,0,0,0.55)" />}
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="absolute left-3 top-3 flex gap-1.5">
        <button
          type="button"
          onClick={() => {
            setPositions({});
            persist({}, collapsed);
            setTimeout(() => void fitView({ padding: 0.2, duration: 300 }), 50);
          }}
          className="flex items-center gap-1 rounded-lg bg-black/60 px-2 py-1 text-[11px] text-fog-200 backdrop-blur hover:text-white"
        >
          <LayoutGrid className="size-3.5" /> Auto layout
        </button>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-lg bg-black/60 px-2.5 py-1 text-[10px] text-fog-300 backdrop-blur">
        Drag from a shot’s right port to another shot to put it next · select a line + Delete to take a shot out · double-click to edit
      </div>
    </div>
  );
}

export function StoryGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
