# Framecraft editor audit (before 5.0), 2026-10-27

Method: read the editor code end to end (`apps/web/src/app/app/editor/[id]/page.tsx`, `components/editor/*`,
`packages/shared` timeline/grade/mask code, `apps/server/src/media/*`, editing routes) and used the running
app in a browser on a test project. File references are to the code *before* the 5.0 changes.

## Structural problems

| # | Problem | Evidence | Effect on the user |
|---|---|---|---|
| 1 | **Assistant is an unmanaged floating card.** It is a fixed 420×560 px box in the bottom-right corner, drawn *over* the preview and timeline; it cannot dock, resize, minimise or remember its place. | `page.tsx` renders `{assistantOpen && <div className="fixed bottom-4 right-4 … h-[min(560px,80dvh)] w-[min(420px,…)]"><Copilot/></div>}` | Covers the work; closing it **unmounts `Copilot`, so the conversation and the typed draft are lost**. |
| 2 | **Two separate assistants.** The shot editor mounts its own `Copilot` with its own history. | `shot-editor.tsx` (bottom of the right column) | The same question gets different context depending on the screen; history is split. |
| 3 | **Selecting a moving object is a 5-panel journey.** Recolouring a jacket = open Shot editor → pick a mask tool from 7 unlabeled 28 px icons → draw → press *Track* → switch to *Color* tab → pick source colour with an eyedropper → pick the target → hope the mask is used. | `shot-editor.tsx` tool row; `color-pro.tsx` | Users don't know what was selected, for which seconds, or what to do next. |
| 4 | **Time range is hidden.** A range is made with *Shift-drag* on a thin bar or I/O keys, only in the shot editor; the main editor has no range at all. | `RangeBar` (shot editor) | "Which seconds will change?" has no visible answer. |
| 5 | **Tracking is translation-only and its failures are invisible.** Uncertain frames are only counted in a toast. | `media/tracker.ts`, `trackMask()` toast | Scale changes (subject walking towards camera) drift; users can't find the bad frames. |
| 6 | **Preview ≠ export for graded footage of a different shape.** The WebGL grade canvas draws the whole video texture stretched over the frame, while the `<video>` underneath is `object-cover` (and may be re-framed). | `grade-canvas.tsx` draws `uv 0..1` to a canvas sized to the frame | A 16:9 clip in a 9:16 project looks squashed as soon as a look/colour is applied; masks are misplaced. |
| 7 | **Masked colour export ignores reverse/re-frame.** The mask clock assumes `inSec + t·speed` and a centred crop. | `clip-fx.ts` masked replace | A reversed or auto-reframed clip gets the mask at the wrong place/time. |
| 8 | **A paid action without a price.** *Regenerate this shot with AI* in the clip inspector starts a paid generation immediately (`confirmEstimate: true`), no cost, no confirmation. | `page.tsx` clip tab; `movie.ts regenerateShot` | Credits are spent without consent — violates our own cost-transparency rule. |
| 9 | **Duplicated systems.** Two text systems (`timeline.texts` "Text" tab and text *Layers*), two overlay systems ("PiP (V2)" overlays and image/video *Layers*), captions in three places (Subs tab, Captions tool, Layers). | inspector tabs in `page.tsx` | Users can't tell which one to use; edits in one don't show in the other. |
| 10 | **Inspector ignores the selection.** Seven fixed tabs; selecting a text layer or an audio item does not open its properties. | `Tabs value={inspectorTab}` | Constant tab hunting. |
| 11 | **Story graph is the default for films/ads.** Node canvas with ports is the first thing a beginner sees. | `useEffect(... setWorkspace('edit') only when no shotId)` | Intimidating; the simple sequence is one click away but not obvious. |
| 12 | **Review is a detour.** The *Review* tab lists pending AI edits and jumps to the shot editor to decide. | workspace `review` | Approving one change means leaving the timeline. |
| 13 | **Clips can't be trimmed on the timeline.** In/out only via sliders in the inspector (layers *can* be edge-dragged). | `multitrack.tsx` | The most common edit takes the most effort. |
| 14 | **Uploaded clips can't use AI edits.** AI edits require a generated *shot*; footage in a Video-Editor project has none. | `ai-edit.ts sourceVersion()` needs `shotId` | "Remove / replace this object" is impossible on your own video. |
| 15 | **No free/paid signal in the assistant.** Free edits show *Apply*, AI edits show *Run · N cr*, but nothing explains which requests will cost before you ask. | `copilot.tsx` | Uncertainty about spending. |

## What already works well (kept)

- Real FFmpeg export with transitions, layers, audio ducking; preview uses the same LUT maths as export.
- Masked colour replacement with tracked masks (engine), template tracker, layer motion tracking.
- Direct manipulation of layers on the preview (move / scale / rotate with snapping).
- Waveforms and filmstrips on the timeline; undo/redo; autosave; version history; compare (wipe / side by side).
- AI edit operations with estimates, review and accept/reject; development fixtures are labelled.

## Fix order (by user impact)

1 (assistant) → 3/4/5/6 (object selection with explicit time scope, tracking, preview=export) → 8 (price) →
10/13 (contextual inspector, trim on timeline) → 14 (AI on uploads) → 11/12 (storyboard first, review in place) → 9 (merge duplicates).
