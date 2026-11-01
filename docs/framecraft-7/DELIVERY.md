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
| Edit workspace layout | **Adopt Figma** (after owner feedback) | One studio frame with hairline dividers instead of floating cards. Left: labelled tool rail and an "Editor tool" panel; Media is a searchable list (All / Videos / Photos) with size, format and length. Right: the inspector stays open with "Selected clip" heading, underline tabs and titled sections (Playback, Transition & fades, Trim, Clip). Bottom: play, scrub and timecode in the timeline header, labelled Split / Duplicate / Freeze / Delete, Snap and a zoom slider. Figma colours on the timeline: violet video clips with names, purple text, green overlays, cyan voice, violet music, red playhead. All existing tools, shortcuts and tests are unchanged. |
| Timeline track headers | **Adopt Figma** | Eye and lock buttons on layer tracks. They are real: hidden tracks leave the preview *and* the export, and locked tracks cannot be dragged. |
| Layer inspector | **Combine** | Grouped into titled sections like Figma (Timing, Text, Transform, Animation). Font and size are now labelled. |
| Storyboard | **Combine** | Figma's project header (shot count, total length, Play all, Open Story Graph), scene time ranges and a selected-shot side panel (Earlier, Later, Duplicate, Open, Remove, prompt with Improve, Ask AI, Generate). Underneath are our real planned shots, statuses and the AI Director. |
| Story Graph | **Keep existing + Figma toolbar** | Ours already has Ask AI on every shot, scene and connection, AI actions, versions and undo. From Figma came the "Ask Director" button and the summary "Playback order · N shots · Xs · synced with the storyboard". |
| Script | **Adopt Figma (new)** | A Script workspace over the same scenes and shots: scene titles, synopsis, action, dialogue and length, edited in place. Rewrite with AI per scene returns a plan to review. Add shots. |
| New video (create hub) | **Adopt Figma** | Mode tiles, one large prompt and recent projects beside it. Our on-device suggestion of the right mode is kept. |
| Locations | **Redesign** | Location Studio: search, reference views, interior/exterior, time of day, weather, lighting, architecture, props, style and where each place is used. **+ Location** on scenes, from shot details, the storyboard and the script. The place's photos reach every shot of the scene. |
| Characters | **Keep (6.0) + four views** | The Character Bible from 6.0, plus **Make 4 views** on every character: front, three-quarter, side and back. |
| Simple editor | **Adopt Figma (after owner feedback)** | The same studio frame as the full editor: tool rail on the left (Video, Upload, Text, Music, Captions, Format), the picture in the middle, the selected clip / text / sound with its tool tiles and the open tool on the right, the timeline with play and time below. |
| Titles & stickers | **Fix** | The words of a title or sticker are the first field of the selected layer, focused as soon as it is added; double-click the layer in the picture to edit them. |
| Create with AI | **Fix** | Characters and places start empty and are picked from the library or with **@Name** in the description. Each quality card shows its own price; Economy targets 480p, so it is cheaper than Balanced even on the same model. |
| AI Movie Maker | **Extend** | Cast saved characters and places (picker or **@Name**); nothing picked, the AI Director invents them. Saved ones are used as themselves (no copies) and survive revisions. **Cast & places** shows four slots per character and place with one button for everything still without a picture. |
| Reference views | **New** | Four images per character (front, ¾, side, back) or place (wide, reverse, side, detail). The first view sets the look and the other three use it as their reference (or all four use the element's own photo). Priced first; credits for all four reserved up front, each charged when it finishes, the rest refunded if the first fails. |
| Social Studio | **Redesign (after owner feedback)** | One brief (platform, topic, goal, tone, length, language) → three concepts with a safe-zone phone preview and shot timing, hooks, a ready-to-paste post with hashtags and a voice-over script; proven formats below. |
| Dropdowns | **Fix** | Native select lists are dark with light text everywhere (Windows painted them white). |

## Tested (all on the live dev server or with fake models; nothing paid)

- Follow-up round (owner feedback, 1 Nov): `apps/server` **175 passed, 1 skipped**; Playwright
  **20 passed, 5 skipped by design**; lint, typecheck and the web production build clean. New
  server tests: the reference-view chain and its credit reservations (fixture mode and a mocked
  live provider — nothing real is called), saved characters and places cast in a film, the AI
  Director's prompt with and without a saved cast. Social Studio was checked in a browser with the
  AI Director answers mocked (no paid request).
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
