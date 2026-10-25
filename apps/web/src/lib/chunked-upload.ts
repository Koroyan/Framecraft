import { api, ApiError, type Asset } from './api';

/*
 * Resumable chunked upload (see the server's services/uploads.ts). The file is read one slice at a
 * time (never whole into memory), each chunk is retried on network errors, and a re-selected file
 * (same name, size and modification time) continues where it stopped — even after a reload.
 */

export type MediaPrep = { status: 'processing' | 'ready' | 'failed'; proxy?: { width: number; height: number; sizeBytes: number }; media?: Record<string, unknown>; error?: string };
export type UploadedAsset = Asset & { masterUrl?: string; prep?: MediaPrep | null };
type Session = { id: string; sizeBytes: number; receivedBytes: number; chunkSize: number; status: string };

export class UploadPaused extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** iPhone HEIC photos: converted to JPEG in browsers that can decode them (Safari). */
export async function heicToJpeg(file: File): Promise<File> {
  if (!/\.(heic|heif)$/i.test(file.name) && !/heic|heif/i.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d')!.drawImage(bmp, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) throw new Error('encode');
    return new File([blob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    throw new Error(`${file.name}: this browser cannot open HEIC photos. Export it as JPEG (iPhone: Settings → Camera → Formats → Most Compatible), or upload it from Safari.`);
  }
}

async function putChunk(id: string, offset: number, blob: Blob, signal?: AbortSignal): Promise<Session> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`/api/uploads/${id}/chunk?offset=${offset}`, { method: 'PUT', body: blob, headers: { 'Content-Type': 'application/octet-stream' }, credentials: 'same-origin', signal });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data.session;
      const e = (data as { error?: { code?: string; message?: string } }).error ?? {};
      // 409 = the server expects another offset (e.g. a chunk landed twice): resync, never fail.
      if (res.status === 409 && /Expected the chunk/.test(e.message ?? '')) return (await api<{ session: Session }>(`/api/uploads/${id}`)).session;
      if (res.status === 507 || (res.status < 500 && res.status !== 429)) throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Upload failed (${res.status})`);
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (signal?.aborted) throw new UploadPaused('paused');
      if (err instanceof ApiError || attempt >= 5) throw err;
      await sleep(Math.min(15_000, 1000 * 2 ** attempt)); // network hiccup: back off and resend this chunk
    }
  }
}

export async function uploadChunked(
  file: File,
  opts: { kind?: 'upload' | 'reference'; projectId?: string; containsPeople?: boolean; signal?: AbortSignal; onSession?: (id: string) => void; onProgress?: (sent: number, total: number, resumedFrom: number) => void },
): Promise<{ asset: UploadedAsset; deduplicated: boolean; sessionId: string }> {
  const start = await api<{ session: Session; resumed: boolean }>('/api/uploads', {
    body: { filename: file.name, sizeBytes: file.size, fingerprint: `${file.name}:${file.size}:${file.lastModified}`, kind: opts.kind ?? 'upload', projectId: opts.projectId, rightsConfirmed: true, containsPeople: Boolean(opts.containsPeople) },
  });
  let s = start.session;
  opts.onSession?.(s.id);
  const resumedFrom = start.resumed ? s.receivedBytes : 0;
  opts.onProgress?.(s.receivedBytes, file.size, resumedFrom);
  while (s.receivedBytes < file.size) {
    if (opts.signal?.aborted) throw new UploadPaused('paused');
    const off = s.receivedBytes;
    s = await putChunk(s.id, off, file.slice(off, Math.min(file.size, off + s.chunkSize)), opts.signal);
    opts.onProgress?.(s.receivedBytes, file.size, resumedFrom);
  }
  const done = await api<{ asset: UploadedAsset; deduplicated: boolean }>(`/api/uploads/${s.id}/complete`, { body: {} });
  return { ...done, sessionId: s.id };
}

export const cancelUploadSession = (id: string) => api(`/api/uploads/${id}`, { method: 'DELETE' }).catch(() => undefined);

/** Poll until the editing proxy is ready (MOV/HEVC/4K/HDR conversion). */
export async function waitForPrep(assetId: string, onUpdate?: (a: UploadedAsset) => void, signal?: AbortSignal): Promise<UploadedAsset> {
  for (;;) {
    const { asset } = await api<{ asset: UploadedAsset }>(`/api/assets/${assetId}/prep`, { signal });
    onUpdate?.(asset);
    if (!asset.prep || asset.prep.status !== 'processing') return asset;
    await sleep(2500);
  }
}

export const formatBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
