'use client';

import Link from 'next/link';
import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Check, Mic, Music, Plus, Smile, Sparkles, Users } from 'lucide-react';
import { toast } from 'sonner';
import { CARTOON_AUDIENCES, CARTOON_STYLES, protectedCharacterIn, type AspectRatio, type CartoonAudience, type CartoonStyleKey } from '@framecraft/shared';
import { api, ApiError, type Character } from '@/lib/api';
import { useBrandKits } from '@/lib/brand';
import { useMe } from '@/lib/hooks';
import { Button, PageHeader, Segmented, Textarea } from '@/components/ui';
import { cn, newKey } from '@/lib/utils';

/*
 * Create a Cartoon: one sentence, an original style, who it is for and who is in it. The AI Director
 * plans the story, characters, scenes, shots and dialogue (free); everything is then editable in the
 * storyboard and the story graph, and nothing is generated until you approve its price.
 */

/** An illustration of the style (drawn from its colours) — not an AI result. */
function StyleArt({ swatch, k }: { swatch: readonly string[]; k: string }) {
  const [a, b, c] = swatch;
  const flat = k === 'cartoon_vector' || k === 'cartoon_paper' || k === 'cartoon_comic';
  return (
    <svg viewBox="0 0 160 90" className="size-full" aria-hidden>
      <rect width="160" height="90" fill={c} />
      <circle cx="128" cy="22" r="12" fill={a} opacity={0.9} />
      <path d="M0 70 Q40 52 80 66 T160 60 V90 H0 Z" fill={b} opacity={flat ? 1 : 0.85} />
      <g transform="translate(58 30)">
        <rect x="6" y="14" width="30" height="30" rx={flat ? 4 : 14} fill={a} stroke={k === 'cartoon_comic' || k === 'cartoon_2d' ? '#111' : 'none'} strokeWidth="2" />
        <circle cx="21" cy="10" r="11" fill={a} stroke={k === 'cartoon_comic' || k === 'cartoon_2d' ? '#111' : 'none'} strokeWidth="2" />
        <circle cx="17" cy="9" r="2" fill="#111" />
        <circle cx="25" cy="9" r="2" fill="#111" />
        <path d="M16 14 Q21 18 26 14" stroke="#111" strokeWidth="1.6" fill="none" />
      </g>
      {k === 'cartoon_comic' && <g opacity="0.25">{Array.from({ length: 30 }).map((_, i) => <circle key={i} cx={(i % 10) * 16 + 8} cy={Math.floor(i / 10) * 10 + 6} r="2" fill="#111" />)}</g>}
      {k === 'cartoon_storybook' && <rect x="4" y="4" width="152" height="82" rx="6" fill="none" stroke="#fff" strokeOpacity="0.35" strokeDasharray="3 3" />}
    </svg>
  );
}

function NewCartoon() {
  const params = useSearchParams();
  const router = useRouter();
  const { data: me } = useMe();
  const maxLen = me?.plan?.limits.maxMovieSeconds ?? 30;
  const [idea, setIdea] = useState(params.get('idea') ?? '');
  const [style, setStyle] = useState<CartoonStyleKey>('cartoon_3d');
  const [lengthSec, setLength] = useState(Math.min(Number(params.get('length') ?? 45) || 45, maxLen));
  const [aspectRatio, setAspect] = useState<AspectRatio>((params.get('aspect') as AspectRatio) ?? '16:9');
  const [audience, setAudience] = useState<CartoonAudience>('family');
  const [voices, setVoices] = useState<'dialogue' | 'narration' | 'none'>('dialogue');
  const [language, setLanguage] = useState('en');
  const [cast, setCast] = useState<string[]>([]);
  const [brandId, setBrandId] = useState('');
  const [busy, setBusy] = useState(false);
  const chars = useQuery({ queryKey: ['characters'], queryFn: () => api<{ characters: Character[] }>('/api/characters') });
  const brands = useBrandKits();
  const blocked = useMemo(() => protectedCharacterIn(idea), [idea]);
  const [allCast, setAllCast] = useState(false);
  // Saved characters with an approved look first; one per name; narrators are voices, not cast.
  const castable = useMemo(() => {
    const seen = new Set<string>();
    return (chars.data?.characters ?? [])
      .filter((c) => !/^narrator$/i.test(c.name.trim()))
      .sort((a, b) => b.references.length - a.references.length)
      .filter((c) => {
        const k = c.name.trim().toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }, [chars.data]);
  const lengths = [15, 30, 45, 60, 90, 120, 180];

  const submit = async () => {
    if (blocked || idea.trim().length < 10) return;
    setBusy(true);
    try {
      const r = await api<{ projectId: string }>('/api/cartoons', {
        body: { idempotencyKey: newKey(), brief: { idea: idea.trim(), style, lengthSec: Math.min(lengthSec, maxLen), aspectRatio, audience, voices, language, characterIds: cast, ...(brandId ? { brandId } : {}) } },
      });
      toast.success('The AI Director is writing your cartoon — story, characters, scenes and shots.');
      router.push(`/app/movie/${r.projectId}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start the cartoon');
      setBusy(false);
    }
  };

  const section = 'rounded-2xl border hairline bg-ink-900/50 p-4';
  return (
    <div className="space-y-4">
      <div className={section}>
        <label htmlFor="cartoon-idea" className="text-sm font-medium text-white">Your idea</label>
        <Textarea
          id="cartoon-idea"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="e.g. A funny cartoon about a small robot who wants to become a chef"
          className="mt-2"
        />
        {blocked ? (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-signal-amber" role="alert">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> “{blocked}” is someone else’s character. Framecraft makes original characters — describe your own (it can look however you like).
          </p>
        ) : (
          <p className="mt-2 text-xs text-fog-500">Any language. The AI Director writes the story, the characters, the scenes and each shot — you can change all of it before anything is generated.</p>
        )}
      </div>

      <div className={section}>
        <div className="text-sm font-medium text-white">Style</div>
        <p className="mt-0.5 text-xs text-fog-500">Original looks — the cards are illustrations of the style, not AI results.</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" role="radiogroup" aria-label="Cartoon style">
          {CARTOON_STYLES.map((s) => (
            <button key={s.key} type="button" role="radio" aria-checked={style === s.key} onClick={() => setStyle(s.key)} className={cn('overflow-hidden rounded-xl border text-left transition', style === s.key ? 'border-iris-400 ring-2 ring-iris-500/30' : 'hairline hover:border-white/25')}>
              <div className="relative aspect-video">
                <StyleArt swatch={s.swatch} k={s.key} />
                {style === s.key && <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-iris-500 text-white"><Check className="size-3" /></span>}
              </div>
              <div className="p-2">
                <div className="text-xs font-medium text-white">{s.label}</div>
                <div className="truncate text-[10px] text-fog-400">{s.hint}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className={section}>
          <div className="text-sm font-medium text-white">Length and format</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {lengths.map((l) => (
              <button key={l} type="button" disabled={l > maxLen} aria-pressed={lengthSec === l} onClick={() => setLength(l)} title={l > maxLen ? `Your plan makes films up to ${maxLen} s` : undefined} className={cn('rounded-lg border px-2.5 py-1 text-xs disabled:opacity-35', lengthSec === l ? 'border-iris-400 bg-iris-500/20 text-white' : 'hairline text-fog-200 hover:border-white/25')}>{l < 60 ? `${l} s` : `${l / 60} min`}</button>
            ))}
          </div>
          <Segmented className="mt-3" size="sm" value={aspectRatio} onChange={(v) => setAspect(v)} options={[{ value: '16:9' as AspectRatio, label: '16:9 YouTube' }, { value: '9:16' as AspectRatio, label: '9:16 Reels · TikTok' }, { value: '1:1' as AspectRatio, label: '1:1 Square' }]} />
        </div>
        <div className={section}>
          <div className="text-sm font-medium text-white">Who is it for?</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {CARTOON_AUDIENCES.map((a) => (
              <button key={a.key} type="button" aria-pressed={audience === a.key} onClick={() => setAudience(a.key)} title={a.note} className={cn('rounded-lg border px-2.5 py-1 text-xs', audience === a.key ? 'border-iris-400 bg-iris-500/20 text-white' : 'hairline text-fog-200 hover:border-white/25')}>{a.label}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className={section}>
          <div className="text-sm font-medium text-white">Voices</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {([['dialogue', 'Characters talk', Mic], ['narration', 'A narrator tells it', Mic], ['none', 'Music only', Music]] as const).map(([k, label, Icon]) => (
              <button key={k} type="button" aria-pressed={voices === k} onClick={() => setVoices(k)} className={cn('flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs', voices === k ? 'border-iris-400 bg-iris-500/20 text-white' : 'hairline text-fog-200 hover:border-white/25')}><Icon className="size-3" /> {label}</button>
            ))}
          </div>
          <Segmented className="mt-3" size="sm" value={language} onChange={(v) => setLanguage(v)} options={[{ value: 'en', label: 'English' }, { value: 'ka', label: 'ქართული' }, { value: 'ru', label: 'Русский' }]} />
          <p className="mt-2 text-[11px] text-fog-500">Each character keeps one voice in every scene. Georgian and Russian lines are voiced by a speech model and lip-synced where the video model supports it.</p>
        </div>
        <div className={section}>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-white">Cast <span className="font-normal text-fog-500">(optional)</span></div>
            <Link href="/app/characters" className="flex items-center gap-1 text-xs text-iris-200 hover:text-white"><Plus className="size-3" /> New character</Link>
          </div>
          {castable.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {castable.slice(0, allCast ? 60 : 12).map((c) => {
                const on = cast.includes(c.id);
                return (
                  <button key={c.id} type="button" aria-pressed={on} disabled={!on && cast.length >= 6} onClick={() => setCast((x) => (on ? x.filter((y) => y !== c.id) : [...x, c.id]))} className={cn('flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs disabled:opacity-40', on ? 'border-iris-400 bg-iris-500/20 text-white' : 'hairline text-fog-200 hover:border-white/25')}>
                    {c.references[0] ? <img src={c.references[0].url} alt="" className="size-6 rounded-full object-cover" /> : <span className="grid size-6 place-items-center rounded-full bg-iris-500/40 text-[10px] text-white">{c.name.slice(0, 1)}</span>}
                    {c.name}
                  </button>
                );
              })}
              {castable.length > 12 && (
                <button type="button" onClick={() => setAllCast((v) => !v)} className="rounded-full px-2 py-0.5 text-xs text-iris-200 hover:text-white">{allCast ? 'Fewer' : `All ${castable.length}`}</button>
              )}
            </div>
          ) : (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-fog-500"><Users className="size-3.5" /> No saved characters yet — the AI Director designs them, and you can save them later.</p>
          )}
          {(brands.data?.brandKits.length ?? 0) > 0 && (
            <label className="mt-3 block text-xs text-fog-400">
              Brand film <span className="text-fog-500">(uses only your approved brand facts, logo and colours)</span>
              <select value={brandId} onChange={(e) => setBrandId(e.target.value)} className="mt-1 w-full rounded-lg border hairline bg-black/30 px-2.5 py-1.5 text-xs text-white">
                <option value="">Not a brand film</option>
                {brands.data!.brandKits.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-iris-400/30 bg-iris-500/[0.06] p-4">
        <div className="text-xs text-fog-300">
          <div className="flex items-center gap-1.5 text-sm font-medium text-white"><Sparkles className="size-4 text-iris-300" /> Planning is free</div>
          Story, characters, scenes, shots and dialogue appear in the storyboard. Storyboard frames and video show their price and start only when you approve.
        </div>
        <Button onClick={submit} loading={busy} disabled={Boolean(blocked) || idea.trim().length < 10}>
          <Smile /> Plan my cartoon
        </Button>
      </div>
    </div>
  );
}

export default function CartoonPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader eyebrow="Create a cartoon" title="From one sentence to an animated film" description="An original style, your own characters, a story told scene by scene — and an AI Director beside every shot to change anything." />
      <Suspense>
        <NewCartoon />
      </Suspense>
    </div>
  );
}
