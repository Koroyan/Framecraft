'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AudioLines, Captions, Clapperboard, Monitor, Palette, Plus, Scissors, Smartphone, Square, Type } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type Project } from '@/lib/api';
import { Card, Skeleton } from '@/components/ui';
import { cn, timeAgo } from '@/lib/utils';

const FORMATS = [
  { aspect: '9:16', label: 'TikTok / Reels / Shorts', icon: Smartphone },
  { aspect: '16:9', label: 'YouTube / landscape', icon: Monitor },
  { aspect: '1:1', label: 'Square post', icon: Square },
  { aspect: '4:5', label: 'Instagram feed', icon: Smartphone },
] as const;

const FEATURES = [
  { icon: Scissors, label: 'Split, trim, speed, freeze, reverse' },
  { icon: AudioLines, label: 'Music, voice-over and cut-to-the-beat' },
  { icon: Captions, label: 'Auto captions in TikTok styles' },
  { icon: Type, label: 'Text styles, stickers and animations' },
  { icon: Palette, label: 'Filters, colour grading and LUTs' },
  { icon: Clapperboard, label: 'Transitions, PiP, green screen, tracking' },
];

/** Video Editor home: start a new edit from your own clips, or continue one. */
export default function EditHomePage() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['projects', 'edit'], queryFn: () => api<{ projects: Project[] }>('/api/projects?kind=edit') });
  const create = async (aspect: string) => {
    setBusy(aspect);
    try {
      const { project } = await api<{ project: { id: string } }>('/api/projects', { body: { title: `Edit · ${new Date().toLocaleDateString()}`, kind: 'edit', aspectRatio: aspect } });
      router.push(`/app/editor/${project.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not create the project');
      setBusy(null);
    }
  };
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="overflow-hidden rounded-3xl border hairline bg-gradient-to-br from-iris-500/15 via-transparent to-transparent p-6 md:p-8">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-iris-300">Video Editor</div>
        <h1 className="mt-1 text-2xl font-semibold text-white md:text-3xl">Edit your own videos</h1>
        <p className="mt-2 max-w-2xl text-sm text-fog-300">Everything you know from mobile editors — on a real multi-track timeline, with AI when you want it. Choose a format to start.</p>
        <div className="mt-5 grid grid-cols-2 gap-2 md:grid-cols-4">
          {FORMATS.map((f) => (
            <button key={f.aspect} type="button" disabled={Boolean(busy)} onClick={() => create(f.aspect)} className={cn('group flex flex-col items-start gap-2 rounded-2xl border hairline bg-ink-900/60 p-4 text-left transition hover:border-iris-400/60', busy === f.aspect && 'opacity-60')}>
              <span className="flex w-full items-center justify-between">
                <f.icon className="size-5 text-iris-300" />
                <Plus className="size-4 text-fog-500 group-hover:text-white" />
              </span>
              <span className="text-sm font-medium text-white">{f.aspect}</span>
              <span className="text-[11px] text-fog-400">{f.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.label} className="flex items-center gap-2 rounded-xl border hairline px-3 py-2.5 text-xs text-fog-200"><f.icon className="size-4 text-iris-300" />{f.label}</div>
        ))}
      </div>

      <div>
        <div className="mb-2 text-sm font-medium text-white">Recent edits</div>
        {q.isLoading && <Skeleton className="h-24" />}
        {!q.isLoading && !q.data?.projects.length && <p className="text-sm text-fog-400">No edits yet — pick a format above.</p>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(q.data?.projects ?? []).map((p) => (
            <Link key={p.id} href={`/app/editor/${p.id}`}>
              <Card className="overflow-hidden transition hover:border-white/25">
                <div className="aspect-video bg-ink-800">{p.thumbnailUrl ? <img src={p.thumbnailUrl} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-fog-500"><Scissors className="size-5" /></div>}</div>
                <div className="p-2.5">
                  <div className="truncate text-sm text-white">{p.title}</div>
                  <div className="text-[11px] text-fog-400">{p.aspectRatio} · {timeAgo(p.updatedAt ?? p.createdAt)}</div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
