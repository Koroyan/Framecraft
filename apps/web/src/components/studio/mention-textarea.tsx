'use client';

import { useRef, useState } from 'react';
import { MapPin, UserRound } from 'lucide-react';
import { Textarea } from '@/components/ui';
import { useElements } from '@/components/studio/cast-picker';
import { cn } from '@/lib/utils';

export type CastMention = { kind: 'character' | 'location'; id: string; name: string; url?: string; description?: string };

/** Saved characters and locations, as one list for @mentions. */
export function useCast(): CastMention[] {
  const chars = useElements('character');
  const locs = useElements('location');
  return [
    ...(chars.data ?? []).map((c) => ({ kind: 'character' as const, id: c.id, name: c.name, url: c.references[0]?.url, description: c.description })),
    ...(locs.data ?? []).map((l) => ({ kind: 'location' as const, id: l.id, name: l.name, url: l.references[0]?.url, description: l.description })),
  ];
}

/** Which saved characters / locations the text mentions as @Name. */
export function mentionedIn(text: string, cast: CastMention[]) {
  const low = text.toLowerCase();
  return cast.filter((m) => low.includes(`@${m.name.toLowerCase()}`));
}

/** "@Nino walks…" → "Nino walks…" for the model (the @ only marks the reference for us). */
export function stripMentions(text: string, cast: CastMention[]) {
  let out = text;
  for (const m of [...cast].sort((a, b) => b.name.length - a.name.length)) out = out.replace(new RegExp(`@(${m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '$1');
  return out;
}

/**
 * A textarea where typing @ lists saved characters and locations; picking one writes @Name
 * into the text and reports it through onMention (the composer then uses its photos).
 */
export function MentionTextarea({ value, onChange, onMention, className, ...rest }: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onChange: (v: string) => void; onMention: (m: CastMention) => void }) {
  const cast = useCast();
  const input = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ query: string; start: number; active: number } | null>(null);
  const matches = menu ? cast.filter((m) => m.name.toLowerCase().includes(menu.query.toLowerCase())).slice(0, 8) : [];
  const track = (v: string, caret: number) => {
    const m = v.slice(0, caret).match(/(^|\s)@([^@\n]{0,30})$/);
    setMenu(m ? { query: m[2]!, start: caret - m[2]!.length - 1, active: 0 } : null);
  };
  const pick = (m: CastMention) => {
    if (!menu) return;
    const caret = menu.start + 1 + menu.query.length;
    onChange(`${value.slice(0, menu.start)}@${m.name} ${value.slice(caret)}`);
    onMention(m);
    setMenu(null);
    requestAnimationFrame(() => {
      const pos = menu.start + m.name.length + 2;
      input.current?.focus();
      input.current?.setSelectionRange(pos, pos);
    });
  };
  return (
    <div className="relative">
      <Textarea
        {...rest}
        ref={input}
        value={value}
        className={className}
        onChange={(e) => {
          onChange(e.target.value);
          track(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onBlur={() => setMenu(null)}
        onKeyDown={(e) => {
          if (!menu) return;
          if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setMenu({ ...menu, active: (menu.active + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length });
          } else if (matches.length && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault();
            pick(matches[menu.active]!);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setMenu(null);
          }
        }}
      />
      {menu && (
        <div role="listbox" aria-label="Saved characters and locations" className="absolute inset-x-2 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-xl border hairline bg-ink-800 p-1 shadow-2xl">
          {matches.map((m, i) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={i === menu.active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm', i === menu.active ? 'bg-iris-500/20 text-white' : 'text-fog-200 hover:bg-white/[0.05]')}
            >
              {m.url ? <img src={m.url} alt="" className="size-8 rounded-md object-cover" /> : <span className="grid size-8 place-items-center rounded-md bg-white/[0.06]">{m.kind === 'character' ? <UserRound className="size-3.5" /> : <MapPin className="size-3.5" />}</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{m.name}</span>
                {m.description && <span className="block truncate text-[11px] text-fog-500">{m.description}</span>}
              </span>
              <span className="text-[10px] text-fog-500">{m.kind === 'character' ? 'character' : 'place'}</span>
            </button>
          ))}
          {!matches.length && <p className="px-2 py-1.5 text-xs text-fog-400">{cast.length ? 'No saved character or place with that name.' : 'No saved characters or places yet — add one below.'}</p>}
        </div>
      )}
    </div>
  );
}
