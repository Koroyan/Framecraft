# Framecraft 5.0 — delivery report (2026-10-27)

One editor instead of several mini-apps: **Media → Preview → Timeline → Inspector → Assistant**, with
click-to-select objects that can follow motion, an assistant that docks anywhere and never loses the
conversation, and every paid action priced and confirmed first. Everything below was exercised in a
real browser on real video files; nothing paid was run.

## 1. What was wrong (full list with evidence: [AUDIT.md](AUDIT.md))

- The assistant was a fixed card over the preview; closing it **deleted the conversation and the draft**.
- Recolouring a moving object took five panels; the selected seconds were hidden; tracking failures were invisible.
- The colour preview **stretched** footage whose shape differed from the frame (preview ≠ export).
- **"Regenerate this shot with AI" spent credits without showing a price.**
- Revisiting the editor could show an **old cached timeline** that autosave would then write over newer work.
- Two text systems, two overlay systems, captions in three places; seven fixed inspector tabs.
- Your own footage could not be AI-edited (only generated "shots" could).

## 2. Competitor patterns used ([COMPETITORS.md](COMPETITORS.md), sources included)

Premiere's click-to-select object mask and forward/backward tracking · Resolve's +/− refinement and
"window + qualifier" colour isolation · Kling's auto-select-then-brush · invideo's "agent edits are
ordinary timeline edits" and plan-and-price-before-generation · Descript/invideo's docked co-editor ·
CapCut's contextual properties · Canva's edge-drag trim · LTX/OpenArt's simple storyboard first ·
Artlist's Auto vs Advanced model choice · Runway's visible edit window.

## 3. How people use it now

**Start.** *New video* opens a hub: type the idea in any of the three languages ("cinematic 20-second ad
for my candles") and Framecraft suggests the right start (*Advertisement · vertical · 20 s · cinematic*)
— or pick one of five cards: Create with AI · Animate an image · Edit my video · Create an
advertisement · Create a film. Nothing is generated or charged on that page.

**Edit.** The editor fills the screen: tool rail (Media, Audio, Text, Stickers, Captions, Filters,
Transitions, AI tools) · preview · properties of whatever is selected · full-width timeline. Panels
resize and collapse and are remembered. Clips trim by dragging their edges; Shift-drag on the ruler
(or I / O) marks "this part", which can be cut out with the gap closed (ripple).

**Change one object.** *Select object* (V) → click it → it is outlined and a toolbar appears above the
picture: **Colour · Adjust · Blur/Pixelate · AI · For: This frame / Whole clip / Until it disappears /
Custom · Track · Refine**. Choosing an effect for more than a moment tracks the object automatically
(free). Unsure frames are marked red on the clip; drag the outline there to correct, and tracking
continues from that frame. Shift-click adds a part, Alt-click removes one.

**Objects that turn or change shape.** A click-selected object is found again on every frame by its
colour and edges, starting from points inside it that the tracker moves along, so the colour covers
its real shape when it turns (a figurine rotating from side view to front view) and the dashed outline
hugs what is really changed. Shift-click on a lit or shaded side adds that colour as part of the same
object; *Refine › Follow shape changes* switches it off. Preview (in a background worker, so playback
stays smooth) and export run the same function on the same frames.

**Ask.** The assistant (Ctrl+J) docks right, bottom or floats; it knows the selected clip, object and
range ("make *this* darker"). Everyday requests are understood instantly on the device (no AI call, no
credits) and come back as **Preview / Keep / Cancel** changes; anything that changes pixels with AI
shows *what changes, what stays, model and price* and runs only after confirmation.

**Review.** AI results wait in a bar above the editor; *Compare* opens before/after (wipe or side by
side, scrubbed together) with Accept / Reject — without leaving the timeline.

## 4. What works in reality (verified)

| Area | Evidence |
|---|---|
| Task A — assistant collapses, gives the space back, keeps conversation + draft through every dock and a reload | Playwright `editor-5.spec.ts` › A; screenshots A1–A3 |
| Task B — click a moving red box, colour → blue, auto-track (incl. growth), export: box blue at 0.4/2/3.4 s, wall untouched | Playwright › B (exported pixels), server `object-edit.test.ts` (4 tests); screenshot B1 |
| Task C — AI fix of part of a clip: selection + seconds → dialog with *what changes / what stays / ≈ 272 credits* | Checked in the browser on own footage (clip became a shot automatically); **not generated** (paid) |
| Task D — 3 clips imported, reordered, trimmed by edge-drag, title, music, dissolves, exported MP4 with the expected length and audio | Playwright › D; screenshot D1 |
| Task E — Animate an image: image first, motion presets, model explained, price shown; Generate disabled until an image is added | Checked in the browser; **not generated** (paid) |
| Task F — Ad Studio: ads open on the storyboard (cards show the real frames), edit workspace, export path unchanged | Checked in the browser (read-only on an existing ad); server suite green |
| Task G — 1366, 1920, tablet 820: no sideways scroll, preview ≥ usable size, panels never overlap, assistant fits | Playwright › G; screenshots G-* |
| Task H — speed change, blurred object, title, assistant hidden, workspace switch, reload: all saved, versions kept | Playwright › H; screenshot H |
| Simple editor at 1280×600 — split, 2× speed, black-and-white filter, a bold yellow "Sale -30%" text, saved; Pro tools opens the studio; export dialog | Playwright › S |
| Instant assistant (EN / KA / RU), ripple delete, object maths, smart select, intent hub | `packages/shared` tests (40) |
| Objects that change shape: a blob turning from wide to tall is exported blue in its new shape (the drawn outline alone misses it); a same-coloured strip leading out of the picture is not coloured; two clicked colours form one object | server `object-edit.test.ts` › shape-changing object (exported pixels); `packages/shared` tests (4) |
| Real footage (user's figurine turning, 6 s, white coat → blue) | Checked frame by frame on the server render and in the browser preview: the coat stays blue as it turns; before this change only a stripe of it did and blue leaked onto white cars |

Test totals at delivery: shared 40 ✓ · server 147 ✓ (1 skipped manual) · Playwright 10 ✓ (5 skipped
by design: they need test-fixture mode and would otherwise spend real credits) · typecheck and lint clean.
After the shape-following update: shared 45 ✓ · server 150 ✓ (1 skipped) · Playwright 10 ✓ (5 skipped by
design) · typecheck, lint and production build clean.
After the simple editor (2026-10-28): shared 45 ✓ · server 152 ✓ (1 skipped) · Playwright 11 ✓ (5 skipped
by design) · typecheck, lint and production build clean.

### Hands-on UI test of the Edit workspace (2026-10-27, evening)

A new 9:16 project was built by hand in the browser: three clips uploaded, added, split, trimmed by
the edge, reordered, deleted with undo/redo, one clip at 2×, a dissolve, a "Summer sale -30%" text,
music, a black-and-white look, the assistant ("მუსიკა უფრო ჩუმად" → music 40 % quieter, free) and an
export, read back frame by frame. Fixed on the way:

- **Texts containing "%" came out empty in the preview and in the export** (FFmpeg text expansion) —
  every user text is literal now (titles, layers, shape labels, subtitles); regression test.
- **Transitions were invisible in the preview** — they now play there as in the export, and a marker on
  the timeline opens the transition setting. Transition names are readable, with a seconds unit.
- **A text added at the playhead was invisible** (first frame of its entrance animation) — the selected
  layer shows settled while paused; clicking a layer bar puts the playhead inside it.
- **The tool panel could not be opened** while the assistant was docked right on a narrow screen.
- Time display showed frames after a dot (00:11.24 meant 11.8 s) — now hundredths of a second.
- Looks show a swatch and which one is active; storyboard cards and the timeline strip show each
  clip's look; generated audio is named by type and date; the export dialog plays the result; the
  audio import and upload questions fit audio; short screens give the timeline room for its lanes.

### Design pass for small laptop screens (2026-10-27, night)

Checked on a 1280×585 browser viewport (the owner's laptop):

- **One header row** in the editor — the app bar's home link, search, credits and notifications live
  in the editor's own header, giving the workspace 48 px more height; the timeline also has a single
  header row (title, zoom, clip tools, + Clip, Upload). Result: a larger preview, more inspector
  controls in view, and the layer, video and music lanes all visible without scrolling.
- **Clip tools above the timeline** (split, duplicate, freeze, delete) whenever a clip is selected;
  split takes the clip under the playhead if the selection is elsewhere (never a silent no-op).
- **Inspector** leads with speed, volume and transition; plain labels; the tool panel can be opened
  beside a docked assistant; the Shot editor fits with its own play bar.
- **Captions**: lines can be typed and edited by hand (free); automatic subtitles show what is
  transcribed and the price and wait for a click (they used to run — and charge — on one click);
  their times now follow the clip's position, trim and speed; "no speech found" is said plainly.

### Simple editor by default (2026-10-28)

The full studio was too busy for everyday edits. Own videos now open in a **simple editor**; *Pro tools*
in the header switches to the full studio (remembered per browser). AI films and ads keep the studio.

- **A big picture, one toolbar, the timeline.** Toolbar left: Video, Upload, Text, Music, Captions,
  Format. Middle: frame step, play, time, full screen. Right: tools for what is selected — a clip:
  Split, Speed, Sound, Filter, Transition, Duplicate, Delete; a text: Edit, Duplicate, Delete; music:
  Volume, Delete. At 1280×585 the picture grew from 84×151 to 124×222 px (9:16).
- **Panels open beside the picture**, never over the header or the timeline, so a change is seen while
  it is made. A panel belongs to the clip or text it was opened for and closes when another one is
  selected; Esc closes it.
- **Text** goes on a free lane (never on top of another text) and opens for typing at once; timeline
  lanes are named (Text, Stickers, Pictures …).
- Kept for Pro tools: workspace tabs, object selection and tracking, colour grading, layers, camera,
  AI edits, versions and the assistant.
- Server tests write their scratch files into one folder per run, removed at the end. A full Playwright
  run had failed only because the disk was full, partly from folders earlier test runs left behind.

## 5. Code map (new or rebuilt)

- `packages/shared/src/objects.ts` — object edits (selection, time scope, effects), transforms, colour function (incl. colourising grey/black objects), track merge.
- `packages/shared/src/segment.ts` — click-to-select (minimax geodesic in CIELAB + edges, automatic edge threshold, marching-squares outline); `adaptiveMask` finds a selected object again on another frame (grown from tracked interior points, cut where it would run out of the search window into background).
- `apps/web/src/lib/adapt.worker.ts` — the preview's per-frame object search off the main thread.
- `packages/shared/src/quick.ts` · `edit.ts` — instant assistant and the new plan operations (object, look, volume, cut range…), `rippleDelete`.
- `packages/shared/src/intent.ts` — "what do you want to make" suggestion.
- `apps/server/src/media/object-fx.ts` — export of object edits (per-frame mask video + FFmpeg compositing; shape-following objects are found again in the decoded source frames); `tracker.ts` — median-flow point tracking (pyramidal Lucas–Kanade, forward–backward check) seeded inside the selection outline, with template re-acquisition when points are lost.
- `apps/server/src/editing/versions.ts` — `ensureClipShot` (own footage → shot); routes `POST /api/projects/:id/shots/from-clip`, `GET /api/shots/:id/regenerate/estimate`.
- `apps/web/src/app/app/editor/[id]/page.tsx` — the workspace; `components/editor/{preview,inspector,assistant,object-tool,storyboard,review,editor-dialogs}.tsx`; `lib/{editor-ui,assistant,object-ui,plan-describe,shot-context}.ts`.
- `apps/web/src/components/editor/grade-canvas.tsx` — WebGL preview now crops exactly like the export and draws object effects.
- `apps/web/src/app/app/new/page.tsx` — creation hub; `composer.tsx` — *Animate an image* mode.

## 6. Still incomplete (honest)

- **Selection is colour/edge based, not a segmentation model.** Excellent for objects that differ from their surroundings (clothes, products, signs); busy textures need Refine (Shift/Alt-click, edge slider). A SAM-style model can plug into the same place later (it needs a model download or a paid API — not done without approval).
- **Shape following is colour based.** It covers an object that turns or deforms as long as it differs from its surroundings. A same-coloured background touching it with almost no edge can still be partly included (a white rail behind a white coat). Very bright highlights or deep shade may need one Shift-click to add that shade. A white syringe held against a white coat is the same colour, so it is included until removed with Alt-click, which removes the clicked region as drawn (moving with the track).
- **Drawn rectangles, brush strokes and inverted selections** move and scale with the track but do not change shape.
- Not built: timeline multi-select, speed ramps, keyframe curves for object effects, GIF stickers, a sound-effects library, solo/lock for the video lane, layer grouping.
- Assistant conversations are stored in the browser (per project), not synced between devices.
- Blur, pixelate and feathering in the *preview* are close approximations; colour is exact (same LUT as export).
- Headless browsers without WebGL2 show a note instead of the colour preview (the export is unaffected).

## 7. What needs paid AI

Generating videos/images/voice/music; AI edits of footage (remove, replace, fix, restyle, relight,
background, reframe/outpaint, camera remix); regenerating a shot; AI planning of complex assistant
requests (Claude — free to the user, paid by the platform). Everything else — editing, colour, object
recolour/adjust/blur, tracking, beat detection, captions styling, export — is free and local.

## 8. Provider limits that shape the UX

- Runway Aleph accepts **no mask**: Framecraft composites the result back so pixels outside the selection stay exact; inside, the model is asked to keep everything else but cannot guarantee identical pixels (said in the dialog).
- AI edit windows are limited per request (the dialog shows the seconds actually sent, with context).
- Video models speak English/Chinese only; Georgian/Russian speech comes from the voice-over (ElevenLabs).

## 9. Screenshots

![Assistant docked](screenshots/A1-assistant-docked.png)
![Assistant collapsed — space given back](screenshots/A2-assistant-collapsed.png)
![Floating assistant](screenshots/A3-assistant-floating.png)
![Object selected, recoloured and tracked](screenshots/B1-object-recoloured.png)
![Manual edit](screenshots/D1-manual-edit.png)
![1366 with assistant](screenshots/G-1366-assistant.png)
![1920](screenshots/G-1920.png)
![Tablet](screenshots/G-tablet.png)
![After reload](screenshots/H-after-reload.png)
![New video hub on a phone](screenshots/mobile-new-video.png)
