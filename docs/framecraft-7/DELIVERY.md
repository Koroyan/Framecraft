# Framecraft 7 — the Figma design merged with the working studio (2026-10-31)

Branch `framecraft-7`. The owner's Figma design (a Figma Make code layer, "Design Framecraft AI
Video Studio") was compared screen by screen with the running application. The Figma file linked
for this round shows the same editor screen as the earlier one.

For every area, the stronger version was kept, and the Figma presentation was adopted where it was
clearer. No paid AI ran.

## Decisions per area

| Area | Decision | What it means |
|---|---|---|
| Palette, type, borders, radii | **Adopt Figma** | Deep navy surfaces, violet accent, Geist, the Figma line colour and radii, applied app-wide. A text colour used in 109 places was never defined; it now is. |
| Editor header | **Combine** | One row with the workspace tabs **Script \| Storyboard \| Graph \| Editor \| Shot \| Review**. Graph is its own tab. Everything that already worked in the header is kept. |
| Video editor, timeline, object tools, AI edit, assistant | **Keep existing** | The real multitrack timeline, object selection and tracking, AI edit with price and compare, and the docked assistant are stronger than the static Figma screen. Figma's ideas were added only where they map to real functions (below). |
| Timeline track headers | **Adopt Figma** | Eye and lock buttons on layer tracks. They are real: hidden tracks leave the preview *and* the export, and locked tracks cannot be dragged. |
| Layer inspector | **Combine** | Grouped into titled sections like Figma (Timing, Text, Transform, Animation). Font and size are now labelled. |
| Storyboard | **Combine** | Figma's project header (shot count, total length, Play all, Open Story Graph), scene time ranges and a selected-shot side panel (Earlier, Later, Duplicate, Open, Remove, prompt with Improve, Ask AI, Generate). Underneath are our real planned shots, statuses and the AI Director. |
| Story Graph | **Keep existing + Figma toolbar** | Ours already has Ask AI on every shot, scene and connection, AI actions, versions and undo. From Figma came the "Ask Director" button and the summary "Playback order · N shots · Xs · synced with the storyboard". |
| Script | **Adopt Figma (new)** | A Script workspace over the same scenes and shots: scene titles, synopsis, action, dialogue and length, edited in place. Rewrite with AI per scene returns a plan to review. Add shots. |
| New video (create hub) | **Adopt Figma** | Mode tiles, one large prompt and recent projects beside it. Our on-device suggestion of the right mode is kept. |
| Locations | **Redesign** | Location Studio: search, reference views, interior/exterior, time of day, weather, lighting, architecture, props, style and where each place is used. **+ Location** on scenes, from shot details, the storyboard and the script. The place's photos reach every shot of the scene. |
| Characters | **Keep (6.0)** | The Character Bible from 6.0 already covers what the Figma screen shows. |

## Tested (all on the live dev server or with fake models; nothing paid)

- `packages/shared`: 58 passed.
- `apps/server`: 167 passed, 1 skipped (manual). This includes a new test where a scene takes a
  saved location: new shot prompts are set there, undo restores the old place, and other people's
  places are refused.
- Playwright: **20 passed, 5 skipped by design** (fixture-only tests that would spend real credits).
  New in this round:
  - **L**: a saved location becomes a scene's place from the storyboard panel.
  - **W**: the Script view edits the same shots that the storyboard then shows, including a new
    planned shot.
  - **Mobile**: the cartoon, characters and locations pages fit a phone with no sideways scroll.
- `pnpm lint`, `pnpm typecheck`, and the web and server production builds: clean.

Screenshots: `screenshots/` (L1 scene place, S1 storyboard, W1 script → storyboard).

## Still needs external services or approval

- Real generation (storyboard frames, video, voices, music, AI edits) works through the existing
  pipelines, but was not run (paid).
- AI rewrites that go beyond the on-device answers call the AI Director model (Claude, small cost
  per request). In tests the model is fake.
- Live export to social platforms is not built. MP4 export works.

## Changed files (this round)

`apps/web/src/app/globals.css`, `app/layout.tsx`, `components/logo.tsx`,
`app/app/editor/[id]/page.tsx`, `app/app/new/page.tsx`, `app/app/locations/page.tsx`,
`components/editor/storyboard.tsx`, `story-graph.tsx`, `graph/edge.tsx`, `graph/details.tsx`,
`multitrack.tsx`, `layers.tsx`, `script-view.tsx` (new), `lib/api.ts`, `lib/studio.ts`;
`packages/shared/src/director.ts`; `apps/server/src/director/story.ts`,
`editing/versions.ts`, `http/routes/studio.ts`, `cli/reset-password.ts` (new);
`apps/server/test/director.test.ts`; `e2e/director-6.spec.ts`, `editor-studio.spec.ts`,
`mobile.spec.ts`.
