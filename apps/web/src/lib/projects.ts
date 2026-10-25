/** Where a project opens and how its kind is named — shared by the dashboard, projects page and search. */
export const KIND_LABEL: Record<string, string> = { quick: 'AI video', social: 'Social post', cinematic: 'Cinematic', movie: 'Film', edit: 'Edit', ad: 'Ad' };

export const projectHref = (p: { id: string; kind: string }) => (p.kind === 'movie' ? `/app/movie/${p.id}` : p.kind === 'edit' || p.kind === 'ad' ? `/app/editor/${p.id}` : `/app/projects/${p.id}`);
