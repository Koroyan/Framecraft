'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Clapperboard, Copy, Hash, Lightbulb, Megaphone, MessageSquareQuote, Monitor, RectangleVertical, ShoppingBag, Smartphone, Sparkles, Square, Type, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { LANGUAGES, SOCIAL_PLATFORMS, type SocialPlatform } from '@framecraft/shared';
import { api, ApiError } from '@/lib/api';
import { useTemplates } from '@/lib/hooks';
import { Badge, Button, Card, NativeSelect, PageHeader, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';

type PostCopy = { hooks: string[]; titles: string[]; caption: string; hashtags: string[]; script: string; source: string; notice?: string };
type Concept = { title: string; logline: string; hook: string; visualStyle: string; shots: { description: string; durationSec: number; camera: string }[]; whyItWorks: string };

const GOALS = [
  { key: 'sell', label: 'Sell a product', icon: ShoppingBag },
  { key: 'grow', label: 'Grow followers', icon: Sparkles },
  { key: 'announce', label: 'Announce news', icon: Megaphone },
  { key: 'teach', label: 'Teach something', icon: Lightbulb },
  { key: 'story', label: 'Tell a story', icon: Clapperboard },
] as const;
const TONES = ['Authentic & energetic', 'Luxurious & minimal', 'Funny & playful', 'Professional & trustworthy', 'Emotional & heartfelt'] as const;
const LENGTHS = [8, 15, 30, 60] as const;
const EXAMPLES = ['Handmade ceramic mugs from a small studio in Tbilisi', 'Our café now opens at 7 am — fresh khachapuri every morning', '3 mistakes people make when learning Georgian'];

const copyText = (t: string) => {
  void navigator.clipboard.writeText(t);
  toast.success('Copied');
};

const ASPECT_CLASS: Record<string, string> = { '9:16': 'aspect-[9/16]', '4:5': 'aspect-[4/5]', '16:9': 'aspect-video', '1:1': 'aspect-square' };
const PLATFORM_ICON: Record<string, typeof Smartphone> = { '9:16': Smartphone, '4:5': RectangleVertical, '16:9': Monitor, '1:1': Square };

/** A neutral phone-style frame: the hook sits inside the platform's safe area, as it would in the post. */
function PostPreview({ platform, hook, caption, tags, className }: { platform: SocialPlatform; hook: string; caption?: string; tags?: string[]; className?: string }) {
  const p = SOCIAL_PLATFORMS[platform];
  const s = p.safeArea;
  return (
    <div className={cn('relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-iris-700/50 via-ink-800 to-ink-950', ASPECT_CLASS[p.aspectRatio], className)}>
      {/* Areas the app's own buttons and captions cover. */}
      <div className="absolute inset-x-0 top-0 bg-black/25" style={{ height: `${s.top * 100}%` }} />
      <div className="absolute inset-x-0 bottom-0 bg-black/35" style={{ height: `${s.bottom * 100}%` }} />
      <div className="absolute right-0 bg-black/20" style={{ top: `${s.top * 100}%`, bottom: `${s.bottom * 100}%`, width: `${s.right * 100}%` }} />
      <div className="absolute flex items-center justify-center p-1 text-center" style={{ top: `${s.top * 100}%`, bottom: `${s.bottom * 100}%`, left: `${s.left * 100}%`, right: `${s.right * 100}%` }}>
        <span className="line-clamp-4 text-[clamp(10px,1.4vw,15px)] font-extrabold leading-tight text-white [text-shadow:0_2px_8px_rgba(0,0,0,0.8)]">{hook || 'Your hook appears here'}</span>
      </div>
      {(caption || tags?.length) && (
        <div className="absolute inset-x-0 bottom-0 space-y-0.5 p-2 text-[9px] leading-snug text-white/90" style={{ maxHeight: `${s.bottom * 100}%` }}>
          {caption && <p className="line-clamp-2">{caption}</p>}
          {tags?.length ? <p className="truncate font-semibold text-white">{tags.slice(0, 4).join(' ')}</p> : null}
        </div>
      )}
      <span className="absolute left-2 top-2 rounded-full bg-black/50 px-1.5 py-0.5 text-[9px] font-medium text-white/80">{p.aspectRatio}</span>
    </div>
  );
}

function CopyRow({ text, onPick, picked }: { text: string; onPick?: () => void; picked?: boolean }) {
  return (
    <div className={cn('group flex items-start justify-between gap-3 rounded-xl px-3 py-2', picked ? 'bg-iris-500/15' : 'hover:bg-white/[0.04]')}>
      <button type="button" disabled={!onPick} onClick={onPick} className="min-w-0 flex-1 text-left text-sm text-fog-100 disabled:cursor-text" title={onPick ? 'Show in the preview' : undefined}>
        {picked && <Check className="mr-1.5 inline size-3.5 text-iris-300" />}
        {text}
      </button>
      <button type="button" aria-label="Copy" onClick={() => copyText(text)} className="shrink-0 text-fog-400 opacity-60 transition hover:text-white group-hover:opacity-100">
        <Copy className="size-4" />
      </button>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition', on ? 'border-iris-400/60 bg-iris-500/15 text-white' : 'hairline text-fog-300 hover:border-white/25 hover:text-white')}>
      {children}
    </button>
  );
}

export default function SocialStudio() {
  const router = useRouter();
  const { data: templates } = useTemplates();
  const [platform, setPlatform] = useState<SocialPlatform>('tiktok');
  const [topic, setTopic] = useState('');
  const [goal, setGoal] = useState<(typeof GOALS)[number]['key']>('sell');
  const [tone, setTone] = useState<string>(TONES[0]);
  const [language, setLanguage] = useState('en');
  const [length, setLength] = useState<number>(15);
  const [postCopy, setPostCopy] = useState<PostCopy | null>(null);
  const [concepts, setConcepts] = useState<{ items: Concept[]; source: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [hookPick, setHookPick] = useState<string | null>(null);
  const [allFormats, setAllFormats] = useState(false);
  const p = SOCIAL_PLATFORMS[platform];
  const lengths = LENGTHS.filter((l) => l <= p.maxDurationSec);
  const goalLabel = GOALS.find((g) => g.key === goal)!.label;

  const plan = async () => {
    if (topic.trim().length < 3) return toast.error('Write what the post is about first');
    setBusy(true);
    setHookPick(null);
    const idea = `${topic.trim()} (goal: ${goalLabel.toLowerCase()})`;
    // Both are text-only AI Director calls (no video credits); either may fail on its own.
    const [c, k] = await Promise.allSettled([
      api<{ concepts: Concept[]; source: string }>('/api/director/concepts', { body: { idea, platform, durationSec: Math.min(length, 120), language } }),
      api<PostCopy>('/api/director/social-copy', { body: { topic: idea, platform, tone: `${tone}; goal: ${goalLabel}`, language, durationSec: length } }),
    ]);
    if (c.status === 'fulfilled') setConcepts({ items: c.value.concepts, source: c.value.source });
    if (k.status === 'fulfilled') setPostCopy(k.value);
    const err = [c, k].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (err) toast.error(err.reason instanceof ApiError ? err.reason.message : 'Part of the plan could not be made — try again');
    setBusy(false);
    if (c.status === 'fulfilled' || k.status === 'fulfilled') requestAnimationFrame(() => document.getElementById('social-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const previewHook = hookPick ?? postCopy?.hooks[0] ?? concepts?.items[0]?.hook ?? (topic.trim() ? topic.trim().slice(0, 80) : '');
  const fullPost = postCopy ? `${hookPick ?? postCopy.hooks[0] ?? ''}\n\n${postCopy.caption}\n\n${postCopy.hashtags.join(' ')}`.trim() : '';
  const create = (c: Concept) => router.push(`/app/create?prompt=${encodeURIComponent(`${c.logline} ${c.visualStyle}`)}&aspect=${encodeURIComponent(p.aspectRatio)}&duration=${length}`);
  const film = (c: Concept) => router.push(`/app/movie?idea=${encodeURIComponent(`${c.logline}\n\n${c.shots.map((s, i) => `${i + 1}. ${s.description}`).join('\n')}`)}&length=${Math.max(30, length)}&aspect=${encodeURIComponent(p.aspectRatio)}`);
  const formats = (templates?.templates ?? []).filter((t) => t.platforms.includes(platform) || platform === 'feed');

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow="Social Media Studio" title="From an idea to a ready post" description="Say what the post is about. You get three video concepts, a hook that stops the scroll, a caption and hashtags — sized and safe-zoned for the platform." />

      {/* 1 · Brief */}
      <Card className="mb-8 grid gap-6 p-4 md:p-5 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-5">
          <div>
            <div className="mb-2 text-xs font-medium text-fog-300">Where will it be posted?</div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {(Object.keys(SOCIAL_PLATFORMS) as SocialPlatform[]).map((k) => {
                const pl = SOCIAL_PLATFORMS[k];
                const Icon = PLATFORM_ICON[pl.aspectRatio] ?? Smartphone;
                return (
                  <button key={k} type="button" aria-pressed={platform === k} onClick={() => { setPlatform(k); if (length > pl.maxDurationSec) setLength(LENGTHS.filter((l) => l <= pl.maxDurationSec).at(-1) ?? 15); }} className={cn('flex flex-col items-center gap-1.5 rounded-xl border px-2 py-2.5 text-center transition', platform === k ? 'border-iris-400/60 bg-iris-500/15 text-white' : 'hairline text-fog-300 hover:border-white/25 hover:text-white')}>
                    <Icon className={cn('size-4', platform === k && 'text-iris-300')} />
                    <span className="text-[11px] leading-tight">{pl.label}</span>
                    <span className="text-[10px] text-fog-500">{pl.aspectRatio}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="social-topic" className="mb-2 block text-xs font-medium text-fog-300">What is the post about?</label>
            <Textarea id="social-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Your product, offer, news or idea — in any language" className="min-h-24 text-[15px]" maxLength={2000} />
            {!topic && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" onClick={() => setTopic(ex)} className="rounded-full bg-white/[0.04] px-2.5 py-1 text-[11px] text-fog-400 hover:bg-white/[0.08] hover:text-white">{ex}</button>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 text-xs font-medium text-fog-300">Goal</div>
            <div className="flex flex-wrap gap-1.5">
              {GOALS.map((g) => (
                <Chip key={g.key} on={goal === g.key} onClick={() => setGoal(g.key)}><g.icon className="size-3.5" /> {g.label}</Chip>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium text-fog-300">Tone</div>
            <div className="flex flex-wrap gap-1.5">
              {TONES.map((t) => <Chip key={t} on={tone === t} onClick={() => setTone(t)}>{t}</Chip>)}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div>
              <div className="mb-2 text-xs font-medium text-fog-300">Video length</div>
              <div className="flex gap-1.5">
                {lengths.map((l) => <Chip key={l} on={length === l} onClick={() => setLength(l)}>{l}s</Chip>)}
              </div>
            </div>
            <label className="block w-44">
              <span className="mb-2 block text-xs font-medium text-fog-300">Language of the text</span>
              <NativeSelect value={language} onChange={(e) => setLanguage(e.target.value)} className="h-9 text-sm">
                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </NativeSelect>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t hairline pt-4">
            <Button size="lg" onClick={plan} loading={busy} disabled={topic.trim().length < 3}><Wand2 /> Plan my post</Button>
            <span className="text-[11px] text-fog-500">Writes concepts and copy with the AI Director — text only, no video credits are spent.</span>
          </div>
        </div>

        <div className="hidden lg:block">
          <div className="mb-2 text-xs font-medium text-fog-300">Preview</div>
          <PostPreview platform={platform} hook={previewHook} caption={postCopy?.caption} tags={postCopy?.hashtags} className={cn(p.aspectRatio === '16:9' ? 'mt-16' : 'mx-auto', p.aspectRatio === '9:16' && 'max-h-[440px]')} />
          <p className="mt-2 text-[11px] leading-snug text-fog-500">Darker bands are covered by the {p.label} interface — text stays in the clear middle. Up to {p.maxDurationSec >= 600 ? '10 min' : `${p.maxDurationSec}s`}.</p>
        </div>
      </Card>

      {/* 2 · Results */}
      {busy && !concepts && (
        <div className="mb-8 grid gap-4 md:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-80 rounded-2xl" />)}</div>
      )}

      {(concepts || postCopy) && (
        <div id="social-results" className="mb-10 scroll-mt-6 space-y-8">
          {concepts && (
            <section>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-semibold text-white">Pick a concept</h2>
                {concepts.source === 'offline' && <Badge tone="amber">offline planner — connect the AI Director for tailored ideas</Badge>}
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                {concepts.items.map((c) => {
                  const total = c.shots.reduce((s, x) => s + x.durationSec, 0) || 1;
                  return (
                    <Card key={c.title} className="flex flex-col p-4">
                      <div className="flex gap-3">
                        <PostPreview platform={platform} hook={c.hook} className={cn('shrink-0', p.aspectRatio === '16:9' ? 'w-36' : 'w-24')} />
                        <div className="min-w-0">
                          <div className="font-semibold leading-snug text-white">{c.title}</div>
                          <p className="mt-1 text-xs text-fog-300">{c.logline}</p>
                          <p className="mt-1.5 text-[11px] text-fog-500">{c.visualStyle}</p>
                        </div>
                      </div>
                      <div className="mt-4 flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
                        {c.shots.map((s, i) => <span key={i} className={cn('h-full', i % 2 ? 'bg-iris-400/60' : 'bg-iris-300')} style={{ width: `${(s.durationSec / total) * 100}%` }} />)}
                      </div>
                      <ol className="mt-3 flex-1 space-y-1.5 text-xs text-fog-300">
                        {c.shots.map((s, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="w-4 shrink-0 tabular-nums text-fog-500">{i + 1}</span>
                            <span className="min-w-0">{s.description} <span className="text-fog-500">· {s.durationSec}s{s.camera ? ` · ${s.camera}` : ''}</span></span>
                          </li>
                        ))}
                      </ol>
                      <p className="mt-3 rounded-lg bg-white/[0.03] px-2.5 py-2 text-[11px] leading-snug text-fog-400"><span className="text-fog-200">Why it works · </span>{c.whyItWorks}</p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button className="flex-1" onClick={() => create(c)}><Wand2 /> Create this video</Button>
                        {c.shots.length > 1 && <Button variant="secondary" onClick={() => film(c)} title="Plan every shot as a short film with the same characters"><Clapperboard /> As a film</Button>}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </section>
          )}

          {postCopy && (
            <section>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-lg font-semibold text-white">Post copy</h2>
                {postCopy.source === 'offline' && <span className="text-xs text-signal-amber">{postCopy.notice ?? 'Offline planner used — connect the AI Director for tailored copy.'}</span>}
              </div>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Card className="p-4">
                  <div className="mb-1 flex items-center gap-2 text-sm font-medium text-white"><MessageSquareQuote className="size-4 text-iris-300" /> Hooks <span className="text-[11px] font-normal text-fog-500">· first 2 seconds — click one to preview it</span></div>
                  {postCopy.hooks.map((h) => <CopyRow key={h} text={h} picked={(hookPick ?? postCopy.hooks[0]) === h} onPick={() => setHookPick(h)} />)}
                  <div className="mb-1 mt-4 flex items-center gap-2 text-sm font-medium text-white"><Type className="size-4 text-iris-300" /> Titles</div>
                  {postCopy.titles.map((h) => <CopyRow key={h} text={h} />)}
                </Card>
                <Card className="flex flex-col p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-white">Ready to paste</span>
                    <Button size="sm" onClick={() => copyText(fullPost)}><Copy /> Copy post</Button>
                  </div>
                  <pre className="flex-1 whitespace-pre-wrap rounded-xl border hairline bg-ink-950 p-3 font-sans text-sm leading-relaxed text-fog-100">{fullPost}</pre>
                  <div className="mb-2 mt-4 flex items-center justify-between text-sm font-medium text-white">
                    <span className="flex items-center gap-2"><Hash className="size-4 text-iris-300" /> Hashtags</span>
                    <Button size="sm" variant="ghost" onClick={() => copyText(postCopy.hashtags.join(' '))}>Copy all</Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">{postCopy.hashtags.map((h) => <Badge key={h} tone="iris">{h}</Badge>)}</div>
                  <div className="mb-1 mt-4 text-sm font-medium text-white">Voice-over script</div>
                  <CopyRow text={postCopy.script} />
                  <p className="mt-1 px-3 text-[11px] text-fog-500">Turn it into speech in the editor: Audio → Generate voice-over (Georgian works too).</p>
                </Card>
              </div>
            </section>
          )}
        </div>
      )}

      {/* 3 · Proven formats */}
      <section>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Or start from a proven format</h2>
          <span className="text-xs text-fog-500">{formats.length} formats for {p.label}</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {formats.slice(0, allFormats ? undefined : 6).map((t) => (
            <Link key={t.key} href={`/app/create?template=${t.key}`} className="surface group flex gap-3 rounded-2xl p-3.5 transition hover:border-iris-500/40">
              <span className={cn('grid w-11 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-iris-600/40 to-ink-800 text-iris-200', ASPECT_CLASS[p.aspectRatio] ?? 'aspect-[9/16]', p.aspectRatio === '16:9' && 'w-16')}>
                {t.workflow === 'multi-shot' ? <Clapperboard className="size-4" /> : <Sparkles className="size-4" />}
              </span>
              <span className="min-w-0">
                <span className="block font-medium text-white group-hover:text-iris-100">{t.name}</span>
                <span className="mt-0.5 line-clamp-2 block text-xs text-fog-400">{t.description}</span>
                <span className="mt-2 flex gap-1.5">
                  <Badge>{t.defaults.durationSec}s</Badge>
                  <Badge>{t.workflow === 'multi-shot' ? `${t.beats.length} shots` : '1 clip'}</Badge>
                </span>
              </span>
            </Link>
          ))}
        </div>
        {formats.length > 6 && (
          <button type="button" onClick={() => setAllFormats((v) => !v)} className="mt-3 text-sm text-iris-300 hover:text-white">{allFormats ? 'Show fewer' : `Show all ${formats.length}`}</button>
        )}
      </section>
      <p className="mt-8 text-xs text-fog-400">Direct publishing to TikTok, Instagram and YouTube needs approved platform API access and is not enabled — download your video and post it from the app.</p>
    </div>
  );
}
