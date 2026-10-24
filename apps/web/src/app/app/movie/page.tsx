'use client';

import Link from 'next/link';
import { Suspense, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Clapperboard, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { LANGUAGES, MOVIE_LENGTHS, QUALITY_MODE_INFO, QUALITY_MODES, STYLE_PRESETS, type AspectRatio, type QualityMode } from '@framecraft/shared';
import { api, endpoints, ApiError } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { Badge, Button, Card, Field, NativeSelect, PageHeader, Segmented, Switch, Textarea } from '@/components/ui';
import { newKey, timeAgo } from '@/lib/utils';
import { ReferencePhotos, type ReferencePhoto } from '@/components/studio/reference-photos';
import { MovieModeSwitch } from '@/components/chat/mode-switch';

function NewMovie() {
  const params = useSearchParams();
  const router = useRouter();
  const { data: me } = useMe();
  const maxLen = me?.plan?.limits.maxMovieSeconds ?? 30;
  const [idea, setIdea] = useState(params.get('idea') ?? '');
  const [lengthSec, setLength] = useState(Math.min(Number(params.get('length') ?? 60), maxLen) || 30);
  const [aspectRatio, setAspect] = useState<AspectRatio>((params.get('aspect') as AspectRatio) ?? '16:9');
  const [quality, setQuality] = useState<QualityMode>('balanced');
  const [style, setStyle] = useState('cinematic');
  const [language, setLanguage] = useState('en');
  const [withDialogue, setDialogue] = useState(true);
  const [withMusic, setMusic] = useState(true);
  const [keyframes, setKeyframes] = useState(true);
  const [mode, setMode] = useState<'auto' | 'director'>('director');
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<ReferencePhoto[]>([]);
  const ideaRef = useRef<HTMLTextAreaElement>(null);

  /** Insert a photo token at the cursor (or the end) of the story. */
  const insertToken = (token: string) => {
    const el = ideaRef.current;
    const start = el?.selectionStart ?? idea.length;
    const end = el?.selectionEnd ?? idea.length;
    const before = idea.slice(0, start);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${pad}${token} ${idea.slice(end)}`.replace(/\s+$/, ' ');
    setIdea(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = (before + pad + token).length + 1;
      el?.setSelectionRange(pos, pos);
    });
  };

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ projectId: string }>('/api/movies', { body: { brief: { idea, lengthSec, aspectRatio, quality, style, language, withDialogue, withMusic, keyframes, mode, references: photos.map((p) => ({ token: p.token, assetId: p.asset.id, note: p.note || undefined })) }, idempotencyKey: newKey() } });
      router.push(`/app/movie/${r.projectId}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start planning');
      setBusy(false);
    }
  };

  return (
    <Card className="p-5 md:p-6">
      <Textarea ref={ideaRef} value={idea} onChange={(e) => setIdea(e.target.value)} aria-label="Film story" placeholder="A 2-minute cinematic science-fiction film about a detective investigating a mysterious abandoned city…  Tip: add photos below and mention them as photo1, photo2 — e.g. “a detective who looks like photo1 lives in a house like photo2”." className="min-h-32 text-[16px]" />
      <div className="mt-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[13px] font-medium text-fog-300">Your photos <span className="font-normal text-fog-400">(optional)</span></div>
          <div className="text-xs text-fog-400">Use your own characters, places or products. No photos? The AI invents everything.</div>
        </div>
        <ReferencePhotos photos={photos} onChange={setPhotos} story={idea} onInsert={insertToken} />
      </div>
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <Field label="Length">
          <Segmented value={lengthSec} onChange={setLength} options={MOVIE_LENGTHS.map((l) => ({ value: l.seconds, label: l.seconds >= 60 ? `${l.seconds / 60} min` : `${l.seconds}s`, disabled: l.seconds > maxLen, hint: l.seconds > maxLen ? 'Upgrade for longer films' : l.label }))} size="sm" />
        </Field>
        <Field label="Format">
          <Segmented value={aspectRatio} onChange={setAspect} options={[{ value: '16:9', label: '16:9 Film' }, { value: '9:16', label: '9:16 Vertical' }, { value: '1:1', label: '1:1' }]} size="sm" />
        </Field>
        <Field label="Quality">
          <Segmented value={quality} onChange={setQuality} options={QUALITY_MODES.map((q) => ({ value: q, label: QUALITY_MODE_INFO[q].label, disabled: !(me?.plan?.limits.qualityModes ?? []).includes(q) }))} size="sm" />
        </Field>
        <Field label="Visual style">
          <NativeSelect value={style} onChange={(e) => setStyle(e.target.value)}>
            {STYLE_PRESETS.filter((s) => s.key !== 'auto').map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Dialogue language">
          <NativeSelect value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </NativeSelect>
        </Field>
        <div className="flex flex-col justify-end gap-3">
          <label className="flex items-center justify-between gap-3 text-sm text-fog-200">Dialogue <Switch checked={withDialogue} onCheckedChange={setDialogue} label="Dialogue" /></label>
          <label className="flex items-center justify-between gap-3 text-sm text-fog-200">Music score <Switch checked={withMusic} onCheckedChange={setMusic} label="Music" /></label>
          <label className="flex items-center justify-between gap-3 text-sm text-fog-200" title="Each shot's first frame is drawn with your characters' and locations' photos, then animated — faces stay consistent and cheaper image-to-video models can be used.">
            Keyframes first (consistent characters, lower cost) <Switch checked={keyframes} onCheckedChange={setKeyframes} label="Keyframes" />
          </label>
        </div>
      </div>
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {([
          ['auto', 'Auto Director', 'The AI plans everything. You review the budget and press start.'],
          ['director', 'Director Mode', 'Edit the screenplay, shots, camera, dialogue and models before generating.'],
        ] as const).map(([k, t, d]) => (
          <button key={k} type="button" onClick={() => setMode(k)} className={`rounded-2xl border p-4 text-left transition ${mode === k ? 'border-iris-500/60 bg-iris-500/10' : 'hairline'}`}>
            <div className="font-medium text-white">{t}</div>
            <div className="mt-1 text-sm text-fog-300">{d}</div>
          </button>
        ))}
      </div>
      <Button size="lg" className="mt-6" onClick={create} disabled={idea.trim().length < 10} loading={busy}>
        <Sparkles /> Write the screenplay
      </Button>
      <p className="mt-2 text-xs text-fog-400">Planning is inexpensive. Nothing is rendered until you approve the budget.</p>
    </Card>
  );
}

function MovieList() {
  const { data } = useQuery({ queryKey: ['projects', 'movie'], queryFn: () => endpoints.projects('?kind=movie') });
  if (!data?.projects.length) return null;
  return (
    <div className="mt-10">
      <h2 className="mb-4 text-lg font-semibold text-white">Your films</h2>
      <div className="grid gap-3 md:grid-cols-3">
        {data.projects.map((p) => (
          <Link key={p.id} href={`/app/movie/${p.id}`} className="surface rounded-2xl p-4 transition hover:border-white/15">
            <div className="flex items-center gap-2">
              <Clapperboard className="size-4 text-iris-300" />
              <div className="truncate font-medium text-white">{p.title}</div>
            </div>
            <div className="mt-2 flex gap-1.5">
              <Badge>{p.aspectRatio}</Badge>
              {p.plan?.source === 'offline' && <Badge tone="amber">offline plan</Badge>}
            </div>
            <div className="mt-2 text-xs text-fog-400">Updated {timeAgo(p.updatedAt)}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function MoviePage() {
  return (
    <div className="mx-auto max-w-4xl">
      <MovieModeSwitch mode="form" />
      <PageHeader eyebrow="AI Movie Maker" title="Tell a story. Get a film." description="The AI Director writes the screenplay, characters, locations and shot list. You review every shot and the budget before anything is rendered." />
      <Suspense>
        <NewMovie />
      </Suspense>
      <MovieList />
    </div>
  );
}
