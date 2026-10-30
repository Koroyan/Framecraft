'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Clapperboard, LayoutGrid, Map as MapIcon, Users } from 'lucide-react';
import { toast } from 'sonner';
import { clipDuration, insertShot, moveNodeAfter, removeNode, type DirectorOp, type DirectorScope, type Timeline } from '@framecraft/shared';
import { api, ApiError, type Asset } from '@/lib/api';
import { useAssistant } from '@/lib/assistant';
import { rememberRemoved, scopeLabel, shotName, shotState, storyModel } from '@/lib/director';
import { newId } from '@/lib/editor-store';
import { activeVersion, type StudioData } from '@/lib/studio';
import { cn, seconds } from '@/lib/utils';
import { AskCard, type DirectorDeps } from './director-chat';
import { AI_ACTION_MIME, ActionCard, ActionPalette, type AiActionKey } from './graph/actions';
import { ShotDetailsCard } from './graph/details';
import { StoryEdge } from './graph/edge';
import { GenerateCard, usePlannedCredits } from './graph/generate';
import { DirectorNode, EndNode, GraphCtx, SceneNode, ShotNode, StartNode, VersionNode, type AskTarget, type GraphApi, type SceneNodeData, type ShotNodeData, type VersionNodeData } from './graph/nodes';

/*
 * Story graph: the film as a canvas. Shots (generated and planned) in the order the movie plays,
 * grouped by scene, with the AI Director on the canvas next to them. Every shot, scene and
 * connection can be asked about directly ("Ask AI", "+"), AI actions can be dropped onto shots,
 * and every change goes through the same plans — free steps apply at once, paid ones wait for an
 * approved price. Connections are the real playback order (the timeline), so graph and editor
 * never disagree; planned shots sit where the script puts them until they are generated.
 */

const nodeTypes = { shot: ShotNode, version: VersionNode, scene: SceneNode, start: StartNode, end: EndNode, director: DirectorNode };
const edgeTypes = { story: StoryEdge };

const CARD_W = 248;
const CARD_H = 268;
const GX = 44;
const GY = 56;
const TOP = 110;

type Props = {
  projectId: string;
  timeline: Timeline;
  studio: StudioData | undefined;
  assets: Map<string, Asset>;
  selectedClipId: string | null;
  savedLayout?: { positions?: Record<string, { x: number; y: number }>; collapsed?: string[] };
  apply: (fn: (t: Timeline) => Timeline) => void;
  refetch: () => unknown;
  onSelectClip: (clipId: string) => void;
  onPlayFrom: (clipId: string) => void;
  onOpenShot: (clipId: string) => void;
  onUseVersion: (shotId: string, versionId: string) => void;
  onCompare: (shotId: string, versionId: string) => void;
  onSaveLayout: (layout: { positions: Record<string, { x: number; y: number }>; collapsed: string[] }) => void;
  directorDocked?: boolean;
  onDockDirector?: () => void;
  /** Play the whole movie (the page shows its preview). */
  onPlayMovie?: () => void;
};

const readSize = () => {
  try {
    const v = JSON.parse(localStorage.getItem('fc-director-size') ?? 'null') as { width: number; height: number } | null;
    return v && v.width > 200 ? v : { width: 380, height: 460 };
  } catch {
    return { width: 380, height: 460 };
  }
};

function Graph(props: Props) {
  const rf = useReactFlow();
  const cb = useRef(props);
  cb.current = props;
  const p = props;
  const wrap = useRef<HTMLDivElement>(null);
  const model = useMemo(() => storyModel(p.studio, p.timeline), [p.studio, p.timeline]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(p.savedLayout?.positions ?? {});
  const [collapsed, setCollapsed] = useState<string[]>(p.savedLayout?.collapsed ?? []);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskTarget>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [castOpen, setCastOpen] = useState(false);
  const [minimap, setMinimap] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [directorCollapsed, setDirectorCollapsedRaw] = useState(false);
  const [size, setSize] = useState(readSize);
  useEffect(() => {
    try {
      setDirectorCollapsedRaw(localStorage.getItem('fc-director-collapsed') === '1');
    } catch {
      /* private mode */
    }
  }, []);
  const setDirectorCollapsed = useCallback((v: boolean) => {
    setDirectorCollapsedRaw(v);
    try {
      localStorage.setItem('fc-director-collapsed', v ? '1' : '0');
    } catch {
      /* private mode */
    }
  }, []);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback((pos: Record<string, { x: number; y: number }>, col: string[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => cb.current.onSaveLayout({ positions: pos, collapsed: col }), 800);
  }, []);

  const deps: DirectorDeps = useMemo(() => ({ projectId: p.projectId, studio: p.studio, timeline: p.timeline, apply: p.apply, refetch: p.refetch }), [p.projectId, p.studio, p.timeline, p.apply, p.refetch]);
  const isFilm = p.studio?.kind === 'movie' || p.studio?.kind === 'ad';
  const plannedCount = (p.studio?.shots ?? []).filter((s) => !s.versions.length).length;
  const prices = usePlannedCredits(deps, isFilm && plannedCount > 0);
  const credits = useMemo(() => new Map((prices.data?.shots ?? []).map((s) => [s.shotId, s.credits])), [prices.data]);

  const selectedFromClip = model.seq.find((n) => p.selectedClipId && n.clipIds.includes(p.selectedClipId))?.key ?? null;
  const selected = selectedKey ?? selectedFromClip;

  // ---------------------------------------------------------------- story edits
  const storyApply = useCallback(async (ops: DirectorOp[], okText?: string) => {
    const r = await api<{ created: Record<string, string>; undo: DirectorOp[]; leaveMovie: string[] }>(`/api/projects/${cb.current.projectId}/director/apply`, { body: { ops, scope: { kind: 'project' } } });
    await cb.current.refetch();
    if (okText) {
      toast.success(okText, r.undo.length ? { action: { label: 'Undo', onClick: () => void api(`/api/projects/${cb.current.projectId}/director/apply`, { body: { ops: r.undo, scope: { kind: 'project' } } }).then(() => cb.current.refetch()) } } : undefined);
    }
    return r;
  }, []);

  const saveShot = useCallback(
    async (shotId: string, patch: Record<string, unknown>) => {
      try {
        await storyApply([{ op: 'shot.update', shotId, patch } as DirectorOp], 'Saved');
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : 'Could not save it');
      }
    },
    [storyApply],
  );

  const removeFromMovie = useCallback(
    (keys: string[]) => {
      const real = keys.filter((k) => model.seq.some((n) => n.key === k));
      if (!real.length) return;
      const shotIds = real.flatMap((k) => model.seq.find((n) => n.key === k)?.shotId ?? []);
      cb.current.apply((t) => real.reduce((acc, k) => removeNode(acc, k), t));
      if (shotIds.length) void rememberRemoved(cb.current.projectId, cb.current.studio, shotIds).then(() => cb.current.refetch());
      toast.message(`${real.length === 1 ? 'Shot' : `${real.length} shots`} taken out of the movie — still in the project. Connect it again or press Ctrl+Z.`);
    },
    [model.seq],
  );

  const takeOut = useCallback(
    (key: string) => {
      if (key.startsWith('plan:')) {
        void storyApply([{ op: 'shot.remove', shotId: key.slice(5) }], 'Planned shot deleted').catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not delete it'));
        return;
      }
      removeFromMovie([key]);
    },
    [removeFromMovie, storyApply],
  );

  const duplicate = useCallback(
    (shotId: string) => {
      const s = cb.current.studio?.shots.find((x) => x.id === shotId);
      if (!s) return;
      void storyApply([{ op: 'shot.insert', ref: 'new1', sceneId: s.sceneId, afterShotId: s.id, shot: { description: s.description, prompt: s.prompt, durationSec: Math.min(30, Math.max(2, s.durationSec)), camera: (s.camera ?? undefined) as never, shotType: s.shotType ?? undefined, characterIds: s.characterIds, dialogue: s.dialogue } }], 'Copied as a new planned shot').catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not copy it'));
    },
    [storyApply],
  );

  const addShotToScene = useCallback(
    async (sceneId: string) => {
      const inScene = (cb.current.studio?.shots ?? []).filter((s) => s.sceneId === sceneId).sort((a, b) => a.index - b.index);
      try {
        const r = await storyApply([{ op: 'shot.insert', ref: 'new1', sceneId, afterShotId: inScene.at(-1)?.id ?? null, shot: { description: 'New shot — describe what happens', prompt: '', durationSec: 5, characterIds: inScene.at(-1)?.characterIds ?? [], dialogue: [] } }]);
        if (r.created.new1) setEditing(r.created.new1);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : 'Could not add a shot');
      }
    },
    [storyApply],
  );

  // ---------------------------------------------------------------- nodes
  const built = useMemo(() => {
    const studio = p.studio;
    const { order, seq, byId, movieNo } = model;
    const sceneNo = new Map((studio?.scenes ?? []).map((s, i) => [s.id, i + 1]));
    const castOf = (ids: string[]) => ids.flatMap((id) => studio?.characters.filter((c) => c.id === id).map((c) => ({ id: c.id, name: c.name, imageUrl: c.imageUrl })) ?? []);

    // Auto layout: scenes left to right, their shots in rows of three; your own clips in rows of five.
    const auto = new Map<string, { x: number; y: number }>();
    let x = 210;
    let maxY = TOP;
    let i = 0;
    while (i < order.length) {
      const sceneId = order[i]!.shotId ? byId.get(order[i]!.shotId!)?.sceneId : undefined;
      const group: string[] = [];
      while (i < order.length && (order[i]!.shotId ? byId.get(order[i]!.shotId!)?.sceneId : undefined) === sceneId) group.push(order[i++]!.key);
      const per = sceneId ? 3 : 5;
      group.forEach((k, j) => {
        const pos = { x: x + (j % per) * (CARD_W + GX), y: TOP + Math.floor(j / per) * (CARD_H + GY) };
        auto.set(k, pos);
        maxY = Math.max(maxY, pos.y);
      });
      x += Math.min(group.length, per) * (CARD_W + GX) + 80;
    }
    const pos = (k: string, fallback: { x: number; y: number }) => positions[k] ?? auto.get(k) ?? fallback;

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    nodes.push({ id: '__start', type: 'start', position: positions.__start ?? { x: 40, y: TOP + CARD_H / 2 - 20 }, data: {}, deletable: false });
    if (!p.directorDocked) {
      nodes.push({
        id: '__director',
        type: 'director',
        position: positions.__director ?? { x: -440, y: TOP - 40 },
        data: { kind: 'director' },
        dragHandle: '.director-drag',
        deletable: false,
        selectable: !directorCollapsed,
        ...(directorCollapsed ? {} : { style: { width: size.width, height: size.height } }),
        zIndex: 5,
      });
    }

    const shotData = (key: string, shotId: string | undefined, clipIds: string[], movie: boolean, planned: boolean): ShotNodeData => {
      const shot = shotId ? byId.get(shotId) : undefined;
      const clips = p.timeline.clips.filter((c) => clipIds.includes(c.id));
      const first = clips[0];
      const av = shot ? activeVersion(shot) : null;
      const asset = first ? p.assets.get(first.assetId) : undefined;
      const sc = shot ? sceneNo.get(shot.sceneId) : undefined;
      return {
        kind: 'shot',
        key,
        shotId,
        clipId: first?.id,
        movieNo: movie ? seq.findIndex((n) => n.key === key) + 1 || (shotId ? (movieNo.get(shotId) ?? null) : null) : null,
        place: sc && shot ? `${sc}.${shot.index + 1}` : null,
        title: shot?.description || first?.label || asset?.originalName || 'Clip',
        thumb: av?.media?.thumbnailUrl ?? asset?.thumbnailUrl ?? shot?.storyboardUrl ?? null,
        videoUrl: av?.media?.url ?? (asset?.mediaType === 'video' ? asset.url : null) ?? null,
        durationSec: clips.length ? clips.reduce((s, c) => s + clipDuration(c), 0) : (av?.media?.durationSec ?? shot?.durationSec ?? 0),
        camera: shot?.camera ?? first?.camera?.preset ?? null,
        cast: castOf(shot?.characterIds ?? []),
        lines: shot?.dialogue.length ?? 0,
        sfx: Boolean(shot?.sfx),
        versionLabel: av ? `V${av.number}${shot && shot.versions.length > 1 ? `/${shot.versions.length}` : ''}` : null,
        versions: shot?.versions.length ?? 0,
        comments: shot?.comments.filter((c) => c.author === 'user' && !['resolved', 'accepted'].includes(c.status)).length ?? 0,
        state: shotState(shot),
        inMovie: movie,
        planned,
        selected: key === selected,
        expanded: expanded === key,
        dimmed: Boolean(highlight && !(shot?.characterIds ?? []).includes(highlight)),
        shot,
      };
    };

    const visible = (key: string) => {
      const sid = order.find((e) => e.key === key)?.shotId;
      const sc = sid ? byId.get(sid)?.sceneId : undefined;
      return sc && collapsed.includes(sc) ? `scene-c:${sc}` : key;
    };

    order.forEach((e, idx) => {
      const node = seq.find((n) => n.key === e.key);
      const data = shotData(e.key, e.shotId, node?.clipIds ?? [], !e.planned, e.planned);
      const sc = e.shotId ? byId.get(e.shotId)?.sceneId : undefined;
      const n: Node = { id: e.key, type: 'shot', position: pos(e.key, { x: 210 + idx * (CARD_W + GX), y: TOP }), data, deletable: true };
      if (sc && collapsed.includes(sc)) n.hidden = true;
      nodes.push(n);
      const shot = e.shotId ? byId.get(e.shotId) : undefined;
      if (shot && expanded === e.key && !n.hidden) {
        shot.versions.forEach((v, j) => {
          const id = `ver:${v.id}`;
          nodes.push({
            id,
            type: 'version',
            deletable: false,
            position: positions[id] ?? { x: n.position.x + (j - (shot.versions.length - 1) / 2) * 172 + 44, y: n.position.y + CARD_H + 30 },
            data: { kind: 'version', label: v.label, number: v.number, thumb: v.media?.thumbnailUrl ?? null, active: v.id === shot.activeVersionId, source: v.source, onUse: () => cb.current.onUseVersion(shot.id, v.id), onCompare: () => cb.current.onCompare(shot.id, v.id) } satisfies VersionNodeData,
          });
          edges.push({ id: `br:${e.key}:${v.id}`, source: e.key, target: id, type: 'smoothstep', deletable: false, style: { strokeDasharray: '5 5', stroke: v.id === shot.activeVersionId ? '#34d399' : 'rgba(255,255,255,0.25)' } });
        });
      }
    });

    // Generated shots taken out of the movie: kept below, ready to be connected again.
    const detached = (studio?.shots ?? []).filter((s) => s.versions.length && !seq.some((n) => n.shotId === s.id));
    detached.forEach((s, j) => nodes.push({ id: `detached:${s.id}`, type: 'shot', position: positions[`detached:${s.id}`] ?? { x: 210 + j * (CARD_W + GX), y: maxY + CARD_H + 140 }, data: shotData(`detached:${s.id}`, s.id, [], false, false), deletable: false }));

    // The end of the film.
    const total = p.timeline.clips.reduce((s, c) => s + clipDuration(c), 0);
    const lastPos = order.length ? pos(order.at(-1)!.key, { x, y: TOP }) : { x: 210, y: TOP };
    nodes.push({ id: '__end', type: 'end', deletable: false, position: positions.__end ?? { x: Math.max(x, lastPos.x + CARD_W + GX + 40), y: TOP + CARD_H / 2 - 60 }, data: { kind: 'end', durationSec: total, shots: seq.length, planned: order.filter((e) => e.planned).length } });

    // Playback order: FILM START → shots (planned ones where the script puts them) → FINAL MOVIE.
    const chain = ['__start', ...order.map((e) => visible(e.key)), '__end'].filter((id, k, all) => k === 0 || id !== all[k - 1]);
    for (let k = 0; k < chain.length - 1; k++) {
      const a = chain[k]!;
      const b = chain[k + 1]!;
      const shotOf = (id: string) => (id.startsWith('__') || id.startsWith('scene-c:') ? null : (order.find((e) => e.key === id)?.shotId ?? null));
      const planned = a.startsWith('plan:') || b.startsWith('plan:');
      const nameOf = (id: string) => {
        if (id === '__start') return 'the start';
        if (id === '__end') return 'the end';
        if (id.startsWith('scene-c:')) return 'the collapsed scene';
        const sid = shotOf(id);
        const no = seq.findIndex((n) => n.key === id) + 1;
        return sid ? shotName(studio, sid) : no ? `clip ${no}` : 'this clip';
      };
      edges.push({
        id: `seq:${a}->${b}`,
        source: a,
        target: b,
        type: 'story',
        deletable: !planned && !b.startsWith('scene-c:') && b !== '__end',
        markerEnd: { type: MarkerType.ArrowClosed, color: planned ? 'rgba(167,155,250,0.7)' : '#7969f7' },
        data: { from: shotOf(a), to: shotOf(b), planned, title: `Between ${nameOf(a)} and ${nameOf(b)}`, fromClip: shotOf(a) ? null : (seq.find((n) => n.key === a)?.clipIds[0] ?? null) },
      });
    }

    // Scene frames behind their shots; a collapsed scene becomes one node.
    for (const sc of studio?.scenes ?? []) {
      const members = nodes.filter((nd) => nd.type === 'shot' && !(nd.data as ShotNodeData).key.startsWith('detached:') && (nd.data as ShotNodeData).shotId && byId.get((nd.data as ShotNodeData).shotId!)?.sceneId === sc.id);
      if (!members.length) continue;
      const toggle = () =>
        setCollapsed((c) => {
          const next = c.includes(sc.id) ? c.filter((y) => y !== sc.id) : [...c, sc.id];
          persist(positions, next);
          return next;
        });
      const sceneShots = (studio?.shots ?? []).filter((s) => s.sceneId === sc.id);
      const base = { kind: 'scene' as const, sceneId: sc.id, number: sceneNo.get(sc.id) ?? 0, title: sc.title || `Scene ${sc.index + 1}`, place: sc.place, count: members.length, durationSec: sceneShots.reduce((s, x) => s + x.durationSec, 0), onToggle: toggle, onAddShot: () => void addShotToScene(sc.id) };
      if (collapsed.includes(sc.id)) {
        nodes.push({ id: `scene-c:${sc.id}`, type: 'scene', deletable: false, position: members[0]!.position, data: { ...base, width: 360, height: 56, collapsed: true } satisfies SceneNodeData });
        continue;
      }
      const xs = members.map((m) => m.position.x);
      const ys = members.map((m) => m.position.y);
      const x0 = Math.min(...xs) - 26;
      const y0 = Math.min(...ys) - 58;
      nodes.unshift({ id: `scene:${sc.id}`, type: 'scene', deletable: false, selectable: false, draggable: false, zIndex: -1, position: { x: x0, y: y0 }, data: { ...base, width: Math.max(Math.max(...xs) - x0 + CARD_W + 26, 420), height: Math.max(...ys) - y0 + CARD_H + 26, collapsed: false } satisfies SceneNodeData });
    }
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, positions, collapsed, expanded, selected, highlight, props.timeline, props.assets, props.studio, persist, directorCollapsed, size, props.directorDocked, addShotToScene]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(built.nodes);
  useEffect(() => setNodes(built.nodes), [built.nodes, setNodes]);

  const onChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      onNodesChange(changes);
      for (const c of changes) {
        if (c.type === 'dimensions' && c.id === '__director' && c.resizing === false && c.dimensions) {
          const next = { width: Math.round(c.dimensions.width), height: Math.round(c.dimensions.height) };
          setSize(next);
          try {
            localStorage.setItem('fc-director-size', JSON.stringify(next));
          } catch {
            /* private mode */
          }
        }
      }
    },
    [onNodesChange],
  );

  // ---------------------------------------------------------------- connections
  const shotIdOf = (key: string) => (key.startsWith('plan:') ? key.slice(5) : key.startsWith('detached:') ? key.slice(9) : model.seq.find((n) => n.key === key)?.shotId);
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const after = c.source === '__start' ? null : c.source;
      const s = cb.current;
      if (c.target.startsWith('detached:')) {
        const shot = s.studio?.shots.find((x) => x.id === c.target!.slice(9));
        const v = shot && activeVersion(shot);
        if (!shot || !v) return;
        s.apply((t) => insertShot(t, { shotId: shot.id, assetId: v.assetId, versionId: v.id, durationSec: v.media?.durationSec ?? shot.durationSec, label: shot.description.slice(0, 120) }, after, newId('clip')));
        void rememberRemoved(s.projectId, s.studio, [shot.id], true).then(() => s.refetch());
        toast.success('Shot put back into the movie');
        return;
      }
      const target = shotIdOf(c.target);
      const from = c.source === '__start' ? null : shotIdOf(c.source);
      if (c.target.startsWith('plan:')) {
        // A planned shot moves in the script: it follows the shot it was connected from.
        const fromShot = from ? s.studio?.shots.find((x) => x.id === from) : undefined;
        const first = s.studio?.shots.slice().sort((a, b) => (model.sceneIndex.get(a.sceneId) ?? 0) - (model.sceneIndex.get(b.sceneId) ?? 0) || a.index - b.index)[0];
        const sceneId = fromShot?.sceneId ?? first?.sceneId;
        if (!target || !sceneId) return;
        void storyApply([{ op: 'shot.move', shotId: target, sceneId, afterShotId: fromShot?.id ?? null }], 'Planned shot moved').catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not move it'));
        return;
      }
      s.apply((t) => moveNodeAfter(t, c.target!, after));
      // The script follows the movie, so a re-assembled film keeps this order.
      const fromShot = from ? s.studio?.shots.find((x) => x.id === from) : undefined;
      if (target && fromShot) void storyApply([{ op: 'shot.move', shotId: target, sceneId: fromShot.sceneId, afterShotId: fromShot.id }]).catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, storyApply],
  );

  const isValidConnection = useCallback((c: Connection | Edge) => {
    const bad = (id?: string | null) => !id || id.startsWith('ver:') || id.startsWith('scene') || id === '__director' || id === '__end';
    if (bad(c.source) || bad(c.target) || c.source === c.target || c.target === '__start') return false;
    // A planned shot is not in the movie yet: nothing in the movie can follow it.
    if (c.source!.startsWith('plan:') && !c.target!.startsWith('plan:')) return false;
    return !c.source!.startsWith('detached:');
  }, []);

  // ---------------------------------------------------------------- AI actions dropped on shots
  const shotAt = (clientX: number, clientY: number) => {
    const pt = rf.screenToFlowPosition({ x: clientX, y: clientY });
    return rf.getIntersectingNodes({ x: pt.x, y: pt.y, width: 1, height: 1 }).find((n) => n.type === 'shot' && ((n.data as ShotNodeData).shotId || ((n.data as ShotNodeData).clipId && (n.data as ShotNodeData).inMovie)));
  };
  const openAction = (key: string, shotId: string, action: AiActionKey) => {
    setEditing(null);
    setAsk({ key, scope: { kind: 'shot', shotId }, action });
  };
  /** An action on a card: your own clip becomes a shot first (free). */
  const actionOn = (n: Node, action: AiActionKey) => {
    const d = n.data as ShotNodeData;
    setSelectedKey(n.id);
    if (d.shotId) return openAction(n.id, d.shotId, action);
    if (d.clipId)
      void clipToShot(d.clipId).then((sid) => {
        if (sid) {
          setSelectedKey(sid);
          openAction(sid, sid, action);
        }
      });
  };

  // ---------------------------------------------------------------- selection → the Director's subject
  const focus = useCallback((scope: DirectorScope) => {
    const s = cb.current;
    useAssistant.getState().setDirectorScope(s.projectId, scope, scopeLabel(s.studio, scope));
  }, []);
  useEffect(() => {
    if (ask) focus(ask.scope);
  }, [ask, focus]);

  // ---------------------------------------------------------------- overlay cards (screen space)
  const transform = useStore((s) => s.transform);
  const overlay = (() => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return null;
    const key = ask?.key ?? (editing ? (model.order.find((e) => e.shotId === editing)?.key ?? `detached:${editing}`) : generating ? '__end' : null);
    if (!key) return null;
    const [tx, ty, zoom] = transform;
    let sx: number;
    let sy: number;
    if (ask?.flow) {
      sx = ask.flow.x * zoom + tx;
      sy = ask.flow.y * zoom + ty + 20;
    } else {
      const n = rf.getInternalNode(key);
      if (!n) return null;
      const w = n.measured.width ?? CARD_W;
      const h = n.measured.height ?? CARD_H;
      sx = (n.internals.positionAbsolute.x + w / 2) * zoom + tx;
      sy = key.startsWith('scene') ? n.internals.positionAbsolute.y * zoom + ty + 46 : (n.internals.positionAbsolute.y + h) * zoom + ty + 10;
    }
    const W = 390;
    const left = Math.min(Math.max(8, sx - W / 2), box.width - W - 8);
    // Below what it belongs to when there is room; otherwise as low as it fits. It scrolls inside.
    const room = Math.min(440, box.height - 16);
    const top = Math.max(8, Math.min(sy, box.height - room - 8));
    return { left, top, maxHeight: box.height - top - 8 };
  })();

  /** Your own footage becomes a shot on demand (free): scene "Your footage", version V1 = the clip. */
  const clipToShot = async (clipId: string): Promise<string | null> => {
    const s = cb.current;
    const clip = s.timeline.clips.find((c) => c.id === clipId);
    if (!clip) return null;
    try {
      const r = await api<{ shotId: string; versionId: string }>(`/api/projects/${s.projectId}/shots/from-clip`, { body: { assetId: clip.assetId, label: clip.label } });
      s.apply((t) => ({ ...t, clips: t.clips.map((c) => (c.assetId === clip.assetId && !c.shotId ? { ...c, shotId: r.shotId, versionId: r.versionId } : c)) }));
      await s.refetch();
      return r.shotId;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not prepare this clip');
      return null;
    }
  };

  const api_: GraphApi = {
    deps,
    ask,
    setAsk: (a) => {
      setEditing(null);
      setGenerating(false);
      setAsk(a);
    },
    playing,
    setPlaying,
    editing,
    setEditing: (id) => {
      setAsk(null);
      setGenerating(false);
      setEditing(id);
    },
    highlight,
    credits,
    openShot: (cid) => cb.current.onOpenShot(cid),
    playFrom: (cid) => cb.current.onPlayFrom(cid),
    toggleVersions: (key) => setExpanded((e) => (e === key ? null : key)),
    saveShot,
    askClip: (clipId) =>
      void clipToShot(clipId).then((shotId) => {
        if (!shotId) return;
        setSelectedKey(shotId);
        setAsk({ key: shotId, scope: { kind: 'shot', shotId } });
      }),
    askEdgeFromClip: (clipId, toShotId, edgeId, flow, title) =>
      void clipToShot(clipId).then((shotId) => {
        if (shotId) setAsk({ key: edgeId, scope: { kind: 'edge', fromShotId: shotId, toShotId }, flow, title });
      }),
    takeOut,
    duplicate,
    openDirector: () => {
      setDirectorCollapsed(false);
      void rf.fitView({ nodes: [{ id: '__director' }], duration: 300, maxZoom: 1 });
    },
    dockDirector: p.onDockDirector,
    directorCollapsed,
    setDirectorCollapsed,
    onGenerateMissing: () => {
      setAsk(null);
      setEditing(null);
      setGenerating(true);
    },
    onPlayMovie: () => {
      if (cb.current.onPlayMovie) return cb.current.onPlayMovie();
      const first = cb.current.timeline.clips[0];
      if (first) cb.current.onPlayFrom(first.id);
    },
  };

  const cast = p.studio?.characters ?? [];
  const selectedShot = selected ? shotIdOf(selected) : undefined;

  return (
    <GraphCtx.Provider value={api_}>
      <div ref={wrap} className="relative h-full min-h-[420px] w-full overflow-hidden rounded-2xl border hairline bg-ink-950" data-testid="story-graph">
        <ReactFlow
          nodes={nodes}
          edges={built.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onEdgesDelete={(es) => removeFromMovie(es.filter((e) => e.id.startsWith('seq:') && !e.target.startsWith('plan:')).map((e) => e.target))}
          onNodesDelete={(ns) => ns.filter((n) => n.type === 'shot').forEach((n) => takeOut(n.id))}
          onNodeClick={(_, n) => {
            if (n.type !== 'shot') return;
            const d = n.data as ShotNodeData;
            setSelectedKey(n.id);
            if (d.shotId) focus({ kind: 'shot', shotId: d.shotId });
            if (d.clipId && d.inMovie) p.onSelectClip(d.clipId);
          }}
          onNodeDoubleClick={(_, n) => {
            if (n.type !== 'shot') return;
            const d = n.data as ShotNodeData;
            if (d.clipId && d.inMovie) p.onOpenShot(d.clipId);
            else if (d.shotId) api_.setEditing(d.shotId);
          }}
          onPaneClick={() => {
            setAsk(null);
            setEditing(null);
            setGenerating(false);
            setSelectedKey(null);
          }}
          onNodeDragStop={(_, __, dragged) => {
            setPositions((pos) => {
              const next = { ...pos };
              for (const d of dragged) if (d.type !== 'scene') next[d.id] = d.position;
              persist(next, collapsed);
              return next;
            });
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(AI_ACTION_MIME)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            const action = e.dataTransfer.getData(AI_ACTION_MIME) as AiActionKey;
            if (!action) return;
            e.preventDefault();
            const n = shotAt(e.clientX, e.clientY);
            if (!n) return void toast.message('Drop the action onto a shot card.');
            actionOn(n, action);
          }}
          snapToGrid
          snapGrid={[10, 10]}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 0.95 }}
          minZoom={0.1}
          maxZoom={2}
          onlyRenderVisibleElements
          deleteKeyCode={['Backspace', 'Delete']}
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="rgba(255,255,255,0.07)" />
          {minimap && <MiniMap pannable zoomable className="!bg-ink-900" nodeColor={(n) => (n.type === 'shot' ? '#7969f7' : n.type === 'director' ? '#e879f9' : n.type === 'version' ? '#34d399' : 'rgba(255,255,255,0.06)')} maskColor="rgba(0,0,0,0.55)" />}
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>

        {/* Toolbar */}
        <div className="pointer-events-none absolute left-3 right-3 top-3 flex items-start justify-between gap-2">
          <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
            {!p.directorDocked && (
              <button type="button" onClick={api_.openDirector} className="flex items-center gap-1 rounded-lg bg-iris-500 px-2.5 py-1 text-[11px] font-medium text-white shadow-glow hover:bg-iris-400">
                <Clapperboard className="size-3.5" /> Ask Director
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setPositions({});
                persist({}, collapsed);
                setTimeout(() => void rf.fitView({ padding: 0.12, duration: 300, maxZoom: 0.95 }), 60);
              }}
              className="flex items-center gap-1 rounded-lg bg-black/60 px-2 py-1 text-[11px] text-fog-200 backdrop-blur hover:text-white"
            >
              <LayoutGrid className="size-3.5" /> Auto layout
            </button>
            <button type="button" aria-pressed={minimap} onClick={() => setMinimap((m) => !m)} className={cn('flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] backdrop-blur', minimap ? 'bg-white/15 text-white' : 'bg-black/60 text-fog-200 hover:text-white')}><MapIcon className="size-3.5" /> Map</button>
            <span className="hidden rounded-lg bg-black/50 px-2 py-1 text-[11px] text-fog-300 backdrop-blur md:inline">
              Playback order · {model.seq.length} shot{model.seq.length === 1 ? '' : 's'} · {seconds(p.timeline.clips.reduce((s, c) => s + clipDuration(c), 0))}
              {model.order.length > model.seq.length ? ` · ${model.order.length - model.seq.length} planned` : ''} · synced with the storyboard
            </span>
            {cast.length > 0 && <button type="button" aria-pressed={castOpen} onClick={() => setCastOpen((c) => !c)} className={cn('flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] backdrop-blur', castOpen ? 'bg-white/15 text-white' : 'bg-black/60 text-fog-200 hover:text-white')}><Users className="size-3.5" /> Cast · {cast.length}</button>}
          </div>
          {castOpen && (
            <div className="pointer-events-auto max-h-[60%] w-60 overflow-y-auto rounded-2xl border hairline bg-ink-900/95 p-2 shadow-xl backdrop-blur" aria-label="Cast">
              <div className="mb-1 px-1 text-[10px] uppercase tracking-wide text-fog-500">Cast — click to see their shots</div>
              {cast.map((c) => {
                const n = (p.studio?.shots ?? []).filter((s) => s.characterIds.includes(c.id)).length;
                const on = highlight === c.id;
                return (
                  <button key={c.id} type="button" aria-pressed={on} onClick={() => setHighlight(on ? null : c.id)} className={cn('flex w-full items-center gap-2 rounded-xl px-1.5 py-1.5 text-left', on ? 'bg-iris-500/20' : 'hover:bg-white/[0.05]')}>
                    {c.imageUrl ? <img src={c.imageUrl} alt="" className="size-8 rounded-lg object-cover" /> : <span className="grid size-8 place-items-center rounded-lg bg-iris-500/40 text-xs font-semibold text-white">{c.name.slice(0, 1)}</span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-white">{c.name}</span>
                      <span className="block truncate text-[10px] text-fog-500">{n} shot{n === 1 ? '' : 's'}{c.imageUrl ? ' · approved look' : ' · no reference yet'}</span>
                    </span>
                  </button>
                );
              })}
              <a href="/app/characters" className="mt-1 block px-1.5 text-[11px] text-iris-200 hover:text-white">Character Bible →</a>
            </div>
          )}
        </div>

        <div className="pointer-events-none absolute bottom-3 left-3">
          <ActionPalette
            selectedShot={selected && rf.getNode(selected)?.type === 'shot' ? (selectedShot ?? selected) : null}
            onPick={(a) => {
              const n = selected ? rf.getNode(selected) : undefined;
              if (!n || n.type !== 'shot') return void toast.message('Select a shot first — or drag the action onto a shot.');
              actionOn(n, a);
            }}
          />
        </div>

        {/* Ask AI / action / details cards, beside what they belong to */}
        {overlay && (
          <div className="nowheel absolute z-40 overflow-y-auto rounded-2xl" style={{ left: overlay.left, top: overlay.top, maxHeight: overlay.maxHeight }}>
            {ask?.action ? (
              <ActionCard deps={deps} action={ask.action} shotId={(ask.scope as { shotId: string }).shotId} onClose={() => setAsk(null)} onDone={() => setAsk({ ...ask, action: undefined })} />
            ) : ask ? (
              <AskCard deps={deps} scope={ask.scope} title={ask.title} onClose={() => setAsk(null)} onOpenDirector={p.directorDocked ? undefined : api_.openDirector} />
            ) : editing ? (
              <ShotDetailsCard deps={deps} shotId={editing} onSave={(patch) => saveShot(editing, patch)} onClose={() => setEditing(null)} />
            ) : generating ? (
              <GenerateCard deps={deps} onClose={() => setGenerating(false)} />
            ) : null}
          </div>
        )}
      </div>
    </GraphCtx.Provider>
  );
}

export function StoryGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
