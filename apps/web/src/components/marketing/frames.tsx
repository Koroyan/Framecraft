import { cn } from '@/lib/utils';

/**
 * Illustrative CSS artwork used on the marketing site until real, rights-cleared
 * AI outputs are available. Every frame is labelled as illustration.
 */
const SCENES = {
  tokyo: {
    title: 'Neon Tokyo, night drive',
    bg: 'radial-gradient(120% 80% at 50% 110%, #ff3d9a55 0%, transparent 55%), radial-gradient(90% 60% at 80% 20%, #5cb8ff44 0%, transparent 60%), linear-gradient(180deg, #0a0a1f 0%, #1a0b2e 60%, #2b0f3a 100%)',
    shapes: (
      <>
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-[repeating-linear-gradient(90deg,transparent_0_18px,rgb(255_255_255/0.04)_18px_19px)]" />
        {[12, 28, 46, 63, 80].map((l, i) => (
          <div key={l} className="absolute bottom-[34%] w-[9%] rounded-t-sm bg-gradient-to-t from-[#ff3d9a33] to-[#5cb8ff22]" style={{ left: `${l}%`, height: `${28 + ((i * 17) % 30)}%` }} />
        ))}
        <div className="absolute bottom-[18%] left-1/2 h-[3px] w-[60%] -translate-x-1/2 bg-gradient-to-r from-transparent via-[#ff8ad0] to-transparent blur-[1px]" />
      </>
    ),
  },
  desert: {
    title: 'Desert dawn, crane shot',
    bg: 'radial-gradient(60% 40% at 50% 62%, #ffcf8a 0%, #ff8a5c55 35%, transparent 70%), linear-gradient(180deg, #2b1b3d 0%, #7a3b4d 45%, #e0855a 70%, #3a2218 71%, #1b120c 100%)',
    shapes: <div className="absolute inset-x-0 bottom-0 h-[30%] bg-[radial-gradient(80%_100%_at_30%_0%,#5a341f_0%,transparent_70%),radial-gradient(70%_100%_at_80%_10%,#4a2a19_0%,transparent_70%)]" />,
  },
  product: {
    title: 'Product reveal, slow dolly',
    bg: 'radial-gradient(40% 35% at 50% 45%, #9a90ff55 0%, transparent 70%), linear-gradient(180deg, #08080c 0%, #111118 100%)',
    shapes: (
      <>
        <div className="absolute left-1/2 top-[30%] h-[38%] w-[22%] -translate-x-1/2 rounded-[40%_40%_12%_12%] bg-gradient-to-b from-[#3a3550] via-[#16141f] to-[#0c0b12] shadow-[0_0_60px_10px_rgb(124_108_255/0.25)]" />
        <div className="absolute left-1/2 top-[66%] h-[6%] w-[46%] -translate-x-1/2 rounded-[50%] bg-black/70 blur-md" />
      </>
    ),
  },
  forest: {
    title: 'Storybook forest, tracking',
    bg: 'radial-gradient(50% 40% at 70% 30%, #b9ffcf33 0%, transparent 60%), linear-gradient(180deg, #071a14 0%, #0d2a20 50%, #08140f 100%)',
    shapes: (
      <>
        {[8, 22, 40, 58, 74, 88].map((l, i) => (
          <div key={l} className="absolute bottom-0 w-[7%] bg-gradient-to-t from-black/80 to-[#12382a]" style={{ left: `${l}%`, height: `${60 + ((i * 13) % 35)}%`, clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' }} />
        ))}
        <div className="absolute left-[30%] top-[40%] size-2 rounded-full bg-[#f5ffb0] shadow-[0_0_20px_6px_#f5ffb088]" />
      </>
    ),
  },
  ocean: {
    title: 'Ocean at golden hour',
    bg: 'radial-gradient(40% 30% at 50% 40%, #ffd9a0 0%, #ff9f6e44 40%, transparent 70%), linear-gradient(180deg, #1d2a4a 0%, #e08a6a 46%, #1c3d5a 47%, #0b1a2a 100%)',
    shapes: <div className="absolute inset-x-0 bottom-0 h-[52%] bg-[repeating-linear-gradient(180deg,transparent_0_10px,rgb(255_220_180/0.06)_10px_12px)]" />,
  },
  noir: {
    title: 'Detective in the rain',
    bg: 'linear-gradient(180deg, #0c0f14 0%, #151b24 60%, #0a0d12 100%)',
    shapes: (
      <>
        <div className="absolute inset-0 bg-[repeating-linear-gradient(100deg,transparent_0_14px,rgb(180_200_255/0.05)_14px_15px)]" />
        <div className="absolute bottom-[12%] left-[38%] h-[52%] w-[16%] rounded-t-[45%] bg-gradient-to-b from-[#1e2632] to-black" />
        <div className="absolute left-[60%] top-[18%] size-24 rounded-full bg-[#f5b84b22] blur-2xl" />
      </>
    ),
  },
} as const;

export type SceneKey = keyof typeof SCENES;

export function FilmFrame({ scene, className, label = true, aspect = '9/16' }: { scene: SceneKey; className?: string; label?: boolean; aspect?: string }) {
  const s = SCENES[scene];
  return (
    <div className={cn('grain relative overflow-hidden rounded-2xl border hairline', className)} style={{ aspectRatio: aspect, background: s.bg }} role="img" aria-label={`Illustration: ${s.title}`}>
      {s.shapes}
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
      {label && (
        <div className="absolute inset-x-3 bottom-3 flex items-end justify-between gap-2">
          <span className="text-[12px] font-medium text-white/90">{s.title}</span>
          <span className="rounded-full bg-black/50 px-2 py-0.5 text-[9px] uppercase tracking-wider text-white/60 backdrop-blur">Illustration</span>
        </div>
      )}
    </div>
  );
}
