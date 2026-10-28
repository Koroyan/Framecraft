# Competitor research — AI inside the story (Framecraft 6.0, 2026-10-29)

How this was researched: web search and the vendors' own pages where they could be read. No accounts
were created and nothing was used hands-on, so this is about documented and reported behaviour.
Third-party reviews are marked as such. The Framecraft 5.0 matrix covers the editing tools
(Premiere, Resolve, CapCut, Canva, invideo, Descript, Runway, Kling, LTX, Flova, FLORA, OpenArt,
Artlist): see [../framecraft-5/COMPETITORS.md](../framecraft-5/COMPETITORS.md). This round looks
at canvas agents, storyboards, character consistency and brand animation.

| Product | What is useful | What we avoid |
|---|---|---|
| **FLORA** (node canvas) | Models, "actions" (one-step edits with real controls, e.g. a relighter with light/colour/exposure) and saved multi-step "techniques" live on one canvas; status is shown **inside the node** ("Relighting…"); ready templates; "Real controls, not re-rolls" ¹ | A steep learning curve is reported ² — the graph must not be the beginner's default; FLORA's agent is now offered through MCP with external chat apps ¹ rather than inside the canvas |
| **Flova** (agent workspace) | The agent turns an idea into key elements, shots and audio layers; local storyboard edits for a single shot; **a character is an asset, not a phrase repeated in prompts**; project memory of assets ³ | Consistency of identity and props still needs manual checking ³ — so we say so instead of promising it |
| **LTX Studio** | **Elements**: characters as reusable assets tagged with @ in prompts, voices attached to the character; reference images with front views and neutral backgrounds; the storyboard builder makes shot-level boards and Elements from a script; Retake changes one moment of a shot ⁴ ⁵ | — |
| **Google Flow** | **Ingredients** (subject/style references), **Frames to video** (start/end frame), **Jump to** (a new shot keeping context), **Extend** (continue the action from the last frames), Scenebuilder as the sequence ⁶ | — |
| **Kling** | Element Library: multi-angle reference images per character/item/scene; since Feb 2026 a **voice can be bound to a character element** ⁷ | Detailed limits were not documented in what we could read |
| **OpenArt** | A consistent character from one image or text, a step-by-step character builder, story → script → storyboard → clips ⁸ | Reported to let **protected characters** slip through in some flows ⁸ — Framecraft refuses them by name and uses original style definitions |
| **Runway** | References (up to three images called in the prompt) and **stills first, then animate** to avoid paying for repeated video ⁹ (third-party) | — |
| **invideo** | Agent workflows that **ask questions and offer options** instead of a blank prompt (Agent Two Workflows, Aug 2026); a storyboard-first pipeline with locked character and world references ¹⁰ | Vendor cost claims are self-reported |
| **Descript Underlord** | An agentic co-editor in a sidebar that acts on your behalf ¹¹ | Users ask for a preview of AI decisions to accept/reject ¹¹ — Framecraft shows every step and applies only on request |
| **Pippit** (CapCut) / **Creatify** | Link-to-video, avatars, Agent Mode from one prompt; batch variations of one ad ¹² ¹³ | Avatar presenters are not what brand cartoons need |
| **Canva** | Video generation inside a familiar design tool (Magic Media) ¹⁴ | No storyboard-to-video feature could be confirmed for 2026 ¹⁴ |
| **Artlist, Premiere Pro, DaVinci Resolve, CapCut** | Covered in the 5.0 matrix (auto vs advanced model choice; click-to-select masks; contextual panels) | — |

## Patterns adopted in 6.0 (and where)

1. **AI where the work is** (Flova, Underlord): the AI Director is a node on the story graph, and every
   shot, scene and connection has its own Ask AI. The request already knows its target. → `story-graph.tsx`, `director-chat.tsx`
2. **Actions with real controls** (FLORA actions): AI actions are dragged onto a shot and open a small card
   with only what that action needs (camera presets, a background description, a time range). → `graph/actions.tsx`
3. **Status inside the node** (FLORA): Draft, Storyboard ready, Queued, Generating, AI editing, Needs review, Ready, Approved, Failed. → `lib/director.ts › shotState`
4. **Characters as assets with a voice** (LTX Elements, Kling, Flova): the Character Bible keeps the
   approved reference, personality, palette and voice. Shots link to characters by id, and a change
   shows which shots are affected. → `characters/page.tsx`, `movie/cartoon.ts`
5. **Continue / Jump to** (Google Flow Extend): "Continue" makes a new shot that starts from the last frame of
   the shot before it. The frame is extracted with FFmpeg, so it is exact and free. → `director/story.ts`
6. **Stills before video** (Runway, LTX, invideo): draft = storyboard frames (still images, clearly labelled),
   final = video, each priced separately. → `graph/generate.tsx`
7. **Guided start** (invideo workflows): Create a Cartoon asks style, length, audience, voices, language,
   cast and an optional brand. → `app/cartoon/page.tsx`
8. **Original styles only** (vs OpenArt's reported leak): 12 original style definitions, no studio
   names, protected characters refused by name. → `packages/shared/src/cartoon.ts`

## Sources

1. FLORA official site — https://www.flora.ai/
2. Banani, "My Flora AI review" (third-party) — https://www.banani.co/blog/flora-ai-review
3. iOS Hacker, "Flova AI Review" (third-party) — https://ioshacker.com/apps/flova-ai-review-an-agent-led-workspace-for-ai-video-creation ; insMind review — https://www.insmind.com/blog/flova-ai-review/
4. LTX Studio, "Getting Started with Elements" — https://ltx.studio/blog/getting-started-with-elements ; "How To Create A Consistent AI Character" — https://ltx.studio/blog/how-to-create-a-consistent-character
5. LTX Studio release notes — https://website.ltx.studio/release-notes ; "Top LTX Studio Features" — https://ltx.studio/blog/top-ltx-studio-features
6. Google Labs Flow FAQ — https://labs.google/fx/tools/flow/faq ; Google blog, "5 tips for getting started with Flow" — https://blog.google/technology/ai/flow-video-tips/
7. Kling Element Library user guide — https://kling.ai/quickstart/klingai-element-library-3-user-guide
8. TechCrunch on OpenArt — https://techcrunch.com/?p=3035461 ; BFL case study — https://bfl.ai/blog/openart-with-flux1-kontext
9. The AI Untangled (third-party) — https://theaiuntangled.substack.com/p/how-to-create-consistent-character ; Runway Academy — https://academy.runway.com/tutorials
10. invideo, "Introducing Workflows in Agent Two" — https://invideo.io/news/introducing-workflows-invideo-agent-two/ ; invideo FAQ — https://invideo.io/faq/what-is-the-best-workflow-for-going-from-storyboard-to/
11. Descript help, "Underlord (beta)" — https://help.descript.com/hc/en-us/articles/36803785502221 ; feature request — https://feedback.descript.com/feature-requests/p/get-underlord-to-auto-edit-using-my-past-projects-saved-layouts
12. Pippit newsroom — https://pippit.capcut.com/business/newsroom/capcut-commerce-pro-rebrands-to-pippit
13. Creatify — https://creatify.ai/creative-testing ; https://creatify.ai/blog/turn-product-link-into-a-video-ad-with-ai-(make-a-video-ad-with-ai)
14. VentureBeat on Canva Magic Studio — https://venturebeat.com/ai/canva-adds-generative-video-with-runway-and-new-ai-powered-magic-studio ; Pillitteri guide (third-party, 2026) — https://pasqualepillitteri.it/en/news/601/canva-ai-magic-studio-guide
