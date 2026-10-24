# Implementation Status

_Last updated: 2026-10-25._ Verification legend: **✅ verified** (automated tests and/or exercised in a real browser), **🔑 needs credentials** (code complete, mocked-contract tested only), **🟡 partial**, **⬜ not implemented**.

## Test results at this checkpoint

| Suite | Result |
|---|---|
| `pnpm typecheck` (server, web, shared) | ✅ clean |
| `pnpm lint` (ESLint + typescript-eslint + Next + React Hooks) | ✅ clean |
| `packages/shared` unit tests | ✅ 18/18 |
| `apps/server` unit + integration tests (PGlite Postgres, real FFmpeg, mocked provider HTTP) | ✅ 103/103 |
| Playwright E2E (desktop + Pixel 7) on an isolated fixture stack (live generation off, separate DB) | ✅ 9/10 — the admin test needs `pnpm db:seed` on that DB; incl. the new editor-studio walkthrough. On the live dev server the paid paths skip themselves |
| `pnpm build` (server bundle + Next.js production build, 22 routes) | ✅ |
| Server bundle runs migrations; provider check CLI runs | ✅ |
| Docker images / compose | ⬜ written, **not executed** (Docker not installed on this machine) |
| Real paid provider requests | ✅ live with user-authorised keys (Runway Kling 3.0 + muse_image, ElevenLabs TTS, Claude). fal.ai not funded, so it is off |

## Completed and verified ✅
- **Foundation**: pnpm monorepo, design system (premium dark, iris accent, Geist / Instrument Serif / Noto Sans Georgian), landing page with live catalog and pricing (illustrations labelled, no fake proof), legal starter pages.
- **Auth**: email/password (scrypt), hashed session tokens, httpOnly cookies, CSRF origin check, rate limits, roles, suspension, password change, account deletion (removes media).
- **Database**: Drizzle schema (30+ tables, FKs, indexes, check constraints), 2 migrations, seed data (plans, packs, templates, demo users).
- **Model registry**: 31 video models, 5 image models, 6 audio models, verified against official docs 2026-10-21, with status, pricing confidence and docs links. Admin overrides persist across catalog syncs.
- **Routing & cost engine**: hard-requirement filtering, quality bar per mode with complexity bump, never downgrades, segment stitching only when it saves ≥40%, budget limits, manual model choice, alternatives, explanations, reliability-weighted cost, measured-quality takeover.
- **Pricing**: markup, minimum-margin floor, confidence buffers, unverified pricing blocked, reconciliation to the real provider cost.
- **Billing**: wallet, append-only ledger, atomic reservations (concurrency-tested), idempotent settlement, refund policy, spending limits (user, per job, global daily kill-switch), plans, packs, subscriptions, sandbox checkout, Stripe adapter with signature verification and event de-duplication.
- **Queue & workers**: Postgres queue (SKIP LOCKED), transactional enqueue, reschedule-polling, retry with backoff, stale-lock reclaim, expired-reservation sweep, embedded worker for dev, separate workers for production.
- **Generation pipeline**: checkpointed and re-entrant; never blindly resubmits after a crash; output validation (ffprobe); continuity chaining via last frame; conforming; thumbnails; cancellation; bounded retries; notifications; job state survives restarts.
- **Dev fixtures**: labelled FFmpeg test videos and placeholder frames, never charged, impossible in production.
- **Media/FFmpeg**: normalise, join (xfade when available, fade-through-black fallback), trim, crop/pad, text overlays (Unicode incl. Georgian/Cyrillic), burned subtitles, audio mixing with fades, logo overlay, export presets.
- **Quick Create**: prompt → live estimate with routing reasoning → generate → honest phase/progress → preview with safe-area overlays → download → edit.
- **Social Studio**: 19 templates with real workflows (single clip, multi-shot beat planner with per-shot estimates and batch generation, movie hand-off), 3 creative concepts, hooks, titles, captions, hashtags and script (EN/KA/RU).
- **Cinematic Studio**: camera, lens, lighting, grade, mood, shot type, first/last frame, references, manual model, draft pass, min resolution, negative prompt, native audio.
- **AI Movie Maker**: brief → plan job → screenplay (Claude, or offline planner clearly labelled) → characters, locations, scenes, shots → Director Mode editing (prompt, duration, camera, shot type, dialogue, model, add/delete/reorder) → storyboard frames → budget with model mix → explicit approval → atomic multi-shot reservation → generation → resume with only missing shots → auto-assembly → render.
- **Movie photo references (photo1, photo2…)**: upload your own photos, insert tokens into the story, add optional notes. Claude vision (or an offline EN/KA/RU heuristic) maps each photo to a character, location or object; the photos become character/location/shot references for reference-capable models. Tokens never reach video prompts. If no model in the plan offers native audio with references, references win and the shot is flagged "voice-over needed".
- **Chat mode (AI Movie Maker) and Ad Studio**: conversations with the AI Director (Claude, fast tier) that keep a working brief: idea → screenplay card (characters, scenes, shots, dialogue) → edit by chatting (the model revises the current plan, including Director-mode edits) or in Director view → approve → budget card (shots, voices, music, keyframes) → Generate (explicit button; the model never spends) → live production card (keyframes, shots with thumbnails, voices/music, final render) → film card (player, download, open in editor). Form mode stays available (switch at the top). Ad Studio collects business info, reads pasted links (SSRF-guarded: public http(s) only, redirects re-checked, size/time caps), takes logo and product photos, pitches three ad concepts (Claude, smart tier) and turns the chosen one into a film with narrator voice-over, music, the logo in the corner, a logo end card and the call to action. Replies follow the user's language (KA/RU/EN).
- **Keyframes (consistent characters on cheap models)**: films draw each shot's first frame with an image model given the characters', location's and objects' photos (Runway muse_image, ~$0.01/frame), then animate it image-to-video — identity comes from the frame, so the cheapest i2v models qualify. Two-phase film job (frames → shots) committed within the approved budget; shots longer than a model's max are continued from their last frame. Single videos (Quick/Cinematic/Social) do the same when characters/locations are picked (re-entrant frame step, cost included in the estimate). Up to 10-minute films on the Studio plan.
- **Characters & locations everywhere**: a cast picker in every composer (saved characters/locations with photos, create one in place with consent capture); locations are now part of the generation spec (photos + description).
- **Soundtrack**: ElevenLabs film score across the film (quieter under dialogue) and ambience beds per scene for silent or dubbed shots; included in the budget.
- **Voice takes**: every re-voice keeps earlier takes; one take per line is used (newest by default, any earlier one selectable), dubbed shots mute the clip's own audio so two voices never play together.
- **Logo end cards**: shots showing the brand logo are built by FFmpeg from the exact logo file (free, no model moderation, pixel-exact) instead of being sent to a video model.
- **Editor studio** (`/app/editor/:id`): workspaces Story graph · Timeline edit · Shot editor · Review, plus a floating AI assistant.
  - *Story graph* (React Flow): shots as connected nodes (thumbnail, duration, version, source, camera, comments, AI-edit status), FILM START, scene frames that collapse, version branches with the active one marked, minimap, zoom/fit, auto layout, snapping, multi-select. Edges are the real playback order — the same timeline the editor renders, so graph and timeline never disagree; connecting A→B moves B after A, deleting an edge/node takes the shot out of the movie (kept in the project), detached shots connect back in. Undo/redo covers it. Layout persists per project.
  - *Shot editor*: frame-accurate player (frame step, I/O range marks, shift-drag range), selection tools (rectangle, ellipse, brush, lasso, eraser, subtract, invert, feather, comment pins), AI edit modes (fix, replace, remove, add, restyle, relight, background, modify motion, enhance, reframe/outpaint, camera remix) with a live cost estimate and honest notes, **edit frame → apply to video** (grab frame → AI image edit or own retouch → guide keyframe), comments with statuses and **Send to AI**, per-shot assistant conversation, versions (rename, use in movie, compare), compare view (wipe / side by side, synced) with accept / reject.
  - *Localized AI editing engine* (Runway **aleph2** video-to-video): only the selected range plus 1 s context is extracted and sent (≤30 s, ≤5 MB inline); the result is conformed (size, fps), spliced back so everything outside the range is the original, blended in **only inside the mask** (local feathered compositing — the provider takes no mask), original audio kept; saved as a new immutable version; the active version changes only on accept (atomic); failures refund the reservation. Re-entrant job (Runway task id checkpointed, resumes after restarts).
  - *Precise 2D camera*: drag/zoom the framing window on the video (corner, slider, wheel, arrows), keyframes at the playhead, ease/linear, rotation, presets (push in, pull out, pans, tilts, dolly, zoom to point, handheld, tracking) with intensity; motion path, start/end frames, thirds guides; preview = export (shared maths, FFmpeg zoompan/rotate).
  - *Colour*: exposure, brightness, contrast, highlights, shadows, saturation, temperature, tint, hue, blur, sharpen, vignette — one shared grade model drives the SVG preview filter and the FFmpeg export (blur/sharpen/vignette approximate in preview).
  - *Timeline*: clip speed 0.25–4×, reverse, freeze frames, fades, opacity, duplicate, overlay track V2 (images/videos, position/size/opacity), audio mute/solo; all rendered in the MP4 (pixel-checked in tests).
  - *AI assistant*: scope (shot / selected seconds / whole movie); returns an explicit plan — free deterministic operations (trim, speed, transition, colour, match colour, camera preset, fade, move, remove, title) apply on click and are undoable; generative operations show their credit cost and run only on confirmation; out-of-scope operations are blocked, never applied.
- **Editor**: multi-track timeline (ruler, playhead, zoom; video with thumbnails, voices, music & sound, text, subtitles at real times; drag to reorder); preview honours clip volume; audio players keyed per file.
- **Dubbed dialogue for non-English films**: video models speak English well but Georgian/Russian with a foreign accent, so for those languages the video prompt asks for lip movement + ambience only and every line is voiced by ElevenLabs (eleven_v4, explicit language code). Each character gets one stable voice cast by gender (AI Director field, or an EN/KA/RU heuristic). Voices are laid onto the timeline in sync with their shot, subtitles follow the voices, and clip audio is ducked (or muted when the old video spoke the lines). Dialogue cost is part of the approved film budget. 'Re-voice the dialogue' re-records a finished film without regenerating video (identical lines reused free). Per-language voice lists live in Admin config 'voices'; /api/admin/voices/library + /adopt find and add native-speaker voices from the ElevenLabs Voice Library (needs the key's Voices read/write permissions).
- **Character & Location libraries**: CRUD, reference images, likeness-consent capture, character-sheet generation.
- **Editor**: sequential preview with overlays, timeline (drag reorder), trim, split, replace, transitions, volume, regenerate shot, audio tracks, text, subtitles, voice-over (TTS), auto-subtitles (STT), logo, format/resolution, undo/redo, keyboard shortcuts, autosave, versions/restore, export with progress.
- **Progress & ETA everywhere**: real provider percentage or an animated bar, a counting-down estimate from each model's measured history, and live provider hints ("Waiting in Runway's queue… no extra charge", "Rendering at Runway", "taking longer than usual" after 10 min without progress). The film banner summarises shots (N rendering / N waiting for a free provider slot); the ETA sums Runway's serialised shots.
- **Recovery after restarts**: the embedded worker resumes interrupted queue jobs at startup, and the maintenance sweep (every 2 min) re-queues active image/video/audio/render/plan jobs that lost their queue entry. Image jobs are now non-blocking (submit once, poll by reschedule) and resume their saved Runway task.
- **Brand logo**: free drag anywhere on the preview (pointer + arrow keys), corner presets, size/opacity, and an "Original / No background" switch (server-side flood-fill background removal with 3 strengths, cached per logo).
- **Uploads**: content sniffing (not trusting the extension), size limits, rights/likeness consent recorded, owner isolation, HMAC-signed Range-capable media URLs.
- **Admin**: metrics (users, generations, cost by model/provider, gross margin, credits, queue, storage, plan margins), provider/model toggles, credential check, price editor, pricing/routing/spending config, plans, templates, users (role, status, credits), failed jobs with refunds, quality evaluations, audit log.
- **Mobile**: bottom navigation with a prominent Create button, sheet dialogs, no horizontal overflow (E2E-tested on Pixel 7).
- **Ops tooling**: `providers:check` (free), `providers:smoke` (paid, capped, explicit flag), `admin:create`, `db:migrate`, `db:seed`, production env validation.

## Implemented but requiring credentials 🔑
- Runway, LTX, fal.ai, Google (Veo REST / Omni Interactions), Replicate video adapters: mocked contract tests only.
- fal.ai webhooks (Ed25519 verification is unit-tested with generated keys).
- ElevenLabs TTS/STT/music/SFX jobs (incl. Georgian via `eleven_v4*`), with narration de-duplication.
- Image generation (fal FLUX/Nano Banana, Runway muse/gen4 image turbo) for storyboards and character sheets.
- Claude AI Director (claude-haiku-5-5 for prompts/copy, claude-opus-5-5 for screenplays and photo understanding, with server-side refusal fallback).
- Stripe checkout and webhooks; S3/R2/MinIO storage.

## Partially implemented 🟡
- Docker/compose: written; not run on this machine.
- Gemini Omni direct: adapter present, model `unverified` (no documented duration control).
- Several fal.ai models `unverified` (schema or price not confirmed) and excluded from routing.
- Subscription cancellation is recorded locally; Stripe-side cancellation is not automated.
- Plan watermark flag and storage quotas exist but are not enforced in render/upload.

## Not implemented ⬜
- Email verification, password reset, transactional email sending (console only).
- Google OAuth sign-in (schema ready).
- Vision-based continuity QA between shots (the field `continuityFlags` exists).
- Social platform publishing / analytics (requires platform approval).
- BullMQ/Redis (deliberately replaced by the Postgres queue; see docs/ARCHITECTURE.md).

## Editor studio — honest limits
- Runway aleph2 was validated against its OpenAPI spec and with free validation requests; it has **not** yet been run with real credits from the app (mocked-contract tests). Its first live use should be reviewed.
- aleph2 accepts no mask and no reference images: masks are enforced by local compositing (pixel-exact outside, model-dependent inside); reference images are not sent (an edited guide frame is).
- Masks are static over the selected range (no subject tracking / AI subject selection — no provider for it is configured). Keep moving subjects inside a generous area or use short ranges.
- Not implemented yet: *Extend* (continuation as a new version), blend modes and multiple main video tracks, slip editing, audio waveforms and multi-frame filmstrips (single thumbnails), volume automation curves, re-grouping shots into other scenes from the graph, Remotion.

## Known issues
- Chat mode is covered by integration tests with a scripted model; replies from the real model should be reviewed in live use (each message is one Claude call). Replies are written by a queue job (`chat.turn`) while the chat shows "thinking", because a reply that writes ad ideas can take longer than the 30-second web proxy timeout.
- The embedded dev database (PGlite) is single-process. Two API processes on one directory corrupted its WAL on 2026-10-24 (recovered by pointing pg_control at the last valid checkpoint; nothing lost). The API now holds a pid lock (`.data/pglite.lock`) and refuses to open a directory that another live process has open. Keep the project's `.data` out of OneDrive sync if possible.
- Runway `muse_image` rejects `tag` on reference images (validated 2026-10-25); tags are sent only to gen4 image models. If a first frame is rejected (validation/policy), the shot continues without it instead of stalling.
- The bundled FFmpeg is a 2018 build without `xfade`. Transitions fall back to fade-through-black locally; the Docker image uses a modern FFmpeg.
- Quality tiers are provisional until real evaluations are recorded.
- Provider prices change; review Admin → Models & pricing before launch.
- Runway tier-1 accounts render **one video per model at a time** (`maxConcurrentGenerations: 1`), so film shots are serialised; higher Runway tiers or fal.ai parallelise.
- Video jobs have no hard provider timeout: a task stuck at the provider keeps polling (with a "taking longer than usual" hint) until it finishes or the user cancels, because abandoning it could still be charged by the provider.

## Steps remaining before launch
See [docs/LAUNCH_CHECKLIST.md](docs/LAUNCH_CHECKLIST.md).

## Resume notes
`pnpm install` → `pnpm dev` (web :3000, api :4000) → `pnpm test` → `npx playwright install chromium && pnpm test:e2e`. Demo accounts: `pnpm db:seed`.
