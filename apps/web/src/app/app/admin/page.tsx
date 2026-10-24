'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { Badge, Button, Card, Field, Input, NativeSelect, PageHeader, Skeleton, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { cn, formatCredits, formatUsd, newKey, timeAgo } from '@/lib/utils';

type Overview = {
  overview: {
    users: { total: number; active7: number; new7: number; new30: number };
    generations: { total: number; completed: number; failed: number; cancelled: number; active: number };
    costs: { providerCostUsd30d: number; avgCostPerGenerationUsd: number; providerSpendTodayUsd: number; byModel: { modelKey: string; jobs: number; succeeded: number; costUsd: number }[]; byProvider: { providerKey: string; jobs: number; costUsd: number }[] };
    credits: { creditsCaptured: number; creditsPurchased: number; creditsGranted: number; creditsRefunded: number };
    margin: { creditRevenueUsd: number; grossMarginPct: number | null };
    usageByPlan: { plan: string; users: number }[];
    queue: { queue: string; status: string; count: number }[];
    storage: { gb: number; files: number };
    config: { liveGenerationEnabled: boolean; configuredProviders: string[]; fixtures: boolean };
  };
  planMargins: { key: string; name: string; pricePerCreditUsd: number | null; worstCaseMarginPct: number | null; belowMinimum: boolean }[];
};
type ModelRow = { key: string; providerKey: string; displayName: string; status: string; enabled: boolean; qualityTier: number; qualitySource: string; verifiedAt: string | null; notes: string | null; pricing: { resolution: string; audio: boolean; usdPerSecond: number; confidence: string; source: string | null }[] };

const err = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Request failed');

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-fog-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</div>
      {sub && <div className="text-xs text-fog-400">{sub}</div>}
    </Card>
  );
}

function OverviewTab() {
  const { data } = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api<Overview>('/api/admin/overview'), refetchInterval: 20_000 });
  if (!data) return <Skeleton className="h-96" />;
  const o = data.overview;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <Badge tone={o.config.liveGenerationEnabled ? 'green' : 'amber'}>Live generation {o.config.liveGenerationEnabled ? 'on' : 'off'}</Badge>
        <Badge>Providers: {o.config.configuredProviders.join(', ') || 'none'}</Badge>
        {o.config.fixtures && <Badge tone="amber">Dev fixtures enabled</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Users" value={o.users.total} sub={`${o.users.active7} active (7d) · ${o.users.new7} new (7d)`} />
        <Stat label="Generations (30d)" value={o.generations.total} sub={`${o.generations.completed} ok · ${o.generations.failed} failed · ${o.generations.active} running`} />
        <Stat label="Provider cost (30d)" value={formatUsd(o.costs.providerCostUsd30d)} sub={`${formatUsd(o.costs.providerSpendTodayUsd)} today · avg ${formatUsd(o.costs.avgCostPerGenerationUsd, 3)}`} />
        <Stat label="Gross margin (30d)" value={o.margin.grossMarginPct === null ? '—' : `${o.margin.grossMarginPct}%`} sub={`${formatUsd(o.margin.creditRevenueUsd)} credit value charged`} />
        <Stat label="Credits charged" value={formatCredits(o.credits.creditsCaptured)} sub={`${formatCredits(o.credits.creditsRefunded)} refunded`} />
        <Stat label="Credits sold" value={formatCredits(o.credits.creditsPurchased)} sub={`${formatCredits(o.credits.creditsGranted)} granted free`} />
        <Stat label="Storage" value={`${o.storage.gb} GB`} sub={`${o.storage.files} files`} />
        <Stat label="Plans" value={o.usageByPlan.map((p) => `${p.plan}: ${p.users}`).join(' · ') || '—'} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium text-white">Cost by model (30d)</div>
          {o.costs.byModel.map((m) => (
            <div key={m.modelKey} className="flex justify-between border-t hairline py-1.5 text-sm">
              <span className="text-fog-200">{m.modelKey}</span>
              <span className="tabular-nums text-fog-300">{m.succeeded}/{m.jobs} ok · {formatUsd(m.costUsd)}</span>
            </div>
          ))}
          {!o.costs.byModel.length && <p className="text-sm text-fog-400">No paid generations yet.</p>}
        </Card>
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium text-white">Queue health</div>
          {o.queue.map((q) => (
            <div key={q.queue + q.status} className="flex justify-between border-t hairline py-1.5 text-sm">
              <span className="text-fog-200">{q.queue} · {q.status}</span>
              <span className="tabular-nums text-fog-300">{q.count}</span>
            </div>
          ))}
          <div className="mb-2 mt-4 text-sm font-medium text-white">Plan margins (worst case)</div>
          {data.planMargins.map((p) => (
            <div key={p.key} className="flex justify-between border-t hairline py-1.5 text-sm">
              <span className="text-fog-200">{p.name}</span>
              <span className={cn('tabular-nums', p.belowMinimum ? 'text-signal-red' : 'text-fog-300')}>{p.worstCaseMarginPct === null ? '—' : `${p.worstCaseMarginPct}%`} {p.pricePerCreditUsd ? `· ${formatUsd(p.pricePerCreditUsd, 4)}/cr` : ''}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

function ModelsTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin', 'models'], queryFn: () => api<{ providers: { key: string; displayName: string; enabled: boolean; configured: boolean }[]; models: ModelRow[] }>('/api/admin/models') });
  const [edit, setEdit] = useState<Record<string, string>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'models'] });
  if (!data) return <Skeleton className="h-96" />;
  return (
    <div className="space-y-5">
      <Card className="divide-y divide-white/5">
        {data.providers.map((p) => (
          <div key={p.key} className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-white">{p.displayName}</div>
              <div className="text-xs text-fog-400">{p.configured ? 'credentials present' : 'no credentials'}</div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={async () => { try { const r = await api<{ ok: boolean; message: string }>(`/api/admin/providers/${p.key}/check`, { body: {} }); toast[r.ok ? 'success' : 'error'](r.message); } catch (e) { err(e); } }}>Check</Button>
              <Switch checked={p.enabled} onCheckedChange={async (v) => { await api(`/api/admin/providers/${p.key}`, { method: 'PATCH', body: { enabled: v } }); void refresh(); }} label={`Enable ${p.displayName}`} />
            </div>
          </div>
        ))}
      </Card>
      <div className="space-y-2">
        {data.models.filter((m) => !['image', 'audio'].includes((m as unknown as { kind?: string }).kind ?? 'video')).map((m) => (
          <Card key={m.key} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white">{m.displayName}</div>
                <div className="text-xs text-fog-400">{m.key} · verified {m.verifiedAt ?? '—'} · tier {m.qualityTier} ({m.qualitySource})</div>
              </div>
              <div className="flex items-center gap-2">
                <NativeSelect className="h-8 w-32 text-xs" value={m.status} onChange={async (e) => { try { await api(`/api/admin/models/${m.key}`, { method: 'PATCH', body: { status: e.target.value } }); void refresh(); } catch (x) { err(x); } }}>
                  {['active', 'preview', 'unverified', 'deprecated', 'discontinued'].map((s) => <option key={s}>{s}</option>)}
                </NativeSelect>
                <Input className="h-8 w-16 text-xs" type="number" min={1} max={5} step={0.5} aria-label="Quality tier" defaultValue={m.qualityTier} onBlur={async (e) => { if (Number(e.target.value) !== m.qualityTier) { await api(`/api/admin/models/${m.key}`, { method: 'PATCH', body: { qualityTier: Number(e.target.value) } }); void refresh(); } }} />
                <Switch checked={m.enabled} onCheckedChange={async (v) => { await api(`/api/admin/models/${m.key}`, { method: 'PATCH', body: { enabled: v } }); void refresh(); }} label={`Enable ${m.displayName}`} />
              </div>
            </div>
            {m.notes && <p className="mt-2 text-xs text-fog-400">{m.notes}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {m.pricing.map((p) => {
                const k = `${m.key}|${p.resolution}|${p.audio}`;
                const audio = p.source?.endsWith(':any-audio') ? 'any' : p.audio;
                return (
                  <div key={k} className="flex items-center gap-1.5 rounded-lg border hairline px-2 py-1 text-xs">
                    <span className="text-fog-300">{p.resolution}{audio === true ? ' +audio' : audio === 'any' ? '' : ' no-audio'}</span>
                    <input className="w-16 rounded bg-white/5 px-1 py-0.5 text-white" aria-label="USD per second" defaultValue={p.usdPerSecond} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
                    <span className="text-fog-400">$/s</span>
                    <Badge tone={p.confidence === 'verified' ? 'green' : p.confidence === 'partial' ? 'amber' : 'red'}>{p.confidence}</Badge>
                    {edit[k] !== undefined && (
                      <button
                        type="button"
                        className="text-iris-300"
                        onClick={async () => {
                          try {
                            await api(`/api/admin/models/${m.key}/pricing`, { method: 'PUT', body: { resolution: p.resolution, audio, usdPerSecond: Number(edit[k]), confidence: 'verified' } });
                            toast.success('Price updated (marked verified)');
                            setEdit((x) => { const n = { ...x }; delete n[k]; return n; });
                            void refresh();
                          } catch (e) { err(e); }
                        }}
                      >
                        save
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ConfigTab() {
  const keys = ['pricing', 'routing', 'spending'] as const;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {keys.map((k) => <ConfigCard key={k} name={k} />)}
    </div>
  );
}

function ConfigCard({ name }: { name: 'pricing' | 'routing' | 'spending' }) {
  const { data, refetch } = useQuery({ queryKey: ['admin', 'config', name], queryFn: () => api<{ value: Record<string, unknown> }>(`/api/admin/config/${name}`) });
  const [text, setText] = useState<string | null>(null);
  const value = text ?? (data ? JSON.stringify(data.value, null, 2) : '');
  return (
    <Card className="flex flex-col p-4">
      <div className="mb-2 text-sm font-medium capitalize text-white">{name}</div>
      <textarea aria-label={`${name} config`} value={value} onChange={(e) => setText(e.target.value)} className="min-h-72 flex-1 rounded-xl border hairline bg-black/30 p-3 font-mono text-xs text-fog-100" spellCheck={false} />
      <Button
        size="sm"
        className="mt-3"
        onClick={async () => {
          try {
            await api(`/api/admin/config/${name}`, { method: 'PUT', body: JSON.parse(value) });
            setText(null);
            void refetch();
            toast.success('Saved');
          } catch (e) {
            if (e instanceof SyntaxError) toast.error('Invalid JSON');
            else err(e);
          }
        }}
      >
        Save {name}
      </Button>
    </Card>
  );
}

function PlansTab() {
  const { data, refetch } = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api<{ plans: { key: string; name: string; priceCents: number; monthlyCredits: number; active: boolean }[] }>('/api/admin/plans') });
  const tpl = useQuery({ queryKey: ['admin', 'templates'], queryFn: () => api<{ templates: { key: string; name: string; enabled: boolean; featured: boolean }[] }>('/api/admin/templates') });
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card className="divide-y divide-white/5">
        {data?.plans.map((p) => (
          <div key={p.key} className="grid grid-cols-[1fr_90px_90px_auto] items-center gap-2 px-4 py-3">
            <span className="text-sm text-white">{p.name}</span>
            <Input className="h-8 text-xs" type="number" aria-label="Price cents" defaultValue={p.priceCents} onBlur={async (e) => { await api(`/api/admin/plans/${p.key}`, { method: 'PATCH', body: { priceCents: Number(e.target.value) } }).catch(err); void refetch(); }} />
            <Input className="h-8 text-xs" type="number" aria-label="Monthly credits" defaultValue={p.monthlyCredits} onBlur={async (e) => { await api(`/api/admin/plans/${p.key}`, { method: 'PATCH', body: { monthlyCredits: Number(e.target.value) } }).catch(err); void refetch(); }} />
            <Switch checked={p.active} onCheckedChange={async (v) => { await api(`/api/admin/plans/${p.key}`, { method: 'PATCH', body: { active: v } }); void refetch(); }} label="Active" />
          </div>
        ))}
        <p className="px-4 py-2 text-xs text-fog-400">Price in cents · monthly credits · active. Check plan margins on the Overview tab after changes.</p>
      </Card>
      <Card className="divide-y divide-white/5">
        {tpl.data?.templates.map((t) => (
          <div key={t.key} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
            <span className="text-fog-100">{t.name}</span>
            <div className="flex items-center gap-3 text-xs text-fog-400">
              featured <Switch checked={t.featured} onCheckedChange={async (v) => { await api(`/api/admin/templates/${t.key}`, { method: 'PATCH', body: { featured: v } }); void tpl.refetch(); }} label="Featured" />
              on <Switch checked={t.enabled} onCheckedChange={async (v) => { await api(`/api/admin/templates/${t.key}`, { method: 'PATCH', body: { enabled: v } }); void tpl.refetch(); }} label="Enabled" />
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function UsersTab() {
  const [q, setQ] = useState('');
  const { data, refetch } = useQuery({ queryKey: ['admin', 'users', q], queryFn: () => api<{ users: { id: string; email: string; name: string; role: string; status: string; balance: number; createdAt: string }[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`) });
  const [credit, setCredit] = useState<Record<string, string>>({});
  return (
    <div className="space-y-3">
      <Input placeholder="Search email or name" value={q} onChange={(e) => setQ(e.target.value)} />
      <Card className="divide-y divide-white/5">
        {data?.users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm text-white">{u.email}</div>
              <div className="text-xs text-fog-400">{u.name} · {formatCredits(u.balance)} credits · joined {timeAgo(u.createdAt)}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect className="h-8 w-24 text-xs" value={u.role} onChange={async (e) => { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }).catch(err); void refetch(); }}>
                <option>user</option>
                <option>admin</option>
              </NativeSelect>
              <NativeSelect className="h-8 w-28 text-xs" value={u.status} onChange={async (e) => { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { status: e.target.value } }).catch(err); void refetch(); }}>
                <option>active</option>
                <option>suspended</option>
              </NativeSelect>
              <Input className="h-8 w-20 text-xs" type="number" placeholder="±cr" aria-label="Credit adjustment" value={credit[u.id] ?? ''} onChange={(e) => setCredit({ ...credit, [u.id]: e.target.value })} />
              <Button size="sm" variant="secondary" disabled={!Number(credit[u.id])} onClick={async () => { try { await api(`/api/admin/users/${u.id}/credits`, { body: { amount: Number(credit[u.id]), reason: 'Admin adjustment', idempotencyKey: newKey() } }); setCredit({ ...credit, [u.id]: '' }); void refetch(); toast.success('Adjusted'); } catch (e) { err(e); } }}>Apply</Button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function JobsTab() {
  const { data, refetch } = useQuery({ queryKey: ['admin', 'failed'], queryFn: () => api<{ jobs: { id: string; email: string; modelKey: string | null; providerKey: string | null; error: { message: string } | null; chargedCredits: number | null; createdAt: string; prompt: string | null }[] }>('/api/admin/jobs/failed') });
  const [evalForm, setEval] = useState({ modelKey: '', jobId: '', overall: '4', category: 'general', notes: '' });
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <Card className="divide-y divide-white/5">
        {data?.jobs.map((j) => (
          <div key={j.id} className="px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-white">{j.email} · {j.modelKey}</span>
              <span className="text-xs text-fog-400">{timeAgo(j.createdAt)}</span>
            </div>
            <p className="mt-1 text-xs text-signal-red">{j.error?.message}</p>
            <p className="mt-1 line-clamp-1 text-xs text-fog-400">{j.prompt}</p>
            {Boolean(j.chargedCredits) && <Button size="sm" variant="ghost" className="mt-1 px-0" onClick={async () => { try { await api(`/api/admin/jobs/${j.id}/refund`, { body: { reason: 'Admin refund after review' } }); toast.success('Refunded'); void refetch(); } catch (e) { err(e); } }}>Refund {j.chargedCredits} credits</Button>}
          </div>
        ))}
        {!data?.jobs.length && <p className="p-6 text-center text-sm text-fog-400">No failed jobs.</p>}
      </Card>
      <Card className="space-y-3 p-4">
        <div className="text-sm font-medium text-white">Record a quality evaluation</div>
        <p className="text-xs text-fog-400">Real ratings of real generations. Once a model has enough ratings, routing uses the measured score instead of the provisional tier.</p>
        <Field label="Model key"><Input value={evalForm.modelKey} onChange={(e) => setEval({ ...evalForm, modelKey: e.target.value })} placeholder="runway:kling3.0_pro" /></Field>
        <Field label="Job id (optional)"><Input value={evalForm.jobId} onChange={(e) => setEval({ ...evalForm, jobId: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Overall 1–5"><Input type="number" min={1} max={5} step={0.5} value={evalForm.overall} onChange={(e) => setEval({ ...evalForm, overall: e.target.value })} /></Field>
          <Field label="Category">
            <NativeSelect value={evalForm.category} onChange={(e) => setEval({ ...evalForm, category: e.target.value })}>
              {['general', 'humans', 'motion', 'product', 'text'].map((c) => <option key={c}>{c}</option>)}
            </NativeSelect>
          </Field>
        </div>
        <Button size="sm" onClick={async () => { try { await api('/api/admin/evaluations', { body: { modelKey: evalForm.modelKey, jobId: evalForm.jobId || undefined, overall: Number(evalForm.overall), category: evalForm.category } }); toast.success('Evaluation recorded'); } catch (e) { err(e); } }}>Save rating</Button>
      </Card>
    </div>
  );
}

function AuditTab() {
  const { data } = useQuery({ queryKey: ['admin', 'audit'], queryFn: () => api<{ entries: { id: string; action: string; actorUserId: string | null; targetType: string | null; targetId: string | null; createdAt: string; metadata: Record<string, unknown> }[] }>('/api/admin/audit') });
  return (
    <Card className="divide-y divide-white/5">
      {data?.entries.map((e) => (
        <div key={e.id} className="px-4 py-2.5 text-xs">
          <div className="flex justify-between gap-2">
            <span className="font-medium text-fog-100">{e.action}</span>
            <span className="text-fog-400">{timeAgo(e.createdAt)}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-fog-400">{e.targetType}:{e.targetId} {JSON.stringify(e.metadata)}</div>
        </div>
      ))}
    </Card>
  );
}

export default function AdminPage() {
  const { data: me } = useMe();
  if (me?.user?.role !== 'admin') return <p className="text-fog-300">Administrator access required.</p>;
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow="Admin" title="Operations" description="Costs, margins, models, pricing, routing, plans, users and the audit trail — all live from the database." />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="models">Models & pricing</TabsTrigger>
          <TabsTrigger value="config">Routing & limits</TabsTrigger>
          <TabsTrigger value="plans">Plans & templates</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="jobs">Failed jobs & QA</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="overview"><OverviewTab /></TabsContent>
        <TabsContent value="models"><ModelsTab /></TabsContent>
        <TabsContent value="config"><ConfigTab /></TabsContent>
        <TabsContent value="plans"><PlansTab /></TabsContent>
        <TabsContent value="users"><UsersTab /></TabsContent>
        <TabsContent value="jobs"><JobsTab /></TabsContent>
        <TabsContent value="audit"><AuditTab /></TabsContent>
      </Tabs>
    </div>
  );
}
