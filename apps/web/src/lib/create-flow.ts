import type { CreateFlow, CreateIntent } from '@framecraft/shared';

export const FLOW_LABEL: Record<CreateFlow, string> = { ai: 'AI video', animate: 'Animate an image', edit: 'Edit your video', ad: 'Advertisement', film: 'Film' };

/** Where a creation flow starts, carrying what the user already said (idea, format, length). */
export function hrefFor(flow: CreateFlow, idea: string, intent: CreateIntent | null): string {
  const q = new URLSearchParams();
  if (flow === 'edit') {
    if (intent?.aspect) q.set('aspect', intent.aspect);
    return `/app/edit?${q}`;
  }
  if (flow === 'ad') {
    if (idea) q.set('idea', idea);
    if (intent?.durationSec) q.set('length', String(intent.durationSec));
    return `/app/ads/create?${q}`;
  }
  if (flow === 'film') {
    if (idea) q.set('idea', idea);
    if (intent?.durationSec) q.set('length', String(intent.durationSec));
    if (intent?.aspect) q.set('aspect', intent.aspect);
    return `/app/movie?${q}`;
  }
  if (idea) q.set('prompt', idea);
  if (intent?.aspect) q.set('aspect', intent.aspect);
  if (intent?.durationSec) q.set('duration', String(intent.durationSec));
  if (flow === 'animate') q.set('mode', 'animate');
  return `/app/create?${q}`;
}
