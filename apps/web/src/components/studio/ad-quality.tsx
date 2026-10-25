'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Info, RefreshCw, ShieldCheck, Sparkles, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, Input, NativeSelect, Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';

/*
 * Verified quality of a rendered ad (measured from the file, product identity against the
 * original photos) and targeted revision requests. Predicted plan scores live elsewhere and are
 * labelled as predictions.
 */

type Issue = { severity: 'error' | 'warning' | 'info'; area: string; message: string; shot?: number; atSec?: number };
type Identity = { shot: number; atSec: number; method: 'vision' | 'colour'; verdict: 'consistent' | 'suspicious' | 'changed' | 'unchecked'; changes: string[]; colourDistance: number; aspects?: Record<string, string>; approved?: boolean };
type Report = { id: string; score: number; status: 'passed' | 'review_suggested' | 'needs_review'; issues: Issue[]; identity: Identity[]; identitySource: 'vision' | 'colour' | 'none'; measurements: { durationSec: number; shots: unknown[] }; createdAt: string };

const STATUS = { passed: { label: 'Quality check passed', tone: 'green' }, review_suggested: { label: 'Review suggested', tone: 'amber' }, needs_review: { label: 'Needs your review', tone: 'red' } } as const;
const AREA: Record<string, string> = { identity: 'Product', pacing: 'Pacing', repetition: 'Repetition', picture: 'Picture', audio: 'Audio', captions: 'Text', brand: 'Brand', story: 'Story' };

export function QualityPanel({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['quality', projectId],
    queryFn: () => api<{ report: Report | null; rendering: boolean }>(`/api/projects/${projectId}/quality`),
    refetchInterval: (qq) => (!qq.state.data?.report || qq.state.data.rendering ? 4000 : false),
  });
  const r = q.data?.report;
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await q.refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };
  if (!r)
    return (
      <Card className="flex items-center gap-2 p-4 text-sm text-fog-300">
        <Spinner /> Checking the finished video (picture, pacing, sound, text, brand and product accuracy)…
      </Card>
    );
  const s = STATUS[r.status];
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-white">
          <ShieldCheck className="size-4 text-iris-300" /> Verified quality · measured from the rendered video
          <Badge tone={s.tone}>{s.label}</Badge>
        </div>
        <div className="flex items-center gap-3">
          <span className={cn('text-lg font-semibold', r.score >= 85 ? 'text-signal-green' : r.score >= 65 ? 'text-signal-amber' : 'text-signal-red')}>{r.score}/100</span>
          <Button size="sm" variant="ghost" loading={busy === 'recheck'} onClick={() => run('recheck', () => api(`/api/projects/${projectId}/quality`, { body: {} }))}><RefreshCw /> Re-check</Button>
        </div>
      </div>
      {r.identity.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-fog-200">Product accuracy vs your photos {r.identitySource === 'vision' ? '(AI vision comparison)' : '(colour check only — AI vision not configured)'}</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {r.identity.map((x) => (
              <div key={x.shot} className={cn('rounded-lg border p-2 text-[11px]', x.approved ? 'border-signal-green/30' : x.verdict === 'changed' ? 'border-signal-red/40' : x.verdict === 'suspicious' ? 'border-signal-amber/40' : 'hairline')}>
                <div className="flex items-center justify-between">
                  <span className="text-fog-100">Shot {x.shot + 1} · {x.atSec.toFixed(1)} s</span>
                  <span className={cn(x.approved || x.verdict === 'consistent' ? 'text-signal-green' : x.verdict === 'changed' ? 'text-signal-red' : x.verdict === 'suspicious' ? 'text-signal-amber' : 'text-fog-500')}>{x.approved ? 'approved by you' : x.verdict}</span>
                </div>
                {x.aspects && <div className="mt-1 flex flex-wrap gap-1">{Object.entries(x.aspects).map(([k, v]) => <span key={k} className={cn('rounded px-1', v === 'changed' ? 'bg-signal-red/15 text-signal-red' : v === 'same' ? 'bg-white/5 text-fog-400' : 'bg-white/5 text-fog-500')}>{k}: {v}</span>)}</div>}
                {x.changes.map((c) => <div key={c} className="mt-1 text-fog-300">• {c}</div>)}
                {!x.approved && (x.verdict === 'changed' || x.verdict === 'suspicious') && (
                  <Button size="sm" variant="ghost" className="mt-1 h-7" loading={busy === `ok-${x.shot}`} onClick={() => run(`ok-${x.shot}`, () => api(`/api/projects/${projectId}/quality/${r.id}/approve`, { body: { shot: x.shot } }))}><CheckCircle2 /> It looks right — approve</Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <ul className="space-y-1">
        {r.issues.filter((i) => i.area !== 'identity').map((i, k) => (
          <li key={k} className={cn('flex items-start gap-1.5 text-xs', i.severity === 'error' ? 'text-signal-red' : i.severity === 'warning' ? 'text-signal-amber' : 'text-fog-300')}>
            {i.severity === 'info' ? <Info className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
            <span><b className="font-medium">{AREA[i.area] ?? i.area}:</b> {i.message}</span>
          </li>
        ))}
        {!r.issues.length && <li className="flex items-center gap-1.5 text-xs text-signal-green"><CheckCircle2 className="size-3.5" /> No problems found in the rendered video.</li>}
      </ul>
    </Card>
  );
}

const PRESETS = [
  { key: 'improve_hook', label: 'Improve the hook' },
  { key: 'more_emotional', label: 'Make it more emotional' },
  { key: 'more_details', label: 'Show more product details' },
  { key: 'shorten_ending', label: 'Shorten the logo ending' },
  { key: 'improve_shot', label: 'Improve shot…' },
] as const;
type Preset = (typeof PRESETS)[number]['key'];

/** Footage ads: free plan edits; the ad is then re-assembled (music and voice are reused). */
export function CampaignRevisions({ campaignId, shotCount, onDone }: { campaignId: string; shotCount: number; onDone: () => unknown }) {
  const [shot, setShot] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="space-y-2 rounded-xl border hairline p-3">
      <div className="text-xs font-medium text-fog-200">Request changes — only the affected shots change (free plan edits, then re-assemble)</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <Button
            key={p.key}
            size="sm"
            variant="ghost"
            loading={busy === p.key}
            onClick={async () => {
              setBusy(p.key);
              try {
                const r = await api<{ changes: string[]; replanned: boolean }>(`/api/ads/campaigns/${campaignId}/revise`, { body: { preset: p.key, ...(p.key === 'improve_shot' ? { shotIndex: shot } : {}) } });
                toast.success(r.replanned ? 'Re-planning with the emotional concept…' : `${r.changes.join(' · ')} — re-assemble to see it`);
                await onDone();
              } catch (e) {
                toast.error(e instanceof ApiError ? e.message : 'Could not change the plan');
              } finally {
                setBusy(null);
              }
            }}
          >
            <Wand2 /> {p.key === 'improve_shot' ? `Improve shot ${shot + 1}` : p.label}
          </Button>
        ))}
        <NativeSelect className="h-8 w-24" aria-label="Shot to improve" value={shot} onChange={(e) => setShot(Number(e.target.value))}>{Array.from({ length: shotCount }, (_, i) => <option key={i} value={i}>shot {i + 1}</option>)}</NativeSelect>
      </div>
    </div>
  );
}

type Proposal = { shots: { shotId: string; index: number; description: string; newPrompt: string | null; newDurationSec: number | null; credits: number }[]; totalCredits: number; free: boolean };

/** AI-scene ads: see exactly which shots change and their price, approve, then only those regenerate. */
export function SceneRevisions({ projectId, shotCount, onDone }: { projectId: string; shotCount: number; onDone: () => unknown }) {
  const [preset, setPreset] = useState<Preset>('improve_hook');
  const [shot, setShot] = useState(0);
  const [note, setNote] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const body = () => ({ preset, ...(preset === 'improve_shot' ? { shotIndex: shot } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-white"><Sparkles className="size-4 text-iris-300" /> Request changes</div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button key={p.key} type="button" onClick={() => { setPreset(p.key); setProposal(null); }} className={cn('rounded-lg border px-2.5 py-1 text-xs', preset === p.key ? 'border-iris-400 bg-iris-500/15 text-white' : 'hairline text-fog-300 hover:border-white/25')}>{p.label}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {preset === 'improve_shot' && <NativeSelect className="h-8 w-24" aria-label="Shot" value={shot} onChange={(e) => { setShot(Number(e.target.value)); setProposal(null); }}>{Array.from({ length: shotCount }, (_, i) => <option key={i} value={i}>shot {i + 1}</option>)}</NativeSelect>}
        {preset !== 'shorten_ending' && <Input className="h-8 min-w-60 flex-1" placeholder="Optional: what exactly should change" value={note} maxLength={500} onChange={(e) => { setNote(e.target.value); setProposal(null); }} />}
        <Button
          size="sm"
          variant="secondary"
          loading={busy && !proposal}
          onClick={async () => {
            setBusy(true);
            try {
              setProposal(await api<Proposal>(`/api/projects/${projectId}/ad-revise/propose`, { body: body() }));
              setAgree(false);
            } catch (e) {
              toast.error(e instanceof ApiError ? e.message : 'Could not prepare the change');
            } finally {
              setBusy(false);
            }
          }}
        >
          See what changes
        </Button>
      </div>
      {proposal && (
        <div className="space-y-2 rounded-xl bg-white/[0.03] p-3 text-xs text-fog-300">
          {proposal.shots.map((s) => (
            <div key={s.shotId}>
              <div className="text-fog-100">Shot {s.index + 1} — {s.description} · {s.credits ? `${s.credits} cr` : 'free'}</div>
              {s.newPrompt && <div className="line-clamp-3 text-fog-400">{s.newPrompt}</div>}
              {s.newDurationSec && <div className="text-fog-400">New length {s.newDurationSec} s</div>}
            </div>
          ))}
          <div className="text-fog-400">Every other shot stays exactly as it is.</div>
          {!proposal.free && (
            <label className="flex items-center gap-2 text-fog-200"><input type="checkbox" className="accent-iris-500" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I approve spending up to {proposal.totalCredits} credits for these shots.</label>
          )}
          <Button
            size="sm"
            disabled={!proposal.free && !agree}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/api/projects/${projectId}/ad-revise/apply`, { body: { ...body(), approvedCredits: proposal.totalCredits } });
                toast.success(proposal.free ? 'Re-rendering with the shorter ending' : 'Regenerating only these shots — re-render the ad in the editor when they are ready');
                setProposal(null);
                await onDone();
              } catch (e) {
                toast.error(e instanceof ApiError ? e.message : 'Could not apply the change');
              } finally {
                setBusy(false);
              }
            }}
          >
            {proposal.free ? 'Apply (free)' : `Apply · ${proposal.totalCredits} cr`}
          </Button>
        </div>
      )}
    </Card>
  );
}
