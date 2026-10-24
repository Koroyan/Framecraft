import Link from 'next/link';
import { ArrowRight, Clapperboard, Coins, Film, Layers, MessageSquareText, Route, ShieldCheck, Sparkles, Wand2, Users, Scissors, Music2 } from 'lucide-react';
import { TEMPLATES } from '@framecraft/shared';
import { buttonVariants } from '@/components/variants';
import { FilmFrame } from '@/components/marketing/frames';
import { ModelCatalogSection, PricingSection } from '@/components/marketing/live-sections';
import { HeroPrompt } from '@/components/marketing/hero-prompt';
import { Logo } from '@/components/logo';
import { cn } from '@/lib/utils';

const FAQ = [
  {
    q: 'Do I need to know which AI model to use?',
    a: 'No. Describe your video and pick a quality mode. Framecraft checks every available model for the features you need (aspect ratio, length, audio, references) and chooses the least expensive one that meets the quality target. Advanced users can still pick a model manually.',
  },
  {
    q: 'How are credits priced?',
    a: 'Each clip is priced from the real provider cost of the chosen model plus a transparent platform margin. You see the exact credit estimate before anything is generated, and if the provider reports a lower actual cost, you are charged the lower amount.',
  },
  {
    q: 'What happens if a generation fails?',
    a: 'Reserved credits are returned automatically. Failed shots in a film can be regenerated individually — completed shots are never charged twice.',
  },
  {
    q: 'Can I keep characters consistent across scenes?',
    a: 'Create a character with reference images and a written look. Framecraft reuses them on every shot and prefers models with native reference support. AI consistency is strong but not guaranteed, so you can regenerate any shot.',
  },
  {
    q: 'Which languages are supported?',
    a: 'The studio supports English, Georgian and Russian for scripts, captions and voice-over (Georgian voice uses ElevenLabs v4-family models).',
  },
  {
    q: 'Can I use the videos commercially?',
    a: 'Paid plans include commercial use, subject to the terms of the underlying model providers and our content policy. You must own or have permission for anything you upload, including photos of people and voices.',
  },
];

const WORKFLOW_ICONS: Record<string, React.ReactNode> = {
  commerce: <Coins />,
  social: <Sparkles />,
  story: <Film />,
  education: <MessageSquareText />,
  music: <Music2 />,
  brand: <ShieldCheck />,
};

export default function LandingPage() {
  return (
    <div className="relative overflow-x-hidden">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b hairline bg-ink-950/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 md:px-8">
          <Link href="/" aria-label="Framecraft home">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-7 text-sm text-fog-300 md:flex">
            <a href="#studio" className="hover:text-white">Studio</a>
            <a href="#film" className="hover:text-white">AI Films</a>
            <a href="#models" className="hover:text-white">Models</a>
            <a href="#pricing" className="hover:text-white">Pricing</a>
            <a href="#faq" className="hover:text-white">FAQ</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/login" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>Sign in</Link>
            <Link href="/register" className={buttonVariants({ size: 'sm' })}>Start free</Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_0%,rgb(124_108_255/0.22),transparent_70%)]" />
        <div className="mx-auto grid max-w-7xl gap-12 px-4 pb-16 pt-14 md:px-8 md:pt-24 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div className="animate-fade-up">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border hairline bg-white/[0.03] px-3 py-1 text-xs text-fog-200">
              <Route className="size-3.5 text-iris-300" /> One studio · every leading AI video model · automatic routing
            </div>
            <h1 className="text-[44px] font-semibold leading-[1.02] tracking-tight text-white sm:text-6xl lg:text-[76px]">
              Make videos that look <span className="font-display italic text-gradient">expensive.</span>
              <br />
              Pay what they actually cost.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-fog-300">
              Describe a TikTok, an ad or a whole short film. Framecraft writes the plan, picks the best-value model for every shot, and hands you a finished, editable video.
            </p>
            <HeroPrompt />
            <p className="mt-3 text-xs text-fog-400">Free trial credits · no card required · you approve every cost before it is spent</p>
          </div>
          <div className="relative mx-auto w-full max-w-md lg:max-w-none">
            <div className="grid grid-cols-3 gap-3">
              <FilmFrame scene="tokyo" className="col-span-2 row-span-2 animate-float" />
              <FilmFrame scene="product" label={false} />
              <FilmFrame scene="desert" label={false} />
            </div>
            <p className="mt-3 text-center text-[11px] text-fog-400">Illustrative artwork — not AI output. Real generations appear in your studio.</p>
          </div>
        </div>
      </section>

      {/* Value props */}
      <section className="border-y hairline bg-ink-900/60">
        <div className="mx-auto grid max-w-7xl gap-px px-4 md:grid-cols-3 md:px-8">
          {[
            { icon: <Sparkles />, t: 'Quality first', d: 'A quality bar per mode — Economy to Cinematic. The router never silently downgrades your resolution, audio or reference needs.' },
            { icon: <Coins />, t: 'Lowest practical cost', d: 'Among models that meet the bar, the cheapest wins. Cheap drafts before expensive finals; regenerate one shot, not the whole film.' },
            { icon: <Wand2 />, t: 'Simple by default', d: 'One prompt, three taps. Advanced camera, lens, model and timeline controls are there when you want them.' },
          ].map((v) => (
            <div key={v.t} className="py-8 md:px-8 md:first:pl-0">
              <div className="mb-3 grid size-10 place-items-center rounded-xl bg-iris-500/12 text-iris-300 [&_svg]:size-5">{v.icon}</div>
              <h3 className="text-base font-semibold text-white">{v.t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-fog-300">{v.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Product demo: how routing works */}
      <section className="mx-auto max-w-7xl px-4 py-20 md:px-8 md:py-28">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-iris-300">How the engine thinks</div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-5xl">The right model for every shot.</h2>
            <p className="mt-4 text-fog-300">
              Every request is analysed for what it truly needs — people on screen, fast action, dialogue, length, format and references. Models that cannot deliver are filtered out; the cheapest model that clears the quality bar is chosen. You see the reasoning and the price before you start.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-fog-200">
              {['Hard requirements first: aspect, length, resolution, native audio, references', 'Quality tier per mode, raised automatically for complex human action', 'Price from each provider’s published rates, with safety buffers where prices are only partly confirmed', 'Long clips split into continuous segments only when that saves real money'].map((x) => (
                <li key={x} className="flex gap-3">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-iris-400" />
                  {x}
                </li>
              ))}
            </ul>
          </div>
          <div className="surface rounded-3xl p-5 md:p-6">
            <div className="text-[11px] uppercase tracking-wider text-fog-400">Example decision · illustration</div>
            <div className="mt-3 rounded-2xl bg-white/[0.03] p-4 text-[15px] text-white">“A realistic 10-second vertical video of a person walking through Tokyo at night”</div>
            <div className="mt-4 space-y-2 text-sm">
              {[
                ['Needs', 'text-to-video · 9:16 · 10s · ≥1080p (High)'],
                ['Detected', 'people on screen (complexity medium)'],
                ['Filtered out', '720p-only models · max-8s models (would need a seam with a person in frame)'],
                ['Chosen', 'Kling 3.0 Pro at 1080p — cheapest tier-5 option'],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3 rounded-xl border hairline px-3 py-2.5">
                  <span className="w-24 shrink-0 text-fog-400">{k}</span>
                  <span className="text-fog-100">{v}</span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-fog-400">Model choice depends on which providers are configured and current prices; quality tiers are provisional until real evaluations are recorded.</p>
          </div>
        </div>
      </section>

      {/* Sample gallery */}
      <section className="mx-auto max-w-7xl px-4 pb-20 md:px-8">
        <div className="mb-8 flex items-end justify-between gap-4">
          <h2 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">Made for the feed</h2>
          <span className="text-xs text-fog-400">Sample artwork, labelled — no fake outputs</span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
          {(['tokyo', 'ocean', 'product', 'forest', 'noir', 'desert'] as const).map((s) => (
            <FilmFrame key={s} scene={s} />
          ))}
        </div>
      </section>

      {/* Social studio */}
      <section id="studio" className="border-y hairline bg-ink-900/50 py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-4 md:px-8">
          <div className="max-w-2xl">
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-iris-300">Social Media Studio</div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-5xl">Templates that actually do the work.</h2>
            <p className="mt-4 text-fog-300">Each template carries a real structure — hook, hero, benefit, call-to-action — plus hooks, captions and hashtags. Generate three creative concepts for pennies, then spend on the one you love.</p>
          </div>
          <div className="mt-10 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {TEMPLATES.slice(0, 12).map((t) => (
              <Link key={t.key} href={`/register?template=${t.key}`} className="surface group rounded-2xl p-4 transition hover:border-iris-500/40">
                <div className="mb-3 grid size-9 place-items-center rounded-xl bg-white/[0.05] text-iris-300 [&_svg]:size-4">{WORKFLOW_ICONS[t.category]}</div>
                <div className="text-sm font-medium text-white">{t.name}</div>
                <div className="mt-1 line-clamp-2 text-xs text-fog-400">{t.description}</div>
                <div className="mt-3 text-[11px] text-fog-400">
                  {t.defaults.aspectRatio} · {t.defaults.durationSec}s · {t.beats.length} beat{t.beats.length > 1 ? 's' : ''}
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Film */}
      <section id="film" className="mx-auto max-w-7xl px-4 py-20 md:px-8 md:py-28">
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div className="grid grid-cols-2 gap-3">
            <FilmFrame scene="noir" aspect="16/9" className="col-span-2" />
            <FilmFrame scene="forest" aspect="16/9" label={false} />
            <FilmFrame scene="desert" aspect="16/9" label={false} />
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-iris-300">AI Movie Maker</div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-5xl">From one sentence to a finished short film.</h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              {[
                { i: <Clapperboard />, t: 'Screenplay & shot list', d: 'Scenes, shots, camera and dialogue written by the AI Director — fully editable in Director Mode.' },
                { i: <Users />, t: 'Character & location library', d: 'Reusable looks and references for continuity across every shot.' },
                { i: <Coins />, t: 'Budget before you spend', d: 'See the cost of every shot and the model mix. Nothing renders until you approve.' },
                { i: <Scissors />, t: 'A real editor', d: 'Trim, reorder, transitions, music, subtitles, text and brand logo — exported with FFmpeg.' },
              ].map((f) => (
                <div key={f.t} className="surface rounded-2xl p-4">
                  <div className="mb-2 text-iris-300 [&_svg]:size-5">{f.i}</div>
                  <div className="text-sm font-semibold text-white">{f.t}</div>
                  <p className="mt-1 text-sm text-fog-300">{f.d}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Models */}
      <section id="models" className="border-y hairline bg-ink-900/50 py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-4 md:px-8">
          <div className="mb-10 max-w-2xl">
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-iris-300">Model catalog</div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-5xl">Kling, Veo, Seedance, Wan, LTX, Runway & more.</h2>
            <p className="mt-4 text-fog-300">Live from our model registry: capabilities and published provider prices, verified against official documentation. Discontinued or unverified models are never used for generation.</p>
          </div>
          <ModelCatalogSection />
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-7xl px-4 py-20 md:px-8 md:py-28">
        <h2 className="text-center text-3xl font-semibold tracking-tight text-white md:text-5xl">How it works</h2>
        <div className="mt-12 grid gap-4 md:grid-cols-4">
          {[
            ['Describe', 'Type an idea, upload a photo or pick a template.'],
            ['Review', 'See the enhanced prompt, chosen model and credit estimate.'],
            ['Generate', 'Track the real job status; previews appear as soon as they exist.'],
            ['Edit & export', 'Trim, caption, add music and export for every platform.'],
          ].map(([t, d], i) => (
            <div key={t} className="surface rounded-2xl p-5">
              <div className="font-display text-4xl italic text-iris-300">{i + 1}</div>
              <div className="mt-3 font-semibold text-white">{t}</div>
              <p className="mt-1 text-sm text-fog-300">{d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t hairline py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-4 md:px-8">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">Simple plans. Honest credits.</h2>
            <p className="mt-3 text-fog-300">Every plan includes the full studio. Upgrade for more credits, higher quality modes and longer films.</p>
          </div>
          <PricingSection />
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="mx-auto max-w-3xl px-4 pb-24 md:px-8">
        <h2 className="mb-8 text-center text-3xl font-semibold tracking-tight text-white md:text-4xl">Questions</h2>
        <div className="space-y-2">
          {FAQ.map((f) => (
            <details key={f.q} className="surface group rounded-2xl px-5 py-4 open:bg-white/[0.04]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-white">
                {f.q}
                <span className="text-fog-400 transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-fog-300">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* CTA + footer */}
      <section className="px-4 pb-16 md:px-8">
        <div className="relative mx-auto max-w-7xl overflow-hidden rounded-3xl border border-iris-500/30 bg-gradient-to-br from-iris-600/25 via-ink-900 to-ink-900 px-6 py-14 text-center md:py-20">
          <h2 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">Your next video starts with one sentence.</h2>
          <Link href="/register" className={cn(buttonVariants({ size: 'xl', variant: 'white' }), 'mt-8')}>
            Start creating <ArrowRight />
          </Link>
        </div>
      </section>
      <footer className="border-t hairline">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10 text-sm text-fog-400 md:flex-row md:items-center md:justify-between md:px-8">
          <div className="flex items-center gap-3">
            <Logo small />
            <span>© {new Date().getFullYear()} Framecraft</span>
          </div>
          <div className="flex flex-wrap gap-5">
            <Link href="/legal/terms" className="hover:text-white">Terms</Link>
            <Link href="/legal/privacy" className="hover:text-white">Privacy</Link>
            <Link href="/legal/ai-policy" className="hover:text-white">AI content policy</Link>
            <span className="flex items-center gap-1.5">
              <Layers className="size-3.5" /> AI outputs are labelled as AI-generated
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
