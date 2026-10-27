'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CheckCheck, ChevronsLeft, Crosshair, Download, Film, History, Keyboard, LayoutGrid, Network, Plus, Redo2, Save, Undo2, Upload } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { rippleDelete, swapShotVersion, timelineDuration, type Timeline } from '@framecraft/shared';
import { api, ApiError, endpoints, type Asset, type Project } from '@/lib/api';
import { clipStarts, newId, splitClip, useEditor } from '@/lib/editor-store';
import { clampTo, LIMITS, useEditorUi } from '@/lib/editor-ui';
import { useObjectUi } from '@/lib/object-ui';
import { useAssistant, type AssistantContext } from '@/lib/assistant';
import { useShotContext } from '@/lib/shot-context';
import { Button, Dialog, Skeleton, buttonVariants } from '@/components/ui';
import { useUploader } from '@/components/studio/upload';
import { MultiTrack } from '@/components/editor/multitrack';
import { StoryGraph } from '@/components/editor/story-graph';
import { Storyboard } from '@/components/editor/storyboard';
import { ShotEditor } from '@/components/editor/shot-editor';
import { EditorToolbox } from '@/components/editor/toolbox';
import { Preview } from '@/components/editor/preview';
import { Inspector, type Focus } from '@/components/editor/inspector';
import { ExportDialog, LibraryDialog, TranscribeButton, TtsDialog, VersionsDialog, type LibraryKind } from '@/components/editor/editor-dialogs';
import { DockedAssistant, FloatingAssistant, ResizeHandle, useAssistantShortcut } from '@/components/editor/assistant';
import { findObject, ObjectAiDialog, ObjectLayer, ObjectToolbar, useCleanEmptyObjects, useObjectShortcuts } from '@/components/editor/object-tool';
import { ReviewBar } from '@/components/editor/review';
import { useStudio } from '@/lib/studio';
import { cn, seconds } from '@/lib/utils';

type Workspace = 'story' | 'edit' | 'shot' | 'review';
type TimelineResponse = { timeline: Timeline; version: number; label: string | null; durationSec: number; project: Project };

function useMediaQuery(q: string) {
  const [match, setMatch] = useState(true);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return match;
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['S', 'Split the selected clip at the playhead'],
  ['I / O', 'Mark the start / end of a range (“this part”)'],
  ['Delete', 'Remove the selected clip (ripple: removes the marked range when one is set)'],
  ['Ctrl + D', 'Duplicate the selected clip'],
  ['← / →', 'Step one frame (Shift: one second)'],
  ['Home / End', 'Go to the start / end'],
  ['V', 'Select an object in the picture'],
  ['Esc', 'Close a menu · deselect · stop selecting'],
  ['Ctrl + J', 'Show / hide the assistant'],
  ['Ctrl + Z / Ctrl + Shift + Z', 'Undo / redo'],
  ['Ctrl + S', 'Save a version'],
  ['Ctrl + K', 'Search and jump anywhere'],
  ['?', 'This list'],
];

export default function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { timeline, apply, undo, redo, load, selected, select, extra, toggleExtra, dirty, markSaved, past, future } = useEditor();
  const layout = useEditorUi();
  const wide = useMediaQuery('(min-width: 1024px)');
  const roomy = useMediaQuery('(min-width: 1500px)');
  const [playhead, setPlayhead] = useState(0);
  const playheadRef = useRef(0);
  playheadRef.current = playhead;
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [saving, setSaving] = useState(false);
  const [libraryFor, setLibraryFor] = useState<LibraryKind | null>(null);
  const [ttsOpen, setTtsOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>('edit');
  const [storyView, setStoryView] = useState<'board' | 'graph'>('board');
  const [shotClip, setShotClip] = useState<string | null>(null);
  const [compareInit, setCompareInit] = useState<string | null>(null);
  const [selectedLayer, setSelectedLayerRaw] = useState<string | null>(null);
  const [selectedAudio, setSelectedAudio] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>('clip');
  const layerPick = useRef<null | { kind: 'image' | 'video'; cb: (a: Asset) => void }>(null);
  const studioQ = useStudio(id);
  const objSel = useObjectUi((s) => s.sel);
  const selecting = useObjectUi((s) => s.selecting);
  const shotCtx = useShotContext();
  const unread = useAssistant((s) => s.unread[id] ?? 0);

  useAssistantShortcut();
  useObjectShortcuts();
  useCleanEmptyObjects(apply);

  const setSelectedLayer = useCallback((lid: string | null) => {
    setSelectedLayerRaw(lid);
    if (lid) {
      setFocus('layer');
      useObjectUi.getState().set({ sel: null });
    }
  }, []);
  // Selecting an object shows its properties; deselecting goes back to the clip.
  useEffect(() => {
    if (objSel) {
      setFocus('object');
      select(objSel.clipId);
    } else setFocus((f) => (f === 'object' ? 'clip' : f));
  }, [objSel, select]);

  // Always the server's latest version when the editor opens (never a cached copy from an earlier
  // visit — autosave would otherwise write old content over newer work), and never reloaded under
  // the user's hands while editing.
  const tq = useQuery({ queryKey: ['timeline', id], queryFn: () => api<TimelineResponse>(`/api/projects/${id}/timeline`), staleTime: 0, gcTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false });
  const loaded = useRef<number>(0);
  const assetsQ = useQuery({ queryKey: ['assets', 'all'], queryFn: () => endpoints.assets('?limit=200'), refetchInterval: 15_000 });
  const assets = useMemo(() => new Map((assetsQ.data?.assets ?? []).map((a) => [a.id, a])), [assetsQ.data]);

  useEffect(() => {
    if (!tq.data || loaded.current === tq.dataUpdatedAt) return;
    loaded.current = tq.dataUpdatedAt;
    load(tq.data.timeline);
  }, [tq.data, tq.dataUpdatedAt, load]);
  // Nothing from another project stays selected.
  useEffect(() => () => useObjectUi.getState().set({ sel: null, selecting: false, popover: null, ai: null }), [id]);

  const save = useCallback(
    async (autosave: boolean, label?: string) => {
      const t = useEditor.getState().timeline;
      if (!t) return;
      setSaving(true);
      try {
        await api(`/api/projects/${id}/timeline`, { method: 'PUT', body: { timeline: t, autosave, label } });
        markSaved();
        if (!autosave) toast.success('Saved as a version');
      } catch (e) {
        if (!autosave) toast.error(e instanceof ApiError ? e.message : 'Save failed');
      } finally {
        setSaving(false);
      }
    },
    [id, markSaved],
  );

  // Autosave 2 s after the last change, and before the page goes away.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void save(true), 2000);
    return () => clearTimeout(t);
  }, [dirty, timeline, save]);
  useEffect(() => {
    const onHide = () => {
      if (!useEditor.getState().dirty) return;
      const t = useEditor.getState().timeline;
      if (t) void fetch(`/api/projects/${id}/timeline`, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeline: t, autosave: true }) });
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [id]);

  // Keyboard shortcuts (see SHORTCUTS).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || el?.isContentEditable) return;
      const st = useEditor.getState();
      const t = st.timeline;
      if (!t) return;
      const starts0 = clipStarts(t);
      const ci = t.clips.findIndex((c) => c.id === st.selected);
      const total = timelineDuration(t);
      if (!(e.ctrlKey || e.metaKey)) {
        if (e.key === ' ') {
          e.preventDefault();
          window.dispatchEvent(new Event('fc-editor-toggle-play'));
        } else if (e.key === '?') setHelpOpen(true);
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const d = (e.shiftKey ? 1 : 1 / (t.fps || 30)) * (e.key === 'ArrowRight' ? 1 : -1);
          setPlayhead((ph) => Math.max(0, Math.min(total, ph + d)));
        } else if (e.key === 'Home') setPlayhead(0);
        else if (e.key === 'End') setPlayhead(Math.max(0, total - 0.05));
        else if (e.key.toLowerCase() === 'i') {
          const p0 = playheadRef.current;
          setRange((r) => ({ start: p0, end: r && r.end > p0 + 0.1 ? r.end : Math.min(total, p0 + 1) }));
        } else if (e.key.toLowerCase() === 'o') {
          const p0 = playheadRef.current;
          setRange((r) => ({ start: r && r.start < p0 - 0.1 ? r.start : Math.max(0, p0 - 1), end: p0 }));
        } else if (e.key.toLowerCase() === 's' && ci >= 0) {
          const c = t.clips[ci]!;
          st.apply((x) => splitClip(x, c.id, c.inSec + (playheadRef.current - (starts0[ci] ?? 0)) * (c.speed || 1)));
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          const r = rangeRef.current;
          if (r && r.end - r.start > 0.05) {
            e.preventDefault();
            st.apply((x) => ({ ...x, ...rippleCut(x, r) }));
            setRange(null);
            toast.success(`Cut ${seconds(r.start)}–${seconds(r.end)} and closed the gap — Ctrl+Z undoes it`);
          } else if (ci >= 0 && t.clips.length > 1 && !useObjectUi.getState().sel) {
            e.preventDefault();
            const gone = new Set([st.selected!, ...st.extra]);
            if (gone.size >= t.clips.length) return void toast.message('Keep at least one clip in the video.');
            st.apply((x) => ({ ...x, clips: x.clips.filter((c) => !gone.has(c.id)) }));
            st.select(null);
            if (gone.size > 1) toast.success(`Removed ${gone.size} clips — Ctrl+Z undoes it`);
          }
        }
        return;
      }
      if (e.key.toLowerCase() === 'd' && ci >= 0) {
        e.preventDefault();
        st.apply((x) => {
          const c = x.clips[ci]!;
          x.clips.splice(ci + 1, 0, { ...c, id: newId('clip'), transition: undefined });
          return x;
        });
      } else if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save(false, 'Manual save');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, save]);

  // Films and ads open on the storyboard; your own videos open on the timeline. ?shot= opens a shot.
  const hasTimeline = Boolean(timeline);
  useEffect(() => {
    if (!hasTimeline) return;
    const t = useEditor.getState().timeline;
    const generated = t?.clips.some((c) => c.shotId) && (tq.data?.project.kind === 'movie' || tq.data?.project.kind === 'ad');
    setWorkspace(generated ? 'story' : 'edit');
    const shotId = new URLSearchParams(window.location.search).get('shot');
    const c = shotId && t?.clips.find((x) => x.shotId === shotId);
    if (c) {
      setShotClip(c.id);
      setWorkspace('shot');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTimeline]);

  const openShot = useCallback(
    (clipId: string, compare: string | null = null) => {
      select(clipId);
      setShotClip(clipId);
      setCompareInit(compare);
      setWorkspace('shot');
    },
    [select],
  );
  const playFrom = useCallback(
    (clipId: string) => {
      const t = useEditor.getState().timeline;
      if (!t) return;
      select(clipId);
      setFocus('clip');
      setPlayhead((clipStarts(t)[t.clips.findIndex((c) => c.id === clipId)] ?? 0) + 0.01);
    },
    [select],
  );
  const refetchStudio = studioQ.refetch;
  const activateVersion = useCallback(
    async (_shotId: string, versionId: string) => {
      try {
        const r = await api<{ shotId: string; versionId: string; assetId: string; durationSec: number; previousDurationSec?: number }>(`/api/shot-versions/${versionId}/activate`, { body: {} });
        apply((t) => swapShotVersion(t, r.shotId, r));
        void refetchStudio();
        toast.success('Version switched — the other versions are kept');
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : 'Could not switch version');
      }
    },
    [apply, refetchStudio],
  );
  const compareFromGraph = useCallback(
    (shotId: string, versionId: string) => {
      const c = useEditor.getState().timeline?.clips.find((x) => x.shotId === shotId);
      if (c) openShot(c.id, versionId);
    },
    [openShot],
  );
  const saveLayout = useCallback((l: { positions: Record<string, { x: number; y: number }>; collapsed: string[] }) => void api(`/api/projects/${id}/graph`, { method: 'PUT', body: l }).catch(() => undefined), [id]);

  const audioUp = useUploader({ projectId: id, accept: 'audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg' });
  const videoUp = useUploader({ projectId: id, accept: 'video/mp4,video/quicktime,video/webm' });
  const logoUp = useUploader({ projectId: id });

  if (!timeline || tq.isLoading || !tq.data || loaded.current !== tq.dataUpdatedAt) return <Skeleton className="mx-auto h-[70dvh] max-w-6xl" />;
  const project = tq.data!.project;
  const starts = clipStarts(timeline);
  const total = timelineDuration(timeline);
  const sel = timeline.clips.find((c) => c.id === selected);
  const { clip: objClip, obj } = findObject(timeline, objSel);

  const addAssetAsClip = (a: Asset) =>
    apply((t) => {
      t.clips.push({ id: newId('clip'), assetId: a.id, inSec: 0, outSec: Math.max(0.5, (a.durationMs ?? 5000) / 1000), volume: 1, label: a.originalName ?? undefined, speed: 1, reverse: false, fadeInSec: 0, fadeOutSec: 0, opacity: 1 });
      return t;
    });
  const addMusic = (a: Asset) =>
    apply((t) => {
      t.audio.push({ id: newId('aud'), assetId: a.id, kind: 'music', startSec: 0, inSec: 0, outSec: Math.max(1, Math.min((a.durationMs ?? total * 1000) / 1000, total || 600)), volume: 0.6, fadeInSec: 0, fadeOutSec: 1, muted: false, duck: true, denoise: false });
      return t;
    });
  const pickLibrary = (a: Asset) => {
    const kind = libraryFor;
    setLibraryFor(null);
    if (kind === 'clip') addAssetAsClip(a);
    else if (kind === 'replace' && sel)
      apply((t) => {
        const c = t.clips.find((x) => x.id === sel.id)!;
        c.assetId = a.id;
        c.inSec = 0;
        c.outSec = Math.max(0.5, (a.durationMs ?? 5000) / 1000);
        c.objects = undefined;
        c.shotId = undefined;
        c.versionId = undefined;
        return t;
      });
    else if (kind === 'audio') addMusic(a);
    else if ((kind === 'layer-image' || kind === 'layer-video') && layerPick.current) {
      layerPick.current.cb(a);
      layerPick.current = null;
    } else if (kind === 'logo') apply((t) => ({ ...t, logo: { assetId: a.id, position: 'top-right', scale: 0.12, opacity: 0.9 } }));
  };

  // What "this" means for the assistant right now.
  const ctxClip = objClip ?? sel;
  const ctxIndex = ctxClip ? timeline.clips.indexOf(ctxClip) : -1;
  const srcRange = (() => {
    if (!range || !ctxClip || ctxIndex < 0) return undefined;
    const s0 = starts[ctxIndex] ?? 0;
    const len = ctxClip.freezeSec ?? (ctxClip.outSec - ctxClip.inSec) / (ctxClip.speed || 1);
    if (range.start < s0 - 0.01 || range.end > s0 + len + 0.01) return undefined;
    const sp = ctxClip.speed || 1;
    const a = ctxClip.inSec + (range.start - s0) * sp;
    const b = ctxClip.inSec + (range.end - s0) * sp;
    return ctxClip.reverse ? { start: ctxClip.outSec - (b - ctxClip.inSec), end: ctxClip.outSec - (a - ctxClip.inSec) } : { start: a, end: b };
  })();
  const shotCtxClip = workspace === 'shot' && shotCtx.shot ? timeline.clips.find((c) => c.shotId === shotCtx.shot!.id) : undefined;
  const context: AssistantContext = shotCtxClip ? {
    clip: { id: shotCtxClip.id, index: timeline.clips.indexOf(shotCtxClip), label: shotCtxClip.label ?? `Shot ${shotCtx.shot!.number}`, shotId: shotCtxClip.shotId, versionId: shotCtx.shot!.versionId ?? shotCtxClip.versionId },
    srcRange: shotCtx.range ?? undefined,
    mask: shotCtx.mask ?? undefined,
    playhead,
  } : {
    clip: ctxClip ? { id: ctxClip.id, index: ctxIndex, label: ctxClip.label ?? `Clip ${ctxIndex + 1}`, shotId: ctxClip.shotId, versionId: ctxClip.versionId } : undefined,
    object: obj ? { id: obj.id, name: obj.name, mask: obj.mask } : undefined,
    layer: focus === 'layer' && selectedLayer ? { id: selectedLayer, name: timeline.layers.find((l) => l.id === selectedLayer)?.name ?? 'Layer' } : undefined,
    range: range ?? undefined,
    srcRange,
    playhead,
    clips: extra.length && sel ? [sel.id, ...extra].map((cid) => ({ id: cid, index: timeline.clips.findIndex((c) => c.id === cid) })).filter((c) => c.index >= 0) : undefined,
  };
  // On smaller screens a right-docked assistant takes the tool panel's room (the icon rail stays).
  const leftOpen = layout.leftOpen && !(layout.assistantOpen && layout.assistantDock === 'right' && !roomy);
  const assistantProps = { projectId: id, timeline, apply, context, onEditStarted: () => void refetchStudio() };

  const studio = studioQ.data;
  const reviewOps = (studio?.shots ?? []).flatMap((sh) => sh.operations.filter((o) => o.status === 'ready').map((o) => ({ shot: sh, op: o })));
  const shotEditorClip = shotClip && timeline.clips.some((c) => c.id === shotClip) ? shotClip : (sel?.id ?? timeline.clips[0]?.id ?? null);
  const shotEditorShot = studio?.shots.find((sh) => sh.id === timeline.clips.find((c) => c.id === shotEditorClip)?.shotId);
  const graphLayout = (project.settings as { graph?: { positions?: Record<string, { x: number; y: number }>; collapsed?: string[] } } | undefined)?.graph;
  const campaignId = (project.settings as { ad?: { campaignId?: string } } | undefined)?.ad?.campaignId;

  const previewEl = (
    <Preview
      timeline={timeline}
      assets={assets}
      playhead={playhead}
      setPlayhead={setPlayhead}
      onLogoMove={(pos) => apply((t) => ({ ...t, logo: t.logo ? { ...t.logo, ...pos } : t.logo }))}
      selectedLayer={selectedLayer}
      onSelectLayer={(lid) => {
        if (lid) setSelectedLayer(lid);
        else setSelectedLayerRaw(null);
      }}
      onLayerChange={(lid, patch) => apply((t) => ({ ...t, layers: t.layers.map((x) => (x.id === lid ? { ...x, ...patch } : x)) }))}
      selecting={selecting}
      onToggleSelecting={() => useObjectUi.getState().set({ selecting: !selecting })}
      objectsLayer={(pf) => <ObjectLayer pf={pf} projectId={id} apply={apply} />}
      toolbar={(pf) => <ObjectToolbar pf={pf} projectId={id} apply={apply} timeline={timeline} />}
      onBackgroundClick={() => {
        if (focus === 'layer') setFocus(sel ? 'clip' : 'project');
      }}
    />
  );

  const timelineEl = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-white">
          Timeline <span className="font-normal text-fog-400">· {seconds(total)}</span>
          {range && (
            <span className="flex items-center gap-1 rounded-md bg-iris-500/20 px-2 py-0.5 text-[11px] font-normal text-iris-100" data-testid="range-chip">
              Marked {seconds(range.start)}–{seconds(range.end)} ({(range.end - range.start).toFixed(1)} s)
              <button type="button" className="ml-1 text-iris-200 hover:text-white" onClick={() => { apply((x) => ({ ...x, ...rippleCut(x, range) })); setRange(null); toast.success('Cut and closed the gap — Ctrl+Z undoes it'); }}>Cut</button>
              <button type="button" aria-label="Clear marked range" className="ml-1 text-iris-200 hover:text-white" onClick={() => setRange(null)}>✕</button>
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setLibraryFor('clip')}><Plus /> Clip</Button>
          <Button size="sm" variant="ghost" onClick={async () => { const a = await videoUp.pick(); if (a) { addAssetAsClip(a); void assetsQ.refetch(); } }}><Upload /> Upload video</Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {timeline.clips.length ? (
          <MultiTrack
            timeline={timeline}
            assets={assets}
            playhead={playhead}
            selected={selected}
            onSeek={setPlayhead}
            onSelectClip={(clipId, at, additive) => {
              if (additive) {
                toggleExtra(clipId);
                setFocus('clip');
                return;
              }
              select(clipId);
              setFocus('clip');
              setPlayhead(at);
              if (useObjectUi.getState().sel?.clipId !== clipId) useObjectUi.getState().set({ sel: null });
            }}
            selectedExtra={extra}
            selectedLayer={selectedLayer}
            onSelectLayer={(lid) => setSelectedLayer(lid)}
            onLayerTiming={(lid, startSec, endSec) => apply((t) => ({ ...t, layers: t.layers.map((x) => (x.id === lid ? { ...x, startSec, endSec } : x)) }))}
            onMoveClip={(from, to) =>
              apply((t) => {
                const fi = t.clips.findIndex((x) => x.id === from);
                if (fi < 0 || fi === to) return t;
                const [m] = t.clips.splice(fi, 1);
                t.clips.splice(to, 0, m!);
                return t;
              })
            }
            onTrimClip={(clipId, inSec, outSec) => apply((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, inSec, outSec } : c)) }))}
            range={range}
            onRange={setRange}
            selectedAudio={selectedAudio}
            onSelectAudio={(aid) => {
              setSelectedAudio(aid);
              setFocus('audio');
            }}
            onAudioTiming={(aid, startSec) => apply((t) => ({ ...t, audio: t.audio.map((a) => (a.id === aid ? { ...a, startSec } : a)) }))}
          />
        ) : (
          <div className="grid h-full min-h-24 place-items-center rounded-lg border border-dashed hairline text-center text-sm text-fog-400">
            <div>
              <p>No clips yet — add videos from Media (left) or upload one.</p>
              <Button size="sm" className="mt-2" onClick={async () => { const a = await videoUp.pick(); if (a) { addAssetAsClip(a); void assetsQ.refetch(); } }}><Upload /> Upload a video</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const toolbox = (
    <EditorToolbox
      projectId={id}
      timeline={timeline}
      apply={apply}
      assets={assets}
      playhead={playhead}
      selectedClipId={selected}
      onAddClip={(a) => {
        addAssetAsClip(a);
        toast.success('Added to the end of the timeline');
      }}
      onAddMusic={addMusic}
      onTts={() => setTtsOpen(true)}
      onUploaded={() => void assetsQ.refetch()}
      onSelectLayer={(lid) => setSelectedLayer(lid)}
      transcribe={<TranscribeButton projectId={id} timeline={timeline} assets={assets} onCues={(cues) => apply((t) => ({ ...t, subtitles: cues.map((c) => ({ ...c, id: newId('sub') })) }))} />}
      open={wide ? leftOpen : true}
      onOpenChange={wide ? (o) => layout.set({ leftOpen: o }) : undefined}
      panelWidth={wide ? layout.leftWidth : undefined}
      onSelectObject={() => useObjectUi.getState().set({ selecting: true })}
      onOpenAssistant={() => layout.set({ assistantOpen: true })}
      onOpenShot={() => sel && openShot(sel.id)}
    />
  );

  const inspector = (
    <Inspector
      projectId={id}
      timeline={timeline}
      apply={apply}
      assets={assets}
      playhead={playhead}
      setPlayhead={setPlayhead}
      focus={focus}
      setFocus={setFocus}
      selectedClipId={selected}
      selectClip={select}
      selectedLayer={selectedLayer}
      setSelectedLayer={setSelectedLayer}
      selectedAudio={selectedAudio}
      setSelectedAudio={setSelectedAudio}
      onOpenShot={(cid) => openShot(cid)}
      onLibrary={setLibraryFor}
      onUploadLogo={async () => { const a = await logoUp.pick(); if (a) { apply((t) => ({ ...t, logo: { assetId: a.id, position: 'top-right', scale: 0.12, opacity: 0.9 } })); void assetsQ.refetch(); } }}
      onUploadAudio={async () => { const a = await audioUp.pick(); if (a) { addMusic(a); void assetsQ.refetch(); } }}
      onTts={() => setTtsOpen(true)}
      onRefetchAssets={() => void assetsQ.refetch()}
      onPickLayerAsset={(kind, cb) => {
        layerPick.current = { kind, cb };
        setLibraryFor(kind === 'image' ? 'layer-image' : 'layer-video');
      }}
      onEditStarted={() => void refetchStudio()}
      onHide={wide ? () => layout.set({ inspectorOpen: false }) : undefined}
    />
  );

  const resize = (key: 'leftWidth' | 'inspectorWidth' | 'timelineHeight', sign: 1 | -1) => {
    let base = 0;
    return {
      onDelta: (d: number) => {
        if (!base) base = useEditorUi.getState()[key];
        layout.set({ [key]: clampTo(base + sign * d, LIMITS[key]) });
      },
      onEnd: () => (base = 0),
    };
  };

  return (
    <div className={cn('mx-auto flex max-w-[2200px] flex-col gap-2', wide && 'h-[calc(100dvh-4rem)] min-h-[460px]')}>
      {audioUp.element}
      {videoUp.element}
      {logoUp.element}

      {/* Top bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Link href={project.kind === 'movie' ? `/app/movie/${id}` : project.kind === 'edit' ? '/app/edit' : `/app/projects/${id}`} aria-label="Back" className="grid size-8 place-items-center rounded-lg text-fog-400 hover:bg-white/[0.06] hover:text-white">
            <ChevronsLeft className="size-4" />
          </Link>
          <h1 className="max-w-[32ch] truncate text-sm font-semibold text-white" title={project.title}>{project.title}</h1>
          <span className="hidden text-[11px] text-fog-500 md:inline" aria-live="polite">{saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</span>
        </div>
        <div className="flex items-center gap-0.5 rounded-xl border hairline bg-white/[0.02] p-1" role="tablist" aria-label="Workspace">
          {(
            [
              ['story', LayoutGrid, 'Storyboard'],
              ['edit', Film, 'Edit'],
              ['shot', Crosshair, 'Shot'],
              ['review', CheckCheck, `Review${reviewOps.length ? ` · ${reviewOps.length}` : ''}`],
            ] as const
          ).map(([k, Icon, label]) => (
            <button key={k} type="button" role="tab" aria-selected={workspace === k} onClick={() => setWorkspace(k)} className={cn('flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs', workspace === k ? 'bg-iris-500 text-white' : 'text-fog-300 hover:bg-white/[0.06]')}>
              <Icon className="size-3.5" />
              <span className={cn(k !== 'edit' && 'hidden sm:inline')}>{label}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" aria-label="Undo" title="Undo (Ctrl+Z)" onClick={undo} disabled={!past.length}><Undo2 /></Button>
          <Button size="icon" variant="ghost" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!future.length}><Redo2 /></Button>
          <Button size="icon" variant="ghost" aria-label="Versions" title="Version history" onClick={() => setVersionsOpen(true)}><History /></Button>
          <Button size="icon" variant="ghost" aria-label="Save a version" title="Save a version (Ctrl+S)" onClick={() => save(false, 'Manual save')}><Save /></Button>
          <Button size="icon" variant="ghost" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)} className="hidden md:inline-flex"><Keyboard /></Button>
          {campaignId && <Link href={`/app/ads/footage/${campaignId}`} className={cn(buttonVariants({ size: 'sm', variant: 'ghost' }), 'hidden lg:inline-flex')}>Ad storyboard</Link>}
          <Button size="sm" variant={layout.assistantOpen ? 'secondary' : 'outline'} aria-pressed={layout.assistantOpen} title="Assistant (Ctrl+J)" onClick={() => layout.toggleAssistant()} className="relative">
            <Bot /> <span className="hidden sm:inline">Assistant</span>
            {!layout.assistantOpen && unread > 0 && <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-iris-500 text-[9px] font-semibold text-white">{unread}</span>}
          </Button>
          <Button size="sm" onClick={() => setExportOpen(true)}><Download /> Export</Button>
        </div>
      </div>

      <ReviewBar
        timeline={timeline}
        reviewOps={reviewOps}
        apply={apply}
        onDone={() => void refetchStudio()}
        onImprove={(shotId) => {
          const c = timeline.clips.find((x) => x.shotId === shotId);
          if (c) {
            select(c.id);
            setFocus('clip');
          }
          useAssistant.getState().setDraft(id, 'Better, but ');
          layout.set({ assistantOpen: true });
        }}
      />

      {/* Workspace + docked assistant */}
      <div className={cn('flex min-h-0 gap-2', wide ? 'flex-1' : 'flex-col')}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {workspace === 'edit' &&
            (wide ? (
              <>
                <div className="flex min-h-[240px] flex-1">
                  <div className="shrink-0" data-testid="tool-panel">{toolbox}</div>
                  {leftOpen ? <ResizeHandle axis="x" label="Resize the tool panel" {...resize('leftWidth', 1)} /> : <span className="w-2 shrink-0" />}
                  <section aria-label="Preview" className="min-w-0 flex-1 rounded-2xl border hairline bg-ink-900/40 p-2">{previewEl}</section>
                  {layout.inspectorOpen ? (
                    <>
                      <ResizeHandle axis="x" label="Resize the properties panel" {...resize('inspectorWidth', -1)} />
                      <aside aria-label="Properties" className="shrink-0 overflow-hidden rounded-2xl border hairline bg-ink-900/70" style={{ width: layout.inspectorWidth }}>
                        {inspector}
                      </aside>
                    </>
                  ) : (
                    <button type="button" onClick={() => layout.set({ inspectorOpen: true })} className="ml-2 flex w-8 shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border hairline bg-ink-900/70 text-[11px] text-fog-400 hover:text-white" title="Show properties">
                      <span className="[writing-mode:vertical-rl]">Properties</span>‹
                    </button>
                  )}
                </div>
                <ResizeHandle axis="y" label="Resize the timeline" {...resize('timelineHeight', -1)} />
                <section aria-label="Timeline" className="min-h-[140px] shrink overflow-hidden rounded-2xl border hairline bg-ink-900/40 p-3" style={{ height: `min(${layout.timelineHeight}px, 42dvh)` }}>{timelineEl}</section>
              </>
            ) : (
              <div className="space-y-2">
                <section aria-label="Preview" className="h-[56dvh] rounded-2xl border hairline bg-ink-900/40 p-2">{previewEl}</section>
                <section aria-label="Timeline" className="flex max-h-[380px] min-h-[170px] flex-col rounded-2xl border hairline bg-ink-900/40 p-3">{timelineEl}</section>
                <div className="h-[360px]" data-testid="tool-panel">{toolbox}</div>
                <aside aria-label="Properties" className="max-h-[70dvh] overflow-hidden rounded-2xl border hairline bg-ink-900/70">{inspector}</aside>
              </div>
            ))}

          {workspace === 'story' && (
            <div className={cn('flex min-h-0 flex-col gap-2', wide && 'flex-1')}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-fog-400">{storyView === 'board' ? 'Your video, shot by shot. Drag to reorder, click a shot to play it, open it to change it.' : 'Advanced: how shots, versions and AI edits connect.'}</p>
                <div className="flex items-center gap-0.5 rounded-lg border hairline p-0.5 text-[11px]">
                  <button type="button" onClick={() => setStoryView('board')} className={cn('flex items-center gap-1 rounded-md px-2 py-1', storyView === 'board' ? 'bg-white/10 text-white' : 'text-fog-400')}><LayoutGrid className="size-3" /> Storyboard</button>
                  <button type="button" onClick={() => setStoryView('graph')} className={cn('flex items-center gap-1 rounded-md px-2 py-1', storyView === 'graph' ? 'bg-white/10 text-white' : 'text-fog-400')}><Network className="size-3" /> Graph</button>
                </div>
              </div>
              <div className={cn('grid min-h-0 gap-2 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]', wide && 'flex-1')}>
                <div className={cn('min-h-[420px] overflow-hidden rounded-2xl border hairline bg-ink-900/40', wide && 'min-h-0')}>
                  {storyView === 'board' ? (
                    <Storyboard timeline={timeline} assets={assets} studio={studio} apply={apply} selectedClipId={selected} playhead={playhead} onPlay={playFrom} onOpenShot={(cid) => openShot(cid)} onAdd={() => setLibraryFor('clip')} />
                  ) : (
                    <StoryGraph projectId={id} timeline={timeline} studio={studio} assets={assets} selectedClipId={selected} savedLayout={graphLayout} apply={apply} onSelectClip={playFrom} onPlayFrom={playFrom} onOpenShot={openShot} onUseVersion={activateVersion} onCompare={compareFromGraph} onSaveLayout={saveLayout} />
                  )}
                </div>
                <div className="min-h-[360px] rounded-2xl border hairline bg-ink-900/40 p-2">{previewEl}</div>
              </div>
            </div>
          )}

          {workspace === 'shot' && shotEditorClip && (
            <div className={cn('min-h-0 overflow-y-auto', wide && 'flex-1')}>
              <ShotEditor key={shotEditorClip} projectId={id} clipId={shotEditorClip} timeline={timeline} apply={apply} shot={shotEditorShot} assets={assets} onClose={() => setWorkspace('edit')} initialCompare={compareInit} />
            </div>
          )}

          {workspace === 'review' && (
            <div className={cn('space-y-3 overflow-y-auto', wide && 'min-h-0 flex-1')}>
              <p className="text-sm text-fog-300">AI results waiting for your decision. Nothing in the video changes until you accept.</p>
              {!reviewOps.length && <div className="rounded-2xl border hairline p-6 text-center text-sm text-fog-400">Nothing to review.</div>}
              {reviewOps.map(({ shot, op }) => {
                const v = shot.versions.find((x) => x.id === op.resultVersionId);
                return (
                  <div key={op.id} className="flex flex-wrap items-center gap-3 rounded-2xl border hairline p-3">
                    {v?.media?.thumbnailUrl && <img src={v.media.thumbnailUrl} alt="" className="h-14 rounded-lg" />}
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="text-white">Shot {shot.number} · {op.mode.replaceAll('_', ' ')} · {seconds(op.startSec)}–{seconds(op.endSec)}</div>
                      <div className="truncate text-xs text-fog-400">{op.instruction}</div>
                    </div>
                    <Button size="sm" onClick={() => { const c = timeline.clips.find((x) => x.shotId === shot.id); if (c) openShot(c.id, op.resultVersionId); }}>Compare &amp; decide</Button>
                  </div>
                );
              })}
            </div>
          )}

          {wide && <DockedAssistant side="bottom" {...assistantProps} />}
        </div>
        {wide && <DockedAssistant side="right" {...assistantProps} />}
      </div>
      <FloatingAssistant {...assistantProps} compact={!wide} />

      <ObjectAiDialog projectId={id} timeline={timeline} apply={apply} onStarted={() => void refetchStudio()} />

      <Dialog open={helpOpen} onOpenChange={setHelpOpen} title="Keyboard shortcuts">
        <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="contents">
              <kbd className="rounded-md border hairline bg-white/[0.04] px-2 py-0.5 text-xs text-fog-100">{k}</kbd>
              <span className="text-fog-300">{v}</span>
            </div>
          ))}
        </div>
      </Dialog>
      <LibraryDialog kind={libraryFor} onClose={() => setLibraryFor(null)} assets={assetsQ.data?.assets ?? []} onPick={pickLibrary} />
      <TtsDialog open={ttsOpen} onOpenChange={setTtsOpen} projectId={id} onDone={(assetId, durationSec) => { void assetsQ.refetch(); apply((t) => { t.audio.push({ id: newId('aud'), assetId, kind: 'voice', startSec: Math.round(playhead * 10) / 10, inSec: 0, outSec: durationSec, volume: 1, fadeInSec: 0, fadeOutSec: 0, muted: false, duck: false, denoise: false }); return t; }); void qc.invalidateQueries({ queryKey: ['me'] }); }} />
      <VersionsDialog open={versionsOpen} onOpenChange={setVersionsOpen} projectId={id} onRestored={() => tq.refetch()} />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} projectId={id} timeline={timeline} />
    </div>
  );
}

/** Ripple-cut a marked stretch of the movie (same operation the assistant uses). */
function rippleCut(t: Timeline, r: { start: number; end: number }): Partial<Timeline> {
  return rippleDelete(t, r.start, r.end, () => newId('clip'));
}
