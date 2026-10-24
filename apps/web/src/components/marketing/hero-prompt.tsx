'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUp } from 'lucide-react';

const IDEAS = ['A futuristic car driving through Tokyo at night', 'Cinematic reveal of a perfume bottle on black marble', 'A tiny fox explorer finds a glowing map in the forest'];

export function HeroPrompt() {
  const [value, setValue] = useState('');
  const router = useRouter();
  const go = () => router.push(`/register?prompt=${encodeURIComponent(value.trim() || IDEAS[0]!)}`);
  return (
    <div className="mt-8 max-w-xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
        className="flex items-center gap-2 rounded-2xl border hairline bg-white/[0.04] p-2 pl-4 shadow-[0_20px_60px_-30px_rgb(124_108_255/0.6)] focus-within:border-iris-500/50"
      >
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="What do you want to create?" aria-label="Describe your video" className="h-11 flex-1 bg-transparent text-[15px] text-white placeholder:text-fog-400 focus:outline-none" />
        <button type="submit" aria-label="Start" className="grid size-11 place-items-center rounded-xl bg-iris-500 text-white transition hover:bg-iris-400">
          <ArrowUp className="size-5" />
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {IDEAS.map((i) => (
          <button key={i} type="button" onClick={() => setValue(i)} className="rounded-full border hairline px-3 py-1 text-xs text-fog-300 transition hover:border-white/20 hover:text-white">
            {i}
          </button>
        ))}
      </div>
    </div>
  );
}
