'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Hash, Lightbulb, MessageSquareQuote, Type, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { LANGUAGES, SOCIAL_PLATFORMS, type SocialPlatform } from '@framecraft/shared';
import { api, ApiError } from '@/lib/api';
import { useTemplates } from '@/lib/hooks';
import { Badge, Button, Card, Field, NativeSelect, PageHeader, Segmented, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from '@/components/ui';

type Copy = { hooks: string[]; titles: string[]; caption: string; hashtags: string[]; script: string; source: string; notice?: string };
type Concept = { title: string; logline: string; hook: string; visualStyle: string; shots: { description: string; durationSec: number; camera: string }[]; whyItWorks: string };

const copyText = (t: string) => {
  void navigator.clipboard.writeText(t);
  toast.success('Copied');
};

function CopyRow({ text }: { text: string }) {
  return (
    <div className="group flex items-start justify-between gap-3 rounded-xl px-3 py-2 hover:bg-white/[0.04]">
      <span className="text-sm text-fog-100">{text}</span>
      <button type="button" aria-label="Copy" onClick={() => copyText(text)} className="text-fog-400 opacity-60 transition hover:text-white group-hover:opacity-100">
        <Copy className="size-4" />
      </button>
    </div>
  );
}

export default function SocialStudio() {
  const router = useRouter();
  const { data: templates } = useTemplates();
  const [platform, setPlatform] = useState<SocialPlatform>('tiktok');
  const [topic, setTopic] = useState('');
  const [language, setLanguage] = useState('en');
  const [tone, setTone] = useState('');
  const [copy, setCopy] = useState<Copy | null>(null);
  const [concepts, setConcepts] = useState<{ items: Concept[]; source: string } | null>(null);
  const [busy, setBusy] = useState<'copy' | 'concepts' | null>(null);
  const p = SOCIAL_PLATFORMS[platform];

  const run = async (kind: 'copy' | 'concepts') => {
    if (topic.trim().length < 3) return toast.error('Describe your idea or product first');
    setBusy(kind);
    try {
      if (kind === 'copy') setCopy(await api<Copy>('/api/director/social-copy', { body: { topic, platform, tone: tone || undefined, language, durationSec: 15 } }));
      else {
        const r = await api<{ concepts: Concept[]; source: string }>('/api/director/concepts', { body: { idea: topic, platform, durationSec: 15, language } });
        setConcepts({ items: r.concepts, source: r.source });
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow="Social Media Studio" title="Made for the feed" description="Pick a platform, start from a proven structure, and get hooks, captions and hashtags that fit." />
      <Card className="mb-6 p-4">
        <div className="mb-2 text-xs text-fog-400">Platform</div>
        <Segmented value={platform} onChange={setPlatform} options={(Object.keys(SOCIAL_PLATFORMS) as SocialPlatform[]).map((k) => ({ value: k, label: SOCIAL_PLATFORMS[k].label }))} size="sm" />
        <p className="mt-3 text-xs text-fog-400">
          {p.aspectRatio} · safe area keeps text clear of the {p.label} interface · up to {p.maxDurationSec >= 600 ? '10 min' : `${p.maxDurationSec}s`}
        </p>
      </Card>

      <Tabs defaultValue="templates">
        <TabsList>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="concepts">3 Creative Concepts</TabsTrigger>
          <TabsTrigger value="copy">Hooks, captions & hashtags</TabsTrigger>
        </TabsList>

        <TabsContent value="templates">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates?.templates
              .filter((t) => t.platforms.includes(platform) || platform === 'feed')
              .map((t) => (
                <Link key={t.key} href={`/app/create?template=${t.key}`} className="surface rounded-2xl p-4 transition hover:border-iris-500/40">
                  <div className="font-medium text-white">{t.name}</div>
                  <p className="mt-1 text-sm text-fog-300">{t.description}</p>
                  <div className="mt-3 flex gap-1.5">
                    <Badge>{t.defaults.durationSec}s</Badge>
                    <Badge>{t.workflow === 'multi-shot' ? `${t.beats.length} shots` : '1 clip'}</Badge>
                  </div>
                </Link>
              ))}
          </div>
        </TabsContent>

        {(['concepts', 'copy'] as const).map((tab) => (
          <TabsContent key={tab} value={tab}>
            <Card className="mb-5 grid gap-4 p-4 md:grid-cols-[1fr_200px_200px] md:items-end">
              <Field label={tab === 'concepts' ? 'Your idea' : 'Topic, product or message'}>
                <Textarea value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Handmade ceramic mugs from a small studio in Tbilisi" className="min-h-20" />
              </Field>
              <Field label="Language">
                <NativeSelect value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.label}</option>
                  ))}
                </NativeSelect>
              </Field>
              {tab === 'copy' ? (
                <Field label="Tone">
                  <NativeSelect value={tone} onChange={(e) => setTone(e.target.value)}>
                    <option value="">Authentic & energetic</option>
                    <option>Luxurious & minimal</option>
                    <option>Funny & playful</option>
                    <option>Professional & trustworthy</option>
                    <option>Emotional & heartfelt</option>
                  </NativeSelect>
                </Field>
              ) : (
                <div />
              )}
              <Button className="md:col-span-3 md:w-fit" onClick={() => run(tab)} loading={busy === tab}>
                {tab === 'concepts' ? <Lightbulb /> : <Wand2 />} {tab === 'concepts' ? 'Generate 3 concepts' : 'Write copy'}
              </Button>
            </Card>

            {tab === 'concepts' && concepts && (
              <div className="grid gap-4 md:grid-cols-3">
                {concepts.items.map((c) => (
                  <Card key={c.title} className="flex flex-col p-5">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-white">{c.title}</div>
                      {concepts.source === 'offline' && <Badge tone="amber">offline</Badge>}
                    </div>
                    <p className="mt-2 text-sm text-iris-300">“{c.hook}”</p>
                    <p className="mt-2 text-sm text-fog-300">{c.visualStyle}</p>
                    <ol className="mt-3 flex-1 space-y-1.5 text-xs text-fog-300">
                      {c.shots.map((s, i) => (
                        <li key={i}>
                          {i + 1}. {s.description} <span className="text-fog-400">({s.durationSec}s)</span>
                        </li>
                      ))}
                    </ol>
                    <p className="mt-3 text-xs text-fog-400">{c.whyItWorks}</p>
                    <Button className="mt-4" variant="secondary" onClick={() => router.push(`/app/create?prompt=${encodeURIComponent(`${c.logline} ${c.visualStyle}`)}`)}>
                      Use this concept
                    </Button>
                  </Card>
                ))}
              </div>
            )}

            {tab === 'copy' && copy && (
              <div className="grid gap-4 md:grid-cols-2">
                {copy.source === 'offline' && <p className="text-xs text-signal-amber md:col-span-2">{copy.notice ?? 'Offline planner used — connect the AI Director for tailored copy.'}</p>}
                <Card className="p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium text-white"><MessageSquareQuote className="size-4 text-iris-300" /> Hooks</div>
                  {copy.hooks.map((h) => <CopyRow key={h} text={h} />)}
                </Card>
                <Card className="p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium text-white"><Type className="size-4 text-iris-300" /> Titles</div>
                  {copy.titles.map((h) => <CopyRow key={h} text={h} />)}
                </Card>
                <Card className="p-4">
                  <div className="mb-2 text-sm font-medium text-white">Caption</div>
                  <CopyRow text={copy.caption} />
                  <div className="mb-2 mt-4 text-sm font-medium text-white">Voice-over script</div>
                  <CopyRow text={copy.script} />
                </Card>
                <Card className="p-4">
                  <div className="mb-2 flex items-center justify-between text-sm font-medium text-white">
                    <span className="flex items-center gap-2"><Hash className="size-4 text-iris-300" /> Hashtags</span>
                    <Button size="sm" variant="ghost" onClick={() => copyText(copy.hashtags.join(' '))}>Copy all</Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {copy.hashtags.map((h) => <Badge key={h} tone="iris">{h}</Badge>)}
                  </div>
                </Card>
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
      <p className="mt-8 text-xs text-fog-400">Direct publishing to TikTok, Instagram and YouTube requires approved platform API access and is not enabled — download your video and post it from the app.</p>
    </div>
  );
}
