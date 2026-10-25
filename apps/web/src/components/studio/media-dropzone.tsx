'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Pause, Play, RotateCcw, Sparkles, UploadCloud, X } from 'lucide-react';
import { Button, Dialog, Switch } from '@/components/ui';
import { cn } from '@/lib/utils';
import { cancelUploadSession, formatBytes, heicToJpeg, uploadChunked, UploadPaused, waitForPrep, type UploadedAsset } from '@/lib/chunked-upload';
import { ApiError } from '@/lib/api';

/*
 * Drag-and-drop media upload for large phone footage: several files at once, per-file progress,
 * pause / resume / cancel / retry, resume after a reload (pick the same file again), and the
 * post-upload preparation status ("Optimized for AI").
 */

type Task = {
  key: string;
  file: File;
  sent: number;
  total: number;
  resumedFrom: number;
  status: 'queued' | 'uploading' | 'paused' | 'preparing' | 'done' | 'error' | 'cancelled';
  error?: string;
  asset?: UploadedAsset;
  deduplicated?: boolean;
  speed?: number;
};

const ACCEPT = 'video/mp4,video/quicktime,video/x-m4v,video/webm,video/x-matroska,.mov,.mp4,.m4v,.mkv,.webm,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif';
const CONCURRENCY = 2;

export function MediaDropzone({ onAsset, accept = ACCEPT, kind = 'upload', projectId, compact, label = 'Drop videos and photos here' }: { onAsset: (a: UploadedAsset) => void; accept?: string; kind?: 'upload' | 'reference'; projectId?: string; compact?: boolean; label?: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pending, setPending] = useState<File[]>([]);
  const [rights, setRights] = useState(false);
  const [people, setPeople] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const sessions = useRef(new Map<string, string>());
  const consent = useRef({ people: false });
  const onAssetRef = useRef(onAsset);
  onAssetRef.current = onAsset;

  const patch = useCallback((key: string, p: Partial<Task>) => setTasks((all) => all.map((t) => (t.key === key ? { ...t, ...p } : t))), []);

  const run = useCallback(
    async (task: Task) => {
      const ctrl = new AbortController();
      controllers.current.set(task.key, ctrl);
      patch(task.key, { status: 'uploading', error: undefined });
      const t0 = performance.now();
      let firstSent = -1;
      try {
        const file = await heicToJpeg(task.file);
        const r = await uploadChunked(file, {
          kind,
          projectId,
          containsPeople: consent.current.people,
          signal: ctrl.signal,
          onSession: (id) => sessions.current.set(task.key, id),
          onProgress: (sent, total, resumedFrom) => {
            if (firstSent < 0) firstSent = sent;
            const secs = (performance.now() - t0) / 1000;
            patch(task.key, { sent, total, resumedFrom, speed: secs > 0.5 ? (sent - firstSent) / secs : undefined });
          },
        });
        patch(task.key, { status: r.asset.prep?.status === 'processing' ? 'preparing' : 'done', asset: r.asset, deduplicated: r.deduplicated, sent: task.total });
        onAssetRef.current(r.asset);
        if (r.asset.prep?.status === 'processing') {
          const ready = await waitForPrep(r.asset.id);
          patch(task.key, { status: ready.prep?.status === 'failed' ? 'error' : 'done', asset: ready, error: ready.prep?.status === 'failed' ? `Uploaded, but could not be optimized: ${ready.prep.error ?? 'unknown error'}` : undefined });
          onAssetRef.current(ready);
        }
      } catch (err) {
        if (err instanceof UploadPaused) patch(task.key, { status: 'paused' });
        else patch(task.key, { status: 'error', error: err instanceof ApiError || err instanceof Error ? err.message : 'Upload failed' });
      } finally {
        controllers.current.delete(task.key);
      }
    },
    [kind, projectId, patch],
  );

  // Simple scheduler: at most CONCURRENCY uploads at a time, in order.
  useEffect(() => {
    const active = tasks.filter((t) => t.status === 'uploading').length;
    const next = tasks.filter((t) => t.status === 'queued').slice(0, Math.max(0, CONCURRENCY - active));
    for (const t of next) void run(t);
  }, [tasks, run]);

  useEffect(() => () => controllers.current.forEach((c) => c.abort()), []);

  const enqueue = (files: File[]) => {
    const fresh = files.map<Task>((file) => ({ key: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 6)}`, file, sent: 0, total: file.size, resumedFrom: 0, status: 'queued' }));
    setTasks((all) => [...all, ...fresh]);
  };

  const choose = (files: FileList | File[] | null) => {
    const list = [...(files ?? [])];
    if (!list.length) return;
    setRights(false);
    setPeople(false);
    setPending(list);
  };

  const cancel = async (t: Task) => {
    controllers.current.get(t.key)?.abort();
    const id = sessions.current.get(t.key);
    if (id) await cancelUploadSession(id);
    patch(t.key, { status: 'cancelled' });
  };

  const visible = tasks.filter((t) => t.status !== 'cancelled');
  const totalBytes = visible.reduce((s, t) => s + t.total, 0);
  const sentBytes = visible.reduce((s, t) => s + t.sent, 0);

  return (
    <div className="space-y-3">
      <input ref={input} type="file" hidden multiple accept={accept} onChange={(e) => { choose(e.target.files); e.target.value = ''; }} />
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files); }}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed text-center transition',
          compact ? 'px-4 py-5' : 'px-6 py-10',
          over ? 'border-iris-400 bg-iris-500/10' : 'hairline bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.04]',
        )}
      >
        <UploadCloud className={cn('text-iris-300', compact ? 'size-6' : 'size-9')} />
        <span className="text-sm font-medium text-white">{label}</span>
        <span className="max-w-md text-xs text-fog-400">MOV, MP4, M4V, WebM, MKV, JPG, PNG, WebP, HEIC — straight from the phone, 4K and multi-gigabyte files included. We keep your original and prepare an optimized copy automatically.</span>
      </button>

      {visible.length > 0 && (
        <div className="space-y-2" aria-live="polite">
          {visible.length > 1 && (
            <div className="flex items-center justify-between text-[11px] text-fog-400">
              <span>{visible.filter((t) => t.status === 'done').length} of {visible.length} ready</span>
              <span>{formatBytes(sentBytes)} / {formatBytes(totalBytes)}</span>
            </div>
          )}
          {visible.map((t) => (
            <TaskRow key={t.key} t={t} onPause={() => controllers.current.get(t.key)?.abort()} onResume={() => patch(t.key, { status: 'queued' })} onRetry={() => patch(t.key, { status: 'queued' })} onCancel={() => cancel(t)} onDismiss={() => setTasks((all) => all.filter((x) => x.key !== t.key))} />
          ))}
        </div>
      )}

      <Dialog
        open={pending.length > 0}
        onOpenChange={(o) => !o && setPending([])}
        title="Before you upload"
        description={pending.length === 1 ? pending[0]!.name : `${pending.length} files`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending([])}>Cancel</Button>
            <Button
              disabled={!rights}
              onClick={() => {
                consent.current = { people };
                enqueue(pending);
                setPending([]);
              }}
            >
              Upload {pending.length > 1 ? `${pending.length} files` : ''}
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-0.5 size-4 accent-iris-500" checked={rights} onChange={(e) => setRights(e.target.checked)} />
            <span className="text-fog-200">I own these files or have permission to use them, including for commercial use where applicable.</span>
          </label>
          <div className="flex items-center justify-between gap-4 rounded-xl border hairline p-3">
            <span className="text-fog-200">They show identifiable real people</span>
            <Switch checked={people} onCheckedChange={setPeople} label="Contains people" />
          </div>
          {people && <p className="rounded-xl bg-signal-amber/10 p-3 text-xs text-signal-amber">You confirm every identifiable person has consented.</p>}
        </div>
      </Dialog>
    </div>
  );
}

function TaskRow({ t, onPause, onResume, onRetry, onCancel, onDismiss }: { t: Task; onPause: () => void; onResume: () => void; onRetry: () => void; onCancel: () => void; onDismiss: () => void }) {
  const pct = t.total ? Math.round((t.sent / t.total) * 100) : 0;
  const media = t.asset?.prep?.media as { codec?: string; width?: number; height?: number; hdr?: boolean; rotation?: number } | undefined;
  const statusText =
    t.status === 'queued' ? 'Waiting…'
    : t.status === 'uploading' ? `${pct}% · ${formatBytes(t.sent)} of ${formatBytes(t.total)}${t.speed ? ` · ${formatBytes(t.speed)}/s` : ''}${t.resumedFrom ? ` · resumed from ${Math.round((t.resumedFrom / t.total) * 100)}%` : ''}`
    : t.status === 'paused' ? `Paused at ${pct}% — resume any time (even after reloading, by picking the same file)`
    : t.status === 'preparing' ? 'Uploaded — converting and optimizing for editing and AI…'
    : t.status === 'done' ? (t.deduplicated ? 'Already in your library — reused' : 'Uploaded successfully — Optimized for AI')
    : t.error ?? 'Failed';
  return (
    <div className="rounded-xl border hairline bg-ink-900/60 p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm text-white">
            {t.status === 'done' && <CheckCircle2 className="size-4 shrink-0 text-signal-green" />}
            {t.status === 'error' && <AlertTriangle className="size-4 shrink-0 text-signal-red" />}
            {t.status === 'preparing' && <Sparkles className="size-4 shrink-0 animate-pulse text-iris-300" />}
            <span className="truncate">{t.file.name}</span>
            <span className="shrink-0 text-[11px] text-fog-500">{formatBytes(t.total)}</span>
          </div>
          <div className={cn('mt-0.5 text-[11px]', t.status === 'error' ? 'text-signal-red' : t.status === 'done' ? 'text-signal-green' : 'text-fog-400')}>{statusText}</div>
          {t.status === 'done' && media?.codec && (
            <div className="mt-0.5 text-[10px] text-fog-500">
              Original kept: {media.codec.toUpperCase()} {media.width}×{media.height}{media.hdr ? ' HDR' : ''}{media.rotation ? ` · rotated ${media.rotation}°` : ''}
              {t.asset?.prep?.proxy ? ` · editing copy ${t.asset.prep.proxy.width}×${t.asset.prep.proxy.height} H.264` : ' · plays as is'}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {t.status === 'uploading' && <Button size="icon" variant="ghost" aria-label="Pause upload" onClick={onPause}><Pause /></Button>}
          {t.status === 'paused' && <Button size="icon" variant="ghost" aria-label="Resume upload" onClick={onResume}><Play /></Button>}
          {t.status === 'error' && !t.asset && <Button size="icon" variant="ghost" aria-label="Retry upload" onClick={onRetry}><RotateCcw /></Button>}
          {['queued', 'uploading', 'paused'].includes(t.status) && <Button size="icon" variant="ghost" aria-label="Cancel upload" onClick={onCancel}><X /></Button>}
          {['done', 'error'].includes(t.status) && <Button size="icon" variant="ghost" aria-label="Dismiss" onClick={onDismiss}><X /></Button>}
        </div>
      </div>
      {['uploading', 'paused', 'preparing'].includes(t.status) && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
          <div className={cn('h-full rounded-full transition-all', t.status === 'preparing' ? 'w-full animate-pulse bg-iris-400/60' : 'bg-iris-400')} style={t.status === 'preparing' ? undefined : { width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
