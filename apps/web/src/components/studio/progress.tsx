'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/** "about 2 min", "about 40 s", "a few seconds". Deliberately approximate. */
export function formatEta(sec: number | null | undefined): string | null {
  if (sec == null) return null;
  if (sec <= 12) return 'a few seconds';
  if (sec < 60) return `about ${Math.round(sec / 5) * 5} s`;
  const min = Math.round(sec / 60);
  return `about ${min} min`;
}

/**
 * Progress bar with an honest time estimate.
 * - progress (0–1) set → real percentage (provider-reported, or shots finished for films)
 * - progress null → animated "working" bar, plus the estimate from the model's history
 * The ETA counts down between polls so the screen never looks frozen.
 */
export function ProgressBar({ progress, etaSec, label, compact }: { progress: number | null | undefined; etaSec?: number | null; label?: string | null; compact?: boolean }) {
  const [eta, setEta] = useState(etaSec ?? null);
  useEffect(() => setEta(etaSec ?? null), [etaSec]);
  useEffect(() => {
    const t = setInterval(() => setEta((e) => (e == null ? e : Math.max(8, e - 1))), 1000);
    return () => clearInterval(t);
  }, []);
  const pct = progress == null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100);
  const etaText = formatEta(eta);

  return (
    <div className={cn('w-full', compact ? 'space-y-1' : 'space-y-2')}>
      <div
        className={cn('relative w-full overflow-hidden rounded-full bg-white/10', compact ? 'h-1' : 'h-2')}
        role="progressbar"
        aria-label={label ?? 'Progress'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={pct != null ? `${pct}%` : etaText ? `About ${etaText} left` : 'Working'}
      >
        {pct != null ? (
          <div className="h-full rounded-full bg-gradient-to-r from-iris-600 to-iris-400 transition-[width] duration-700 ease-out" style={{ width: `${Math.max(3, pct)}%` }} />
        ) : (
          <div className="absolute inset-y-0 w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-transparent via-iris-400 to-transparent" />
        )}
      </div>
      {!compact && (
        <div className="flex items-start justify-between gap-3 text-xs">
          <span className="min-w-0 text-fog-200">{label}</span>
          <span className="shrink-0 tabular-nums text-fog-300">
            {pct != null && `${pct}%`}
            {pct != null && etaText && ' · '}
            {/* Past the estimate: say so instead of counting "a few seconds" forever. */}
            {etaText && (eta != null && eta <= 8 ? (pct != null && pct < 90 ? 'a little longer than estimated' : 'finishing up') : `${etaText} left`)}
          </span>
        </div>
      )}
    </div>
  );
}
