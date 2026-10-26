# Competitor UX matrix (Framecraft 5.0 research, 2026-10-27)

How this was researched: web search and official help pages where they were reachable. Several
official pages could not be read by the research tool (Adobe help → HTTP 403; Canva, CapCut and
DaVinci official pages are JavaScript-heavy and returned no usable text), so a few rows rest on
reputable secondary sources (vendor community posts by staff, help-center articles of partners,
tutorial sites). Every row says where its facts come from. Nothing here was observed by signing in
to the products — no accounts were created for this research.

## Matrix

| Product | First screen / start | Editing existing clips | Selecting an object | Timeline | AI ↔ manual | Undo / versions / compare | What we adopt | What we avoid |
|---|---|---|---|---|---|---|---|---|
| **Premiere Pro** (Object Mask, 2025 beta → release) | Project + bins | Pro NLE | Hover the Program Monitor: objects are *identified as you hover*; click creates a mask; rectangle/lasso when nothing is highlighted ¹ | Pro multitrack | Tracking via ◀ ▶ buttons in *Effect Controls → Unassigned Masks*; effects dragged from a different panel attach to the mask ¹ | Undo stack | **Click to select on the preview; forward/backward tracking; masks combine add/subtract/intersect** | Hunting through three panels (Program Monitor → Effect Controls → Effects) to finish one edit |
| **DaVinci Resolve** (Magic Mask 2) | Media / Cut / Edit / Fusion / Color / Fairlight pages | Pro NLE | Click (+) on the subject, (−) to subtract, then track forward / backward; Faster vs Better quality ² | Pro multitrack | Masks live in Color page nodes (window + qualifier + tracker) | Node versions, stills | **+ / − refinement clicks; "window + qualifier" so a recolour only hits the object's colour inside a tracked area** | Page-switching mental model; refining could block re-tracking (beta reports) ² |
| **CapCut** (desktop) | Media panel · player · properties · timeline | Drag, split, speed, keyframes | Tracking box over the subject (right panel → Tracking); masks for removals; "smart cutout" for backgrounds ³ | Basic by default, detailed view on demand; panels resizable/detachable ³ | AI effects as one-click items | Undo | **Contextual properties panel; resizable panels; detailed timeline only when needed** | Object removal via duplicate-track + mask workaround ³ |
| **Canva** video | Templates + blank sizes | Simple | — (no object masking) | Bottom timeline, drag edges to trim, **S** splits, *hover between clips to add a transition* ⁴ | AI as "Apps" | Undo | **Hover-between-clips transitions, edge-drag trim, sidebar categories (Uploads / Elements / Text / Apps)** | Advanced tools hidden in "Apps" |
| **invideo** (Editor + agent) | Prompt box | Multitrack, keyframes, colour, mixer ⁵ | Not described | Same multitrack for agent and human ⁵ | **Agent chat in a side panel edits the timeline directly; changes are ordinary clips you can reshape or undo** ⁵; ask for a plan and a credit estimate before generating ⁶ | Undo | **Assistant produces normal, editable timeline operations; plan + cost before paid work** | No visible review step for agent edits ⁵ |
| **Descript** (Underlord) | Script / transcript | Transcript-first | — | New timeline in Labs | Sidebar co-editor executing plain-language instructions; user keeps final control ⁷ | Undo | **Docked assistant as a junior editor; multi-step instructions** | Transcript-only mental model for visual edits |
| **Runway** (Aleph / Aleph 2.0) | Apps → Edit Video | Prompted video-to-video; ≤5 s per generation, trimming window picks the part ⁸ | Prompt-based (no mask); 2.0: edit one frame → propagate ⁸ | — | Action-verb prompts: add / remove / change / replace / relight / restyle ⁸ | Generations list | **Visible ≤5 s window handles; action-verb chips; "edit a frame then apply to video"** | Hidden cropping/trimming of uploads |
| **Kling** | Text / image → video | — | Motion Brush: *automatic selection or manual brushing*, up to 6 elements, Static Brush pins areas ⁹ | — | Trajectory per element + "element + motion" prompt ⁹ | Generations list | **Auto-select first, brush as correction; pin static areas** | — |
| **LTX Studio** | Script → storyboard | Shots in a storyboard; Retake reshapes moments in a shot ¹⁰ | — | Storyboard | Script split into scenes/shots, *reviewed and merged/split before any generation* ¹⁰; Elements tagged with @ ¹⁰ | Shot versions | **Plan preview before spending; simple storyboard; @ elements (we already have @mentions)** | — |
| **Flova** | Agent brief | Agent assembles timeline ¹¹ | — | Timeline | Agent plans shots, catches missing pieces *before credits are spent*; project memory of approved assets ¹¹ | — | **Pre-flight check before paid generation** | Opaque agent decisions |
| **FLORA** | Infinite node canvas | — | — | — | Text → image → video node chains; Fauna agent builds graphs ¹² | Version history | Graph as an **optional** advanced view | Reviewers report a steep learning curve ¹² — not a beginner default |
| **OpenArt** | One-click story templates (Character Vlog, Music Video, Explainer) ¹³ | Edit clips in storyboard mode ¹³ | — | Storyboard | Director: chat-driven long videos ¹³ | — | **Few, clear starting points** | — |
| **Artlist** | Standard mode (pick model) vs Agent mode (chat) ¹⁴ | — | — | — | Same prompt across many models ¹⁴ | — | **Auto (recommended) vs Advanced (choose model)** | Model zoo as the first decision |

## Patterns adopted in Framecraft 5.0 (and where)

1. **Click the object in the preview → it is outlined → a floating toolbar offers only relevant actions** (Premiere's click-to-select + our own toolbar instead of three panels). → `ObjectSelect` in the editor preview.
2. **+ / − refinement** (Resolve): Shift-click adds a region, Alt-click removes one; brush / lasso / rectangle remain as corrections (Kling, Premiere).
3. **Window + qualifier** (Resolve): "Change colour" recolours only the object's colour inside the tracked area, so a moving window does not need a perfect per-frame outline.
4. **Track forward/backward with visible confidence** (Premiere, Resolve): our tracker marks uncertain frames on the time bar and offers a one-click correction there.
5. **Explicit time scope** (Runway's trimming window, made visible everywhere): every object edit shows *This frame / Whole clip / Until it disappears / Custom range* with handles and the exact seconds.
6. **Agent edits are ordinary edits** (invideo): the assistant produces normal timeline operations (undoable, adjustable); paid work always shows a plan + cost first (invideo, Flova, LTX).
7. **Dockable co-editor** (Descript, invideo): the assistant docks right/bottom/floating, minimises to a button and never resets its conversation.
8. **Contextual properties** (CapCut): the inspector follows the selection.
9. **Hover between clips to add a transition; drag edges to trim** (Canva).
10. **Simple storyboard first, node graph optional** (LTX, OpenArt vs FLORA's learning curve).
11. **Auto model choice with an Advanced override** (Artlist).

## Sources

1. Adobe staff quick start, Premiere Pro beta masking tools — https://community.adobe.com/t5/premiere-pro-beta-discussions/now-in-premiere-pro-beta-new-masking-tools/m-p/15493611 (official help page https://helpx.adobe.com/premiere-pro/using/object-masking.html returned 403 to the research tool)
2. Blackmagic forum threads on Magic Mask 2 tracking — https://forum.blackmagicdesign.com/viewtopic.php?p=1148559 , https://forum.blackmagicdesign.com/viewtopic.php?p=1153142 ; tutorial: https://creativevideotips.com/tutorials/never-retrack-magic-mask
3. CapCut tracking/removal guides — https://www.miracamp.com/learn/capcut/motion-tracking , https://www.capcut.com/resource/video-editors-to-remove-objects , https://www.capcut.com/resource/how-to-add-keyframes-in-capcut
4. Canva editing guide (Primal Video) — https://primalvideo.com/video-creation/editing/how-to-edit-video-in-canva-updated-step-by-step-beginner-guide/
5. invideo Editor — https://help.invideo.io/en/articles/16819946-introducing-invideo-editor ; https://invideo.io/faq/can-i-manually-change-edits-made-by-an-ai-editing-agent/
6. invideo FAQ (plan and credit estimate before generating) — https://invideo.io/faq/how-do-you-add-a-new-scene-to-an-ai-video-project-using/
7. Descript Labs / Underlord — https://help.descript.com/account-and-app-settings/labs ; https://chasejarvis.com/blog/descript-underlord-ai/
8. Runway Help Center (Aleph; Aleph 2.0 prompting guide) — https://help.runwayml.com/hc/en-us/articles/43176400374419 , https://help.runwayml.com/hc/en-us/articles/52150503729171-Aleph-2-0-Prompting-Guide
9. Kling Motion Brush quick start — https://kling.ai/quickstart/how-to-animate-image-parts
10. LTX Studio blog (Elements, storyboard generator) — https://ltx.studio/blog/getting-started-with-elements , https://ltx.studio/blog/ltx-storyboard-generator-update
11. Flova reviews — https://ioshacker.com/apps/flova-ai-review-an-agent-led-workspace-for-ai-video-creation , https://navtools.ai/tool/flova-ai
12. FLORA review — https://www.banani.co/blog/flora-ai-review
13. OpenArt story / Director coverage — https://bfl.ai/blog/openart-with-flux1-kontext , https://techcrunch.com/?p=3035461
14. Artlist AI toolkit — https://artlist.io/ai/video-generator , https://www.mindstudio.ai/blog/artlist-studio-left-beta-6-video-models-workflow-tricks
