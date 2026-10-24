'use client';

import { useRef, useState } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { endpoints, ApiError, type Asset } from '@/lib/api';
import { Button, Dialog, Switch } from '@/components/ui';
import { cn } from '@/lib/utils';

/** Upload with an explicit rights/consent confirmation (required by the API). */
export function useUploader(opts: { projectId?: string; kind?: 'upload' | 'reference'; accept?: string } = {}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [rights, setRights] = useState(false);
  const [people, setPeople] = useState(false);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((a: Asset | null) => void) | null>(null);

  const pick = () =>
    new Promise<Asset | null>((resolve) => {
      resolver.current = resolve;
      inputRef.current?.click();
    });

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const { asset } = await endpoints.upload(pending, { rightsConfirmed: String(rights), containsPeople: String(people), kind: opts.kind ?? 'upload', ...(opts.projectId ? { projectId: opts.projectId } : {}) });
      resolver.current?.(asset);
      setPending(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const element = (
    <>
      <input
        ref={inputRef}
        type="file"
        hidden
        accept={opts.accept ?? 'image/jpeg,image/png,image/webp'}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) {
            setRights(false);
            setPeople(false);
            setPending(f);
          } else resolver.current?.(null);
        }}
      />
      <Dialog
        open={Boolean(pending)}
        onOpenChange={(o) => {
          if (!o) {
            setPending(null);
            resolver.current?.(null);
          }
        }}
        title="Before you upload"
        description={pending?.name}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button onClick={confirm} disabled={!rights} loading={busy}>
              Upload
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-0.5 size-4 accent-iris-500" checked={rights} onChange={(e) => setRights(e.target.checked)} />
            <span className="text-fog-200">I own this file or have permission to use it, including for commercial use where applicable.</span>
          </label>
          <div className="flex items-center justify-between gap-4 rounded-xl border hairline p-3">
            <span className="text-fog-200">This shows an identifiable real person</span>
            <Switch checked={people} onCheckedChange={setPeople} label="Contains people" />
          </div>
          {people && <p className="rounded-xl bg-signal-amber/10 p-3 text-xs text-signal-amber">You confirm every identifiable person has consented. Impersonating real people or public figures is not allowed.</p>}
        </div>
      </Dialog>
    </>
  );
  return { pick, element, busy };
}

export function ImageSlot({ label, asset, onChange, className, projectId }: { label: string; asset: Asset | null; onChange: (a: Asset | null) => void; className?: string; projectId?: string }) {
  const up = useUploader({ projectId });
  return (
    <div className={cn('relative', className)}>
      {up.element}
      {asset ? (
        <div className="group relative aspect-square overflow-hidden rounded-xl border hairline">
          <img src={asset.url} alt={label} className="size-full object-cover" />
          <button type="button" aria-label={`Remove ${label}`} onClick={() => onChange(null)} className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/70 text-white">
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={async () => {
            const a = await up.pick();
            if (a) onChange(a);
          }}
          className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed hairline text-fog-400 transition hover:border-iris-500/50 hover:text-fog-100"
        >
          {up.busy ? <Loader2 className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}
          <span className="px-1 text-center text-[11px] leading-tight">{label}</span>
        </button>
      )}
    </div>
  );
}
