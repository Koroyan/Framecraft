'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Clapperboard, ImagePlus, LayoutList, Megaphone, Package, Stamp, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Button, Skeleton, Spinner, buttonVariants } from '@/components/ui';
import { useUploader } from '@/components/studio/upload';
import { timeAgo } from '@/lib/utils';
import { BudgetCard, ConceptsCard, FilmCard, ScreenplayCard, type AdConcept } from './cards';

type Attachment = { assetId: string; kind: 'photo' | 'logo' | 'product'; token?: string };
type Message = { id: string; role: 'user' | 'assistant'; content: string; attachments: Attachment[]; card: Record<string, unknown> | null; createdAt: string };
type ChatData = {
  session: { id: string; kind: 'movie' | 'ad'; title: string; projectId: string | null; lang: string; business: Record<string, unknown> | null; logoAssetId: string | null; thinking?: boolean };
  messages: Message[];
  assetUrls: Record<string, string>;
};
type Pending = { assetId: string; kind: Attachment['kind']; url: string };

const STARTERS = {
  movie: ['A short love story in old Tbilisi, 45 seconds', 'An epic fantasy trailer, 30 s, vertical for TikTok', 'ნინო და გიორგი ზღვის პირას — რომანტიკული ფილმი, 1 წუთი'],
  ad: ['I run a coffee shop in Tbilisi — make a 15 s Reels ad', 'Our online store sells handmade jewelry', 'PIJILO — 3D ფიგურები ფოტოდან, TikTok რეკლამა 15 წამი'],
};

/**
 * Chat with the AI Director (films) or the Ad Studio creative director (ads). Messages can carry
 * cards — screenplay, budget, live production, ad ideas — that keep updating in place.
 */
export function ChatView({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const key = ['chat', sessionId];
  // Replies are written in the background (a model call can take a minute); poll while the AI is thinking.
  const q = useQuery({ queryKey: key, queryFn: () => api<ChatData>(`/api/chat/sessions/${sessionId}`), refetchInterval: (query) => (query.state.data?.session.thinking ? 1500 : false) });
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [sending, setSending] = useState<{ content: string; attachments: Pending[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const uploader = useUploader({ kind: 'reference' });

  const d = q.data;
  const thinking = Boolean(sending || d?.session.thinking);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [d?.messages.length, thinking]);
  // Count how long the AI has been thinking, to reassure on slow replies (ad ideas take longest).
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    setWaited(0);
    if (!thinking) {
      void qc.invalidateQueries({ queryKey: ['chat-sessions'] });
      return;
    }
    const t = setInterval(() => setWaited((w) => w + 1), 1000);
    return () => clearInterval(t);
  }, [thinking, qc]);

  const apply = (next: ChatData) => qc.setQueryData(key, next);

  const send = async (content = text) => {
    const body = { content: content.trim(), attachments: pending.map((p) => ({ assetId: p.assetId, kind: p.kind })) };
    if ((!body.content && !body.attachments.length) || thinking) return;
    setSending({ content: body.content, attachments: pending });
    setText('');
    setPending([]);
    try {
      apply(await api<ChatData>(`/api/chat/sessions/${sessionId}/messages`, { body }));
      void qc.invalidateQueries({ queryKey: ['chat-sessions'] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Message not sent');
      setText(body.content);
      setPending(pending);
    } finally {
      setSending(null);
      input.current?.focus();
    }
  };

  const action = async (type: string, extra: Record<string, unknown> = {}, tag = type) => {
    setBusy(tag);
    try {
      apply(await api<ChatData>(`/api/chat/sessions/${sessionId}/actions`, { body: { type, ...extra } }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const attach = async (kind: Attachment['kind']) => {
    const a = await uploader.pick();
    if (a) setPending((p) => [...p, { assetId: a.id, kind, url: a.url }]);
  };

  if (!d) return <Skeleton className="mx-auto h-[70dvh] max-w-3xl" />;
  const isAd = d.session.kind === 'ad';
  const last = d.messages.at(-1);
  const suggestions = thinking ? [] : last?.role === 'assistant' && last.card?.type === 'suggestions' ? (last.card.items as string[]) : d.messages.length <= 1 ? STARTERS[d.session.kind] : [];

  const renderCard = (m: Message) => {
    const c = m.card;
    if (!c) return null;
    switch (c.type) {
      case 'screenplay':
        return <ScreenplayCard projectId={c.projectId as string} planJobId={c.planJobId as string} busy={busy === 'approve_screenplay'} onApprove={() => action('approve_screenplay')} />;
      case 'budget':
        return <BudgetCard projectId={c.projectId as string} onStarted={() => action('generation_started')} />;
      case 'film':
        return <FilmCard projectId={c.projectId as string} />;
      case 'concepts':
        return (
          <ConceptsCard
            concepts={c.concepts as AdConcept[]}
            busy={busy === 'new_concepts' ? 'more' : busy?.startsWith('concept:') ? Number(busy.split(':')[1]) : null}
            onChoose={(i) => action('choose_concept', { index: i }, `concept:${i}`)}
            onMore={() => action('new_concepts')}
          />
        );
      default:
        return null;
    }
  };

  const Avatar = isAd ? Megaphone : Clapperboard;
  const thumb = (a: Attachment) => d.assetUrls[a.assetId];

  return (
    <div className="mx-auto flex h-[calc(100dvh-9rem)] max-w-3xl flex-col md:h-[calc(100dvh-7rem)]">
      {uploader.element}
      <div className="flex items-center justify-between gap-3 pb-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-iris-300">{isAd ? 'Ad Studio' : 'AI Movie Maker · Chat'}</div>
          <h1 className="truncate text-lg font-semibold text-white">{d.session.title}</h1>
        </div>
        <div className="flex shrink-0 gap-2">
          {d.session.projectId && (
            <Link href={`/app/movie/${d.session.projectId}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              <LayoutList /> Shots
            </Link>
          )}
          <Link href={isAd ? '/app/ads' : '/app/movie/chat'} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            All chats
          </Link>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto rounded-2xl border hairline bg-ink-900/40 p-3 md:p-5" aria-live="polite">
        {d.messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex flex-col items-end">
              {m.attachments.length > 0 && (
                <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
                  {m.attachments.map((a) => (
                    <figure key={a.assetId} className="relative">
                      {thumb(a) ? <img src={thumb(a)} alt="" className="size-16 rounded-xl object-cover" /> : <div className="size-16 rounded-xl bg-ink-800" />}
                      <figcaption className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[9px] text-white">{a.kind === 'logo' ? 'logo' : a.token}</figcaption>
                    </figure>
                  ))}
                </div>
              )}
              {m.content && <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-iris-500 px-4 py-2.5 text-sm text-white">{m.content}</div>}
            </div>
          ) : (
            <div key={m.id} className="flex gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-iris-500/15 text-iris-300">
                <Avatar className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                {m.content && <div className="whitespace-pre-wrap text-sm leading-relaxed text-fog-100">{m.content}</div>}
                {renderCard(m)}
              </div>
            </div>
          ),
        )}
        {sending && (
            <div className="flex flex-col items-end opacity-80">
              {sending.attachments.length > 0 && (
                <div className="mb-1.5 flex gap-1.5">
                  {sending.attachments.map((a) => (
                    <img key={a.assetId} src={a.url} alt="" className="size-16 rounded-xl object-cover" />
                  ))}
                </div>
              )}
              {sending.content && <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-iris-500 px-4 py-2.5 text-sm text-white">{sending.content}</div>}
            </div>
        )}
        {thinking && (
          <div className="flex gap-3 text-sm text-fog-300">
            <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-iris-500/15 text-iris-300">
              <Avatar className="size-4" />
            </span>
            <div className="pt-1.5">
              <div className="flex items-center gap-2">
                <Spinner /> {isAd ? 'Thinking about your brand…' : 'The AI Director is thinking…'}
              </div>
              {waited >= 12 && <div className="mt-1 text-xs text-fog-400">{isAd ? 'Writing ad ideas takes up to a minute' : 'Longer answers take up to a minute'} — you can leave this page, the reply will be here.</div>}
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      {suggestions.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pt-3">
          {suggestions.map((s) => (
            <button key={s} type="button" onClick={() => send(s)} className="shrink-0 rounded-full border hairline bg-white/[0.03] px-3 py-1.5 text-xs text-fog-200 transition hover:border-white/25 hover:text-white">
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        className="mt-3 rounded-2xl border hairline bg-ink-900 p-2 focus-within:border-iris-400/60"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1 pb-2">
            {pending.map((p) => (
              <span key={p.assetId} className="relative">
                <img src={p.url} alt="" className="size-14 rounded-lg object-cover" />
                <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 text-[9px] text-white">{p.kind}</span>
                <button type="button" aria-label="Remove" onClick={() => setPending((x) => x.filter((y) => y.assetId !== p.assetId))} className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-ink-700 text-fog-100">
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={isAd ? 'Tell me about your business, paste links, attach your logo…' : 'Describe your film, or tell me what to change…'}
          className="max-h-40 w-full resize-none bg-transparent px-2 py-1.5 text-sm text-white placeholder:text-fog-400 focus:outline-none"
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1">
            {isAd ? (
              <>
                <Button type="button" size="sm" variant="ghost" onClick={() => attach('logo')} title="Attach your logo">
                  <Stamp /> Logo
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => attach('product')} title="Attach product photos">
                  <Package /> Product
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" variant="ghost" onClick={() => attach('photo')} title="Attach a photo (photo1, photo2…)">
                <ImagePlus /> Photo
              </Button>
            )}
          </div>
          <Button type="submit" size="icon" disabled={thinking || (!text.trim() && !pending.length)} aria-label="Send">
            {thinking ? <Spinner /> : <ArrowUp />}
          </Button>
        </div>
      </form>
      {!d.messages.some((m) => m.card?.type === 'film') && <p className="pt-1.5 text-center text-[11px] text-fog-400">Nothing is generated or charged until you approve the budget.</p>}
    </div>
  );
}

/** Start page for a kind: what it does, a big "new conversation" button, and earlier conversations. */
export function ChatHome({ kind }: { kind: 'movie' | 'ad' }) {
  const router = useRouter();
  const q = useQuery({ queryKey: ['chat-sessions', kind], queryFn: () => api<{ sessions: { id: string; title: string; updatedAt: string; projectId: string | null }[] }>(`/api/chat/sessions?kind=${kind}`) });
  const [creating, setCreating] = useState(false);
  const base = kind === 'ad' ? '/app/ads' : '/app/movie/chat';
  const create = async () => {
    setCreating(true);
    try {
      const r = await api<ChatData>('/api/chat/sessions', { body: { kind } });
      router.push(`${base}/${r.session.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start a conversation');
      setCreating(false);
    }
  };
  const steps =
    kind === 'ad'
      ? ['Tell me about your business and paste your links', 'Attach your logo and product photos', 'Pick one of three ad ideas', 'Approve the budget — the ad is made with voice-over, music and your logo']
      : ['Describe your story (photos optional)', 'Review the characters and screenplay — change anything by chatting', 'Approve the budget', 'Watch every step; the film opens in the editor'];
  const Icon = kind === 'ad' ? Megaphone : Clapperboard;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="surface rounded-3xl p-6 md:p-8">
        <span className="grid size-11 place-items-center rounded-2xl bg-iris-500/15 text-iris-300">
          <Icon className="size-5" />
        </span>
        <h1 className="mt-4 text-2xl font-semibold text-white md:text-3xl">{kind === 'ad' ? 'Make video ads by chatting' : 'Make a film by chatting with the AI Director'}</h1>
        <ol className="mt-4 grid gap-2 text-sm text-fog-200 sm:grid-cols-2">
          {steps.map((s, i) => (
            <li key={s} className="flex gap-2.5 rounded-xl bg-white/[0.03] p-3">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-iris-500/25 text-[11px] text-iris-100">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <Button size="lg" className="mt-5" onClick={create} loading={creating}>
          <Icon /> {kind === 'ad' ? 'New ad conversation' : 'New film conversation'}
        </Button>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-medium text-fog-300">Earlier conversations</h2>
        {!q.data ? (
          <Skeleton className="h-24" />
        ) : !q.data.sessions.length ? (
          <p className="text-sm text-fog-400">None yet.</p>
        ) : (
          <div className="divide-y divide-white/5 overflow-hidden rounded-2xl border hairline">
            {q.data.sessions.map((s) => (
              <Link key={s.id} href={`${base}/${s.id}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition hover:bg-white/[0.03]">
                <span className="min-w-0 truncate text-fog-100">{s.title}</span>
                <span className="shrink-0 text-xs text-fog-400">{timeAgo(s.updatedAt)}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
