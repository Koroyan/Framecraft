# Framecraft 5.0 — working plan (overnight, autonomous)

Constraints: no paid AI/provider calls, no deploy, no publishing; tests may create local e2e users.
Commit after each phase (Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>).

## Phase 0 — research + audit (docs)
- [ ] docs/framecraft-5/COMPETITORS.md (UX matrix, sources, limitations)
- [ ] docs/framecraft-5/AUDIT.md (what is wrong now, with file refs)

## Phase 1 — workspace shell
- [ ] editor UI store (persisted): left panel open/width, inspector open/width, assistant dock (right|bottom|float|min), size, position
- [ ] Assistant: dock right/bottom/floating, minimize to button, resize, Ctrl+J, Esc, keeps conversation+draft (lifted state), never unmounts
- [ ] Contextual inspector (auto-switch by selection: clip / text layer / audio / object)
- [ ] Collapsible left tools; resizable panels; Story graph = optional "Storyboard | Graph"

## Phase 2 — timeline
- [ ] time-range selection with handles on the ruler (I/O keys), shown everywhere ("which seconds change")
- [ ] drag-trim clip edges, ripple delete, snapping, track lock/hide, waveforms, multi-select (if time)

## Phase 3 — object selection (Task B)
- [ ] shared smart-select (region growing in Lab + edges → polygon)
- [ ] click-to-select in preview + outline + floating toolbar (Change colour, Adjust, Blur, Pixelate, Track, AI: Remove/Replace/Edit)
- [ ] clip.objects[] schema (mask, track w/ scale, source range, effect) — backward compatible
- [ ] tracker: scale search + lost detection + "until it disappears"; correction keyframes
- [ ] preview (WebGL: cover-crop fix, N object slots: LUT/blur/pixelate) = export (Node mask video + ffmpeg)
- [ ] AI on objects: clip → shot on demand so uploads can be AI-edited; cost shown; never run paid

## Phase 4 — assistant acting on tools
- [ ] context (selection, playhead, range, object) sent; local free command parser for common edits; plan card Preview/Apply/Cancel

## Phase 5 — creation hub, storyboard, review, color basic/advanced
## Phase 6 — E2E (Playwright: A, D, G, H; B server-level), screenshots, DELIVERY.md
