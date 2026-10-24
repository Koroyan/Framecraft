'use client';

import { SOCIAL_PLATFORMS, type SocialPlatform } from '@framecraft/shared';
import { FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Video preview with an optional platform safe-area overlay and a fixture label. */
export function VideoPlayer({ src, poster, aspect = '9:16', isFixture, className, overlay }: { src: string; poster?: string | null; aspect?: string; isFixture?: boolean; className?: string; overlay?: SocialPlatform | null }) {
  const [w, h] = aspect.split(':').map(Number);
  const safe = overlay ? SOCIAL_PLATFORMS[overlay].safeArea : null;
  return (
    <div className={cn('relative overflow-hidden rounded-2xl border hairline bg-black', className)} style={{ aspectRatio: `${w}/${h}` }}>
      <video src={src} poster={poster ?? undefined} controls playsInline loop className="size-full object-contain" preload="metadata" />
      {safe && (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <div className="absolute border-2 border-dashed border-signal-blue/60" style={{ top: `${safe.top * 100}%`, bottom: `${safe.bottom * 100}%`, left: `${safe.left * 100}%`, right: `${safe.right * 100}%` }} />
          <div className="absolute left-2 top-2 rounded bg-signal-blue/80 px-1.5 py-0.5 text-[10px] font-medium text-black">{SOCIAL_PLATFORMS[overlay!].label} safe area</div>
        </div>
      )}
      {isFixture && (
        <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-full bg-signal-amber px-2 py-0.5 text-[10px] font-semibold text-black">
          <FlaskConical className="size-3" /> TEST FIXTURE · NOT AI
        </div>
      )}
    </div>
  );
}
