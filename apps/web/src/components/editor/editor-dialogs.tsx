'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AudioLines, Captions, Download } from 'lucide-react';
import { toast } from 'sonner';
import { LANGUAGES, timelineDuration, type Timeline } from '@framecraft/shared';
import { api, ApiError, type Asset } from '@/lib/api';
import { useJob } from '@/lib/hooks';
import { Button, Card, Dialog, Field, NativeSelect, Textarea, buttonVariants } from '@/components/ui';
import { ProgressBar } from '@/components/studio/progress';
import { cn, newKey, seconds } from '@/lib/utils';

// ------------------------------------------------------------------ export

export function ExportDialog({ open, onOpenChange, projectId, timeline }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string; timeline: Timeline }) {
  const [preset, setPreset] = useState<'master' | 'tiktok' | 'reels' | 'shorts' | 'youtube' | 'feed'>('master');
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data } = useJob(jobId);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ job: { id: string } }>(`/api/projects/${projectId}/render`, { body: { timeline, preset, idempotencyKey: newKey() } });
      setJobId(r.job.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };
  const job = data?.job;
  const running = Boolean(job && !['completed', 'failed'].includes(job.status));
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Export video" description={`${seconds(timelineDuration(timeline))} · ${timeline.aspectRatio} · ${timeline.resolution}. Rendering uses FFmpeg on our servers — no AI credits.`}>
      <div className="space-y-4">
        <Field label="Format">
          <NativeSelect value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)} aria-label="Export preset">
            <option value="master">Master (this project’s format)</option>
            <option value="tiktok">TikTok 9:16 1080p</option>
            <option value="reels">Instagram Reels 9:16 1080p</option>
            <option value="shorts">YouTube Shorts 9:16 1080p</option>
            <option value="youtube">YouTube 16:9 1080p</option>
            <option value="feed">Feed 4:5 1080p</option>
          </NativeSelect>
        </Field>
        <Button onClick={start} loading={busy || running} disabled={!timeline.clips.length} className="w-full">
          <Download /> Render MP4
        </Button>
        {job && (
          <Card className="p-3 text-sm">
            {job.status === 'completed' ? <div className="text-fog-100">{job.phase}</div> : <ProgressBar progress={job.progress} etaSec={job.etaSec} label={job.phase} />}
            {job.status === 'completed' && job.outputUrl && (
              <>
                {/* Watch the result right here, before saving it. */}
                <video src={job.outputUrl} controls playsInline preload="metadata" className="mt-3 max-h-[34dvh] w-full rounded-lg bg-black object-contain" data-testid="export-player" />
                <a href={job.outputUrl} download className={cn(buttonVariants({ variant: 'white', size: 'sm' }), 'mt-3')} data-testid="export-download">
                  <Download /> Download {job.isFixture ? '(contains test fixtures)' : ''}
                </a>
              </>
            )}
            {job.status === 'failed' && <p className="mt-2 text-signal-red">{job.error?.message}</p>}
          </Card>
        )}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ voice-over

export function TtsDialog({ open, onOpenChange, projectId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string; onDone: (assetId: string, durationSec: number) => void }) {
  const [text, setText] = useState('');
  const [language, setLanguage] = useState('en');
  const [voiceId, setVoice] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<{ credits: number; available: boolean } | null>(null);
  const voices = useQuery({ queryKey: ['voices'], queryFn: () => api<{ voices: { id: string; name: string }[]; configured: boolean }>('/api/audio/voices'), enabled: open });
  const { data } = useJob(jobId);
  const job = data?.job;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (job?.status === 'completed' && job.outputAssetId && handled.current !== job.id) {
      handled.current = job.id;
      void api<{ asset: Asset }>(`/api/assets/${job.outputAssetId}`).then((r) => {
        onDone(r.asset.id, (r.asset.durationMs ?? 3000) / 1000);
        setJobId(null);
        onOpenChange(false);
        toast.success('Voice-over added to the timeline');
      });
    }
  }, [job?.id, job?.status, job?.outputAssetId, onDone, onOpenChange]);
  // Price before generating (it is a paid service).
  useEffect(() => {
    if (!open || !text.trim()) return setEstimate(null);
    const id = setTimeout(() => void api<{ estimate: { credits: number; available: boolean } }>('/api/audio/estimate', { body: { kind: 'tts', text, language } }).then((r) => setEstimate(r.estimate)).catch(() => setEstimate(null)), 400);
    return () => clearTimeout(id);
  }, [open, text, language]);
  const go = async () => {
    try {
      const r = await api<{ job: { id: string }; reused: boolean }>('/api/audio', { body: { kind: 'tts', text, language, voiceId: voiceId || undefined, projectId, idempotencyKey: newKey() } });
      if (r.reused) toast.message('Reused an identical narration you already generated — no charge.');
      setJobId(r.job.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not generate voice');
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate voice-over"
      description="ElevenLabs text-to-speech in English, Georgian or Russian (paid — the price is shown below)."
      footer={<Button onClick={go} disabled={!text.trim() || Boolean(jobId) || voices.data?.configured === false} loading={Boolean(jobId)}>Generate{estimate?.available ? ` · ≈ ${estimate.credits} credits` : ''}</Button>}
    >
      <div className="space-y-3">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} placeholder="Write the narration…" />
        <div className="grid grid-cols-2 gap-2">
          <NativeSelect value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language">{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</NativeSelect>
          <NativeSelect value={voiceId} onChange={(e) => setVoice(e.target.value)} aria-label="Voice">
            <option value="">Default voice</option>
            {voices.data?.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </NativeSelect>
        </div>
        {estimate && <p className="text-sm text-fog-300">≈ {estimate.credits} credits{estimate.available ? '' : ' — audio provider not configured'}</p>}
        {voices.data?.configured === false && <p className="text-sm text-signal-amber">Voice generation needs an ElevenLabs API key on the server. You can upload your own voice recording instead.</p>}
        {job && <p className="text-sm text-fog-300">{job.phase}</p>}
        <p className="text-xs text-fog-400">Voice cloning of real people requires their documented consent and is not offered by default.</p>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ transcription

export function TranscribeButton({ projectId, timeline, assets, onCues }: { projectId: string; timeline: Timeline; assets: Map<string, Asset>; onCues: (c: { startSec: number; endSec: number; text: string }[]) => void }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['transcript', jobId],
    queryFn: () => api<{ status: string; transcript: { cues: { startSec: number; endSec: number; text: string }[] } | null }>(`/api/audio/${jobId}/transcript`),
    enabled: Boolean(jobId),
    refetchInterval: (qq) => (qq.state.data?.status === 'completed' || qq.state.data?.status === 'failed' ? false : 3000),
  });
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (q.data?.status === 'completed' && q.data.transcript && handled.current !== jobId) {
      handled.current = jobId;
      onCues(q.data.transcript.cues);
      setJobId(null);
      toast.success('Subtitles created from speech');
    }
  }, [q.data, onCues, jobId]);
  const source = timeline.audio.find((a) => a.kind === 'voice')?.assetId ?? timeline.clips.find((c) => assets.get(c.assetId)?.source?.aiGenerated)?.assetId ?? timeline.clips[0]?.assetId;
  return (
    <Button
      size="sm"
      variant="outline"
      className="w-full"
      disabled={!source || Boolean(jobId)}
      loading={Boolean(jobId)}
      onClick={async () => {
        try {
          const r = await api<{ job: { id: string } }>('/api/audio', { body: { kind: 'transcribe', assetId: source, projectId, idempotencyKey: newKey() } });
          setJobId(r.job.id);
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : 'Transcription unavailable');
        }
      }}
    >
      <Captions /> Auto-subtitles from speech
    </Button>
  );
}

// ------------------------------------------------------------------ versions

export function VersionsDialog({ open, onOpenChange, projectId, onRestored }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string; onRestored: () => void }) {
  const { data, refetch } = useQuery({ queryKey: ['versions', projectId], queryFn: () => api<{ versions: { version: number; label: string | null; createdAt: string }[] }>(`/api/projects/${projectId}/versions`), enabled: open });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Version history" description="Every save is kept. Restoring makes a new version — nothing is lost.">
      <div className="space-y-1">
        {data?.versions.map((v) => (
          <div key={v.version} className="flex items-center justify-between rounded-xl px-3 py-2 hover:bg-white/5">
            <div>
              <div className="text-sm text-white">v{v.version} {v.label && <span className="text-fog-400">· {v.label}</span>}</div>
              <div className="text-xs text-fog-400">{new Date(v.createdAt).toLocaleString()}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={async () => { await api(`/api/projects/${projectId}/versions/${v.version}/restore`, { body: {} }); toast.success(`Restored v${v.version}`); void refetch(); onRestored(); onOpenChange(false); }}>Restore</Button>
          </div>
        ))}
        {!data?.versions.length && <p className="py-4 text-center text-sm text-fog-400">No saved versions yet.</p>}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ media picker

export type LibraryKind = 'clip' | 'replace' | 'audio' | 'logo' | 'overlay' | 'layer-image' | 'layer-video';

export function LibraryDialog({ kind, onClose, assets, onPick }: { kind: LibraryKind | null; onClose: () => void; assets: Asset[]; onPick: (a: Asset) => void }) {
  const list = assets.filter((a) => (kind === 'audio' ? a.mediaType === 'audio' : kind === 'logo' || kind === 'layer-image' ? a.mediaType === 'image' : kind === 'overlay' ? a.mediaType === 'image' || a.mediaType === 'video' : a.mediaType === 'video'));
  return (
    <Dialog open={Boolean(kind)} onOpenChange={(o) => !o && onClose()} title={kind === 'audio' ? 'Choose audio' : kind === 'logo' ? 'Choose logo' : kind === 'layer-image' ? 'Choose an image' : 'Choose a clip'} wide>
      <div className="grid grid-cols-3 gap-2 md:grid-cols-4">
        {list.map((a) => (
          <button key={a.id} type="button" onClick={() => onPick(a)} className="surface overflow-hidden rounded-xl text-left hover:border-iris-500/50">
            <div className="aspect-video bg-ink-800">
              {a.thumbnailUrl || a.mediaType === 'image' ? <img src={a.thumbnailUrl ?? a.url} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-fog-400"><AudioLines className="size-5" /></div>}
            </div>
            <div className="truncate px-2 py-1.5 text-[11px] text-fog-300">{a.originalName ?? `${a.kind} · ${seconds((a.durationMs ?? 0) / 1000)}`}{a.isFixture ? ' · fixture' : ''}</div>
          </button>
        ))}
      </div>
      {!list.length && <p className="text-sm text-fog-400">Nothing here yet — upload from the Media panel.</p>}
    </Dialog>
  );
}
