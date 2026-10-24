'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { LANGUAGES, QUALITY_MODE_INFO, QUALITY_MODES } from '@framecraft/shared';
import { api, ApiError } from '@/lib/api';
import { Button, Card, Dialog, Field, Input, NativeSelect, PageHeader, Switch } from '@/components/ui';
import { useUploader } from '@/components/studio/upload';

type Settings = {
  defaultQuality: string;
  defaultAspectRatio: string;
  language: string;
  brandKit: { colors: string[]; logoAssetId?: string; name?: string };
  dailySpendLimit: number | null;
  perJobSpendLimit: number | null;
  notifyEmail: boolean;
};

export default function SettingsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => api<{ settings: Settings; logoUrl: string | null }>('/api/settings') });
  const [s, setS] = useState<Settings | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [del, setDel] = useState({ open: false, password: '', confirm: '' });
  const up = useUploader();
  useEffect(() => {
    if (data) {
      setS(data.settings);
      setLogoUrl(data.logoUrl);
    }
  }, [data]);
  if (!s) return null;

  const save = async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: s });
      toast.success('Settings saved');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Settings" />
      <Card className="grid gap-4 p-5 md:grid-cols-2">
        <Field label="Default quality">
          <NativeSelect value={s.defaultQuality} onChange={(e) => setS({ ...s, defaultQuality: e.target.value })}>
            {QUALITY_MODES.map((q) => <option key={q} value={q}>{QUALITY_MODE_INFO[q].label}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Default format">
          <NativeSelect value={s.defaultAspectRatio} onChange={(e) => setS({ ...s, defaultAspectRatio: e.target.value })}>
            {['9:16', '16:9', '1:1', '4:5'].map((a) => <option key={a}>{a}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Language for scripts & captions">
          <NativeSelect value={s.language} onChange={(e) => setS({ ...s, language: e.target.value })}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </NativeSelect>
        </Field>
        <label className="flex items-center justify-between gap-3 self-end rounded-xl border hairline p-3 text-sm text-fog-200">Email me when videos finish <Switch checked={s.notifyEmail} onCheckedChange={(v) => setS({ ...s, notifyEmail: v })} label="Email notifications" /></label>
      </Card>

      <Card className="space-y-4 p-5">
        <div className="font-medium text-white">Brand kit</div>
        {up.element}
        <div className="flex items-center gap-4">
          <div className="grid size-16 place-items-center overflow-hidden rounded-xl border hairline bg-ink-800">
            {logoUrl ? <img src={logoUrl} alt="Logo" className="size-full object-contain" /> : <ImagePlus className="size-5 text-fog-400" />}
          </div>
          <Button size="sm" variant="secondary" onClick={async () => { const a = await up.pick(); if (a) { setS({ ...s, brandKit: { ...s.brandKit, logoAssetId: a.id } }); setLogoUrl(a.url); } }}>Upload logo</Button>
        </div>
        <Field label="Brand name"><Input value={s.brandKit.name ?? ''} onChange={(e) => setS({ ...s, brandKit: { ...s.brandKit, name: e.target.value } })} /></Field>
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-fog-300">Brand colors</div>
          <div className="flex flex-wrap items-center gap-2">
            {s.brandKit.colors.map((c, i) => (
              <span key={i} className="flex items-center gap-1 rounded-full border hairline py-1 pl-1 pr-2">
                <input type="color" aria-label="Brand color" value={c} onChange={(e) => setS({ ...s, brandKit: { ...s.brandKit, colors: s.brandKit.colors.map((x, j) => (j === i ? e.target.value.toUpperCase() : x)) } })} className="size-6 rounded-full border-0 bg-transparent" />
                <span className="text-xs text-fog-300">{c}</span>
                <button type="button" aria-label="Remove color" onClick={() => setS({ ...s, brandKit: { ...s.brandKit, colors: s.brandKit.colors.filter((_, j) => j !== i) } })}><X className="size-3 text-fog-400" /></button>
              </span>
            ))}
            {s.brandKit.colors.length < 8 && <Button size="sm" variant="ghost" onClick={() => setS({ ...s, brandKit: { ...s.brandKit, colors: [...s.brandKit.colors, '#7C6CFF'] } })}><Plus /> Add</Button>}
          </div>
        </div>
      </Card>

      <Card className="grid gap-4 p-5 md:grid-cols-2">
        <div className="font-medium text-white md:col-span-2">Spending limits</div>
        <Field label="Max credits per video" hint="Leave empty for no personal limit.">
          <Input type="number" min={1} value={s.perJobSpendLimit ?? ''} onChange={(e) => setS({ ...s, perJobSpendLimit: e.target.value ? Number(e.target.value) : null })} />
        </Field>
        <Field label="Max credits per day">
          <Input type="number" min={1} value={s.dailySpendLimit ?? ''} onChange={(e) => setS({ ...s, dailySpendLimit: e.target.value ? Number(e.target.value) : null })} />
        </Field>
      </Card>
      <Button onClick={save}>Save settings</Button>

      <Card className="space-y-3 p-5">
        <div className="font-medium text-white">Change password</div>
        <Input type="password" placeholder="Current password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
        <Input type="password" placeholder="New password (10+ characters)" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
        <Button size="sm" variant="secondary" onClick={async () => { try { await api('/api/auth/password', { body: pw }); toast.success('Password changed — please sign in again'); router.push('/login'); } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Failed'); } }}>Update password</Button>
      </Card>

      <Card className="space-y-2 border-signal-red/20 p-5">
        <div className="font-medium text-signal-red">Delete account</div>
        <p className="text-sm text-fog-300">Permanently deletes your projects, uploads and generated media. This cannot be undone.</p>
        <Button size="sm" variant="danger" onClick={() => setDel({ ...del, open: true })}>Delete my account</Button>
      </Card>
      <Dialog open={del.open} onOpenChange={(o) => setDel({ ...del, open: o })} title="Delete account" description="Type DELETE and your password to confirm." footer={<Button variant="danger" disabled={del.confirm !== 'DELETE' || !del.password} onClick={async () => { try { await api('/api/account/delete', { body: { password: del.password, confirm: 'DELETE' } }); qc.clear(); router.push('/'); } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Failed'); } }}>Delete forever</Button>}>
        <div className="space-y-3">
          <Input placeholder="DELETE" value={del.confirm} onChange={(e) => setDel({ ...del, confirm: e.target.value })} />
          <Input type="password" placeholder="Password" value={del.password} onChange={(e) => setDel({ ...del, password: e.target.value })} />
        </div>
      </Dialog>
    </div>
  );
}
