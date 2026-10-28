# Framecraft 6.0 — the AI Director inside the story (delivery, 2026-10-29)

This round puts the AI Director on the story graph and in the storyboard: on every shot, every
scene and every connection between two shots. It adds Create a Cartoon and a Character Bible with
brand mascots. Everything below was built on the existing architecture: the same shots, scenes,
characters, versions, AI edits, generation jobs and price estimates. There is no second editor or
second job system.

**Nothing paid ran during development.** Paid steps were exercised up to their price and approval
button only, and the end-to-end tests check that the credit balance did not change. Real-provider
results (generated storyboard frames, video, voices) were therefore **not** produced or reviewed in
this round.

## 1. Audit — what stood in the way (before)

- **Planned shots were invisible on the graph.** The graph drew only shots that had video. A film
  that had been planned but not generated showed an empty canvas, and its shots could be edited
  only on the separate movie page.
- **The assistant worked on the timeline only.** It could trim, colour and transition, but it could
  not add a shot, rewrite a shot's plan, change a camera preset, give a character a line or reorder
  the script. Every story change meant going to another page.
- **No AI where the shot is.** Graph nodes offered Edit, Play and Versions; asking for a change meant
  opening the shot editor or the assistant and saying again which shot was meant.
- **Two orders could drift apart.** A graph reorder changed the timeline but not the script, so
  re-assembling a film brought back the old order.
- **Styles.** One style preset said "Pixar-like rendering" (a studio name). Storyboard stills were
  always asked for as "photorealistic", even for animated films.
- **Characters** were per-film copies with a few appearance fields. There was no personality,
  palette or role, no mascots, no way to see where a character is used, and the character sheet
  started a paid image without showing its price.
- **Forms:** the shared `Field` component did not connect its label to its input, so screen readers
  read unlabelled fields across the app (found by the new end-to-end tests).

## 2. What was built

### AI Director in the story graph (`apps/web/src/components/editor/story-graph.tsx`, `graph/*`)
- **A Director node on the canvas.** It can be moved, resized, collapsed to a compact node and docked
  beside the canvas. The conversation is one per project, shared with the editor's assistant and kept
  through reloads. The subject is "On: …" and follows what you select. Each target keeps its own
  unsent draft.
- **Ask AI on every shot**, on every **scene** header and on every **connection** (the "+" in the
  middle of each line). The card already knows its target, has suggestions that fit it, shows that
  target's latest plan, and links to the full conversation. Your own uploaded clips get Ask AI too:
  they become shots on demand, for free.
- **AI actions** (Generate video, Storyboard frame, Continue, Camera move, Add dialogue, Fix,
  New background, Lighting, Change action, Restyle, Improve quality, Reframe, Colour match). Drag one
  onto a shot, or select a shot and click the action. The card shows only what that action needs.
- **Rich shot cards.** They show the shot number with scene·shot, a thumbnail or storyboard frame,
  the duration, a status chip, the cast (avatars), camera, dialogue and sound indicators, open notes,
  the active version and an estimated price for planned shots. The video plays inside the card with
  mute and expand, and a hover preview starts after a short pause. You can edit what happens in a shot
  in place, and **Shot details** covers camera, length, cast, dialogue and the full prompt.
- **Planned shots in their place** (dashed), between the shots the script puts them. When one is
  generated, it joins the movie at that place once. Shots you took out of the movie are remembered and
  are not put back.
- **Scenes** are frames with a header: scene number, title, place, shot count, length, Ask AI,
  "+ Shot" and collapse. A **FINAL MOVIE** node shows the length and the shot count, with Play and
  "Generate N planned". That opens a choice between a **draft** (storyboard stills, priced, clearly
  not video) and the **final** video (priced per film, with the models used).
- **Cast panel**: click a character to see the shots they are in (the others dim).
- Optional minimap, auto layout (scenes left to right), the canvas at full width, the preview beside
  it on request, and only visible nodes rendered (`onlyRenderVisibleElements`).

### The Director's operations (`packages/shared/src/director.ts`, `apps/server/src/director/story.ts`)
- **Typed operations**, validated on the server: `shot.update / insert / remove / move`,
  `scene.update`, `character.update`, and the paid `storyboard.generate`, `shot.generate` and
  `shot.ai_edit`. The editor's own timeline operations (trim, transition, colour match, digital
  camera move…) are reused.
- **Scope is enforced on the server.** A shot request can touch only that shot and new shots right
  next to it. A scene request stays in that scene. A connection allows new shots between its two
  shots and edits of those two. Character-wide changes need the whole project. Unknown or foreign
  ids are dropped before the user sees a plan, and refused when applying.
- **Free steps apply in one transaction and return their exact undo.** Generated takes are never
  deleted: a generated shot only leaves the movie. "Continue" starts a new shot from the last frame
  of the one before it (FFmpeg, exact, free).
- **Paid steps** are priced by the existing estimators, re-priced when run, and refused below the
  approved amount.
- **Instant on-device answers** in English, Georgian and Russian for common requests: add a shot
  after this or between these, close-up, reaction or establishing shot, continue, camera moves,
  length, a spoken line, remove, generate, storyboard frame, transition, colour match. Everything
  else goes to the AI Director model (Claude), which may only return these operations. Without that
  service, an honest offline answer turns the request into one direct edit of the selected shot.
- **Prompt writing.** A new shot gets a complete prompt from its description, framing and camera,
  each cast member's look word for word, the scene's place, continuity with the previous shot and
  the film's style. No model call is needed for it.

### Storyboard (`apps/web/src/components/editor/storyboard.tsx`)
The simple view now has scene groups, planned shots in place with Generate, and Ask AI on every card
and scene. It reads the same data as the graph and the timeline.

### Create a Cartoon (`apps/web/src/app/app/cartoon/page.tsx`, `apps/server/src/movie/cartoon.ts`, `packages/shared/src/cartoon.ts`)
- A first-class entry in **New video** (and recognised from a sentence in EN/KA/RU).
- **Twelve original styles**: 3D cartoon, animated feature, 2D hand-drawn, anime, clay, paper
  cut-out, minimal vector, comic book, storybook, kids learning, cinematic fantasy and brand mascot.
  The style cards are illustrations, not AI results. The style reaches every video prompt and every
  storyboard still.
- Length (within the plan's limit), format, audience, voices (dialogue / narration / music only),
  language, **cast from the Character Bible** and an optional **brand film**.
- The AI Director plans it like any film. Saved characters are cast **as themselves**: their approved
  reference goes to the planner, and the plan links the same character instead of creating a
  look-alike.
- **Protected characters are refused by name**, with a plain explanation.
- **Brand films** use only the brand's *approved* facts, its colours, restrictions, call to action,
  product photos and logo end card.

### Character Bible (`apps/web/src/app/app/characters/page.tsx`)
- Kind (story character or **brand mascot** linked to a brand), drawing style, personality, role,
  proportions, expressions, a three-colour palette and relationships, plus an approved look (the
  first reference).
- Each character shows **where it is used** (shots, projects). After a change of look, Framecraft says
  which shots are affected: planned shots use the new look, and generated shots keep theirs until you
  regenerate them. Nothing is regenerated silently.
- Reference sheets are drawn in the character's style (front, side, back, three expressions) and
  **ask with their price first**.

### Smaller fixes
- `Field` labels are connected to their inputs, app-wide.
- The 3D style no longer names a studio, and storyboard stills follow the film's style.
- Graph layout saves merge their parts. Planned films link to the story graph from the movie page.
  The Storyboard/Graph choice is remembered.

## 3. Verified

| What | Evidence |
|---|---|
| Insert a shot between two shots from the connection's "+": understood on the device, applied, placed between the two shots, prompt written for a video model, movie unchanged (3 clips), undone | Playwright `director-6.spec.ts` › C; screenshot C1 |
| Ask AI on a shot: a free trim applies; an AI edit of that shot shows ≈ 135 credits · Runway Aleph 2 with an Approve button, and **the balance did not change** | Playwright › B; screenshot B1 |
| An AI action dragged onto a shot opens its card; the free camera move applies | Playwright › D (real HTML5 drag-and-drop) |
| The Director keeps its conversation, its subject and an unsent draft through collapse, panning and a reload | Playwright › E; screenshot E1 |
| The storyboard shows the planned shot in place with Ask AI and Generate | Playwright › S; screenshot S1 |
| Create a Cartoon: recognised from a sentence, 12 styles, protected character refused before anything is sent | Playwright › K; screenshot K1 |
| Character Bible: a brand mascot with personality and style is saved and shown | Playwright › M |
| Plans stay in scope; unknown ids dropped; free steps undo exactly; generated takes never deleted; continuation frame; paid steps refused below their price; offline answers | server `director.test.ts` (11 tests, fake model) |
| Cartoon brief: original style, saved character cast as itself (no duplicate), brand film with approved facts only, protected character refused | server `cartoon.test.ts` (3 tests, fake model) |
| On-device Director (EN/KA/RU), story order with planned shots, cartoon intent and styles | `packages/shared` `director.test.ts` (13 tests) |

Totals: shared 58 ✓ · server 166 ✓ (1 skipped) · Playwright 18 ✓ (5 skipped by design) · typecheck, lint and production builds clean.

## 4. Real vs mocked AI

- **Real, used in tests:** FFmpeg (frames, continuation frame), the on-device Director, price
  estimates (from the live registry and pricing; no provider is called to estimate).
- **Fake in automated tests:** the AI Director model (Claude) and the screenplay model (`FakeLlm`).
- **Not run (paid):** storyboard frames, video generation, AI edits, voices, music. They are wired
  to the existing, previously tested pipelines (`regenerateShot`, keyframes, `createAiEdit`, dubbing),
  but this round produced no real output with them.

## 5. Credits spent

None in this round. The dev server has live providers configured (Claude, image, video, Runway),
so the end-to-end tests only send requests the on-device Director answers. For the paid step they
stop at the Approve button and check the balance afterwards.

## 6. Configuration

Nothing new. The AI Director uses `ANTHROPIC_API_KEY` (without it: on-device answers plus the honest
offline planner). Storyboard frames need live image generation, video needs the video providers,
AI edits need `RUNWAYML_API_SECRET`, and voices need ElevenLabs — all as before, with
`LIVE_GENERATION_ENABLED=true`.

## 7. Database

**No migration.** New data lives in existing JSON columns:
- `characters.style_meta`: kind, brandId, style, personality, role, palette, proportions,
  expressions, relationships.
- `projects.settings.cartoon`: style, audience, voices, cast, brand, product.
- `projects.settings.graph.removed`: generated shots taken out of the movie.

Existing projects open as before. Generated shots that were already outside the movie stay outside
(they are only put in automatically when they were generated in the current session).

## 8. Known limitations (honest)

- **Paid paths were not exercised with real providers**, so Test A (a cartoon from one sentence to an
  exported film), Test D (a brand cartoon end to end) and Test F (Georgian subtitles in an exported
  cartoon) are wired but **not demonstrated** with real output. Approval is needed to run them.
- **Consistency is not guaranteed.** Characters keep one approved reference that every shot starts
  from, where the model accepts references; the cards and pages say so.
- **Continuity review** (spotting clothing or prop changes between shots) uses the existing
  continuity flags only. No new visual check was built.
- **Ad variations** (emotional / funny / premium… from one production) were not built in this round.
- **Draft video** with a cheaper model is not a separate mode: the draft is storyboard stills.
- **"Make the robot red" on one generated shot** becomes an AI edit of that shot (paid, with a
  before/after through versions). Changing the character itself is a project-wide step that
  regenerates nothing by itself.
- **Large graphs:** only visible nodes are rendered. A real 50-shot project was not measured.
- Requests the on-device Director does not recognise use the AI Director model (a small LLM cost per
  request, as in the editor's assistant before). It is not priced per message.

## 9. Test results

Final run on 2026-10-29:
- `packages/shared`: 58 passed.
- `apps/server`: 166 passed, 1 skipped (manual test). This includes `director.test.ts` (11) and `cartoon.test.ts` (3).
- Playwright on the live dev server: 18 passed, 5 skipped by design (they need test-fixture mode and
  would otherwise spend real credits). This includes `director-6.spec.ts` (7) and all earlier editor
  tests.
- `pnpm lint`, `pnpm typecheck`, and the web and server production builds: clean.

## 10. Files

New: `packages/shared/src/director.ts`, `cartoon.ts`, `director.test.ts`;
`apps/server/src/director/story.ts`, `apps/server/src/movie/cartoon.ts`,
`apps/server/test/director.test.ts`, `cartoon.test.ts`;
`apps/web/src/lib/director.ts`, `apps/web/src/components/editor/director-chat.tsx`,
`graph/actions.tsx`, `graph/nodes.tsx`, `graph/edge.tsx`, `graph/details.tsx`, `graph/generate.tsx`,
`apps/web/src/app/app/cartoon/page.tsx`; `e2e/director-6.spec.ts`.

Changed: the story graph, storyboard, editor page, assistant (store + panel), studio types, creation
hub, characters page, the movie page link, `ui.tsx` (Field), intent and prompt (shared), studio and
editing routes, versions (studio data), movie (cast linking, styled stills, storyboard for chosen
shots).

## 11. Recommendations (next)

1. Approve a small budget to run Test A and Test D for real (storyboard frames first, then 2–3 shots),
   and review consistency and voices on real output.
2. Ad variations from one production (reuse approved clips).
3. A continuity check of characters and props using the storyboard frames.
4. Measure the graph with 50+ shots. Add per-scene virtualization if it is needed.
5. Translate the interface into Georgian and Russian (the Director already answers in all three).
