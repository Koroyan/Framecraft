'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Film, ImageIcon, Music, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, type Asset } from '@/lib/api';
import { Badge, Card, Segmented, Skeleton } from '@/components/ui';
import { MediaDropzone } from '@/components/studio/media-dropzone';
import { formatBytes, type MediaPrep } from '@/lib/chunked-upload';
import { cn, seconds } from '@/lib/utils';

type LibAsset = Asset & { prep?: MediaPrep | null; sizeBytes?: number; mimeType?: string };

/** Every uploaded and generated media file, with what we prepared from each original. */
export function MediaLibrary() {
  const [type, setType] = useState<'all' | 'video' | 'image' | 'audio'>('all');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['assets', 'library', type],
    queryFn: () => api<{ assets: LibAsset[] }>(`/api/assets?limit=200${type === 'all' ? '' : `&mediaType=${type}`}`),
    refetchInterval: (qq) => (qq.state.data?.assets.some((a) => a.prep?.status === 'processing') ? 4000 : false),
  });
  const usage = useQuery({ queryKey: ['upload-config'], queryFn: () => api<{ chunkSize: number; maxBytes: number; quotaBytes: number | null; usedBytes: number }>('/api/uploads/config') });
  const items = (q.data?.assets ?? []).filter((a) => a.mediaType !== 'text');
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">Media Library</h1>
          <p className="mt-1 text-sm text-fog-400">Your originals are kept untouched. Videos get an editing copy and AI-ready versions automatically.</p>
        </div>
        {usage.data && <div className="text-xs text-fog-400">Storage: {formatBytes(usage.data.usedBytes)}{usage.data.quotaBytes ? ` of ${formatBytes(usage.data.quotaBytes)}` : ''} · files up to {formatBytes(usage.data.maxBytes)}</div>}
      </div>
      <MediaDropzone onAsset={() => void qc.invalidateQueries({ queryKey: ['assets'] })} />
      <Segmented size="sm" value={type} onChange={setType} options={[{ value: 'all', label: 'All' }, { value: 'video', label: 'Videos' }, { value: 'image', label: 'Photos' }, { value: 'audio', label: 'Audio' }]} />
      {q.isLoading && <Skeleton className="h-48" />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((a) => {
          const m = a.prep?.media as { codec?: string; hdr?: boolean } | undefined;
          return (
            <Card key={a.id} className="overflow-hidden">
              <div className="relative aspect-video bg-ink-900">
                {a.mediaType === 'audio' ? <div className="grid size-full place-items-center"><Music className="size-6 text-fog-500" /></div> : <img src={a.thumbnailUrl ?? a.url} alt="" className="size-full object-cover" loading="lazy" />}
                {a.mediaType === 'video' && a.durationMs ? <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] text-white">{seconds(a.durationMs / 1000)}</span> : null}
                <span className="absolute left-1 top-1 text-white/80">{a.mediaType === 'video' ? <Film className="size-3.5" /> : a.mediaType === 'image' ? <ImageIcon className="size-3.5" /> : null}</span>
              </div>
              <div className="space-y-1 p-2 text-[11px]">
                <div className="truncate text-fog-100" title={a.originalName ?? ''}>{a.originalName ?? a.kind}</div>
                <div className="flex flex-wrap items-center gap-1 text-fog-500">
                  {a.width && a.height ? <span>{a.width}×{a.height}</span> : null}
                  {m?.codec && <span>{m.codec.toUpperCase()}{m.hdr ? ' HDR' : ''}</span>}
                  {a.sizeBytes ? <span>{formatBytes(a.sizeBytes)}</span> : null}
                </div>
                {a.mediaType === 'video' && (
                  <Badge tone={a.prep?.status === 'failed' ? 'red' : a.prep?.status === 'processing' ? 'iris' : 'green'} className={cn(a.prep?.status === 'processing' && 'animate-pulse')}>
                    {a.prep?.status === 'processing' ? 'Optimizing…' : a.prep?.status === 'failed' ? 'Optimization failed' : a.prep?.proxy ? 'Optimized for AI · editing copy' : 'Ready · plays as is'}
                  </Badge>
                )}
                <div className="flex items-center justify-between">
                  {a.downloadUrl ? <a href={a.downloadUrl} className="flex items-center gap-1 text-fog-400 hover:text-white"><Download className="size-3" /> Original</a> : <span />}
                  <button
                    type="button"
                    aria-label={`Delete ${a.originalName ?? 'file'}`}
                    className="text-fog-500 hover:text-signal-red"
                    onClick={async () => {
                      if (!window.confirm(`Delete ${a.originalName ?? 'this file'} and its prepared copies? Projects that use it will lose this media.`)) return;
                      try {
                        await api(`/api/assets/${a.id}`, { method: 'DELETE' });
                        await qc.invalidateQueries({ queryKey: ['assets'] });
                      } catch {
                        toast.error('Could not delete');
                      }
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
