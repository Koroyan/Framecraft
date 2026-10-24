# Model integration status

_Catalog verified against official provider documentation on **2026-10-21**. Source of truth: `apps/server/src/catalog/`. This table is generated from that code._

## What has and has not been verified

| Provider | Adapter | Verified against docs | Mocked contract tests | Real paid request executed |
|---|---|---|---|---|
| Runway Developer API | `providers/video/runway.ts` | Yes — endpoints, `X-Runway-Version: 2024-11-06`, ratios, durations, credit prices, task states, `failureCode`s | Yes | **No** — needs `RUNWAYML_API_SECRET` |
| LTX API (direct) | `providers/video/ltx.ts` | Yes — `/v2/text-to-video`, `/v2/image-to-video`, `camera_motion`, resolutions, prices | Yes | **No** — needs `LTX_API_KEY` |
| fal.ai queue | `providers/video/fal.ts` | Yes — queue URLs, `Key` auth, Ed25519 webhook verification; per-model schemas partly | Yes | **No** — needs `FAL_KEY` |
| Google Gemini API | `providers/video/google.ts` | Veo REST shape; Omni Interactions API partly | Yes | **No** — needs `GEMINI_API_KEY` |
| Replicate | `providers/video/replicate.ts` | Generic predictions API | Yes | **No** (no models enabled) |
| ElevenLabs | `providers/audio/elevenlabs.ts` | TTS, STT (Scribe v2), SFX, Music endpoints; Georgian support per model | Request-shape unit coverage only | **No** — needs `ELEVENLABS_API_KEY` |
| Anthropic (AI Director) | `director/llm.ts` | SDK 1.0.0 structured outputs, server-side refusal fallback | Fake-LLM tests | **No** — needs `ANTHROPIC_API_KEY` |

**No real paid generation has been executed.** All provider integrations have passed mocked HTTP contract tests only. Run `pnpm providers:check` (free, read-only) and then `pnpm providers:smoke` (paid, capped) after adding keys.

## Notable findings at verification time

- **Google Veo 3.1 preview models on the Gemini API were announced to shut down on 2026-10-22.** They're catalogued as `discontinued`. Veo 3.1 / Veo 3.1 Fast remain available **via Runway** (`runway:veo3.1`, `runway:veo3.1_fast`).
- `fal-ai/veo3.1` is announced for deprecation on 2026-11-17 and is not routed.
- Gemini Omni 1.1 Flash (direct) has no documented duration parameter, so requested lengths can't be guaranteed. It's catalogued as `unverified`; the Runway route `runway:gemini_omni_flash_1.1` documents duration and is routed.
- fal.ai's `/pricing` summary table is stale for some models. **Kling 3.0 on fal was re-verified on 2026-10-22 from the model pages**: Standard $0.084/s (audio off) and $0.126/s (audio on); Pro $0.112/s and $0.168/s. Both text-to-video and image-to-video endpoints are routed. They're slightly cheaper than the Runway route for the same model, so the router prefers fal when both keys are present.
- fal Seedance 2.5 (~$0.57/s at 720p) is more expensive than Runway's $0.30/s; fal Seedance 2.0 / 2.0 Fast ($0.30 / $0.24 per second) are not catalogued because cheaper same-tier models exist. Grok Imagine 1.5 and PixVerse V6 prices on fal remain inconsistent and those models stay `unverified`.
- Several models are described as having "native audio" but expose no request parameter for it. They're treated as **no audio** for routing, so audio is never promised without a documented switch.
- MiniMax H3 resolutions are 768p / 2K natively; they're listed as the 720p / 1440p tiers so resolution is never overstated.

## Quality tiers (\*)

Tiers 1–5 are **provisional editorial priors** based on each vendor's own positioning (flagship / standard / fast / lite). They are **not benchmark results**. Once an administrator records at least `minEvaluationsForMeasured` real ratings for a model (Admin → Failed jobs & QA → *Record a quality evaluation*), routing uses the measured mean instead. Admins can override tiers directly.

## Catalog

Legend: `+a` = price with native audio; a resolution without `+a` = price without audio, or the same price either way. Routed = eligible for automatic routing (active/preview and pricing not unverified; admins can still disable).

| Model key | Name | Status | Routed | Modes | Res | Duration | Native audio | Refs | Price (USD/s) | Pricing | Tier* |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `runway:gen4_turbo` | Runway Gen-4 Turbo | active | yes | image-to-video | 720p | 2–10s | none | 0 | 720p: 0.05 | verified | 3 |
| `runway:gen4.5` | Runway Gen-4.5 | active | yes | text-to-video, image-to-video | 720p | 2–10s | none | 0 | 720p: 0.12 | verified | 4 |
| `runway:veo3.1` | Google Veo 3.1 (via Runway) | active | yes | text-to-video, image-to-video, first-last-frame | 720p, 1080p | 4/6/8s | optional | 0 | 720p+a: 0.4<br>1080p+a: 0.4<br>720p: 0.2<br>1080p: 0.2 | verified | 5 |
| `runway:veo3.1_fast` | Google Veo 3.1 Fast (via Runway) | active | yes | text-to-video, image-to-video, first-last-frame | 720p, 1080p | 4/6/8s | optional | 0 | 720p+a: 0.15<br>1080p+a: 0.15<br>720p: 0.1<br>1080p: 0.1 | verified | 4 |
| `runway:kling3.0_standard` | Kling 3.0 Standard (via Runway) | active | yes | text-to-video, image-to-video, first-last-frame | 720p | 3–15s | optional | 0 | 720p: 0.09<br>720p+a: 0.13 | verified | 4 |
| `runway:kling3.0_pro` | Kling 3.0 Pro (via Runway) | active | yes | text-to-video, image-to-video, first-last-frame | 1080p | 3–15s | optional | 0 | 1080p: 0.12<br>1080p+a: 0.17 | verified | 5 |
| `runway:klingO3_pro` | Kling O3 Pro — references (via Runway) | active | yes | text-to-video, image-to-video, reference-to-video | 1080p | 3–15s | optional | 7 | 1080p: 0.17 | verified | 5 |
| `runway:seedance2_5` | Seedance 2.5 (via Runway) | active | yes | text-to-video, image-to-video, first-last-frame, reference-to-video | 480p, 720p, 1080p | 4–15s | optional | 4 | 480p: 0.2<br>720p: 0.3<br>1080p: 0.68 | partial | 5 |
| `runway:seedance2_mini` | Seedance 2 Mini (via Runway) | active | yes | text-to-video, image-to-video | 480p, 720p | 4–15s | optional | 0 | 480p: 0.16<br>720p: 0.16 | verified | 3 |
| `runway:hailuo3` | MiniMax H3 (via Runway) | active | yes | text-to-video, image-to-video, first-last-frame | 720p, 1440p | 5–15s | none | 0 | 720p: 0.1<br>1440p: 0.15 | verified | 4 |
| `runway:wan3` | Wan 3.0 (via Runway) | active | yes | text-to-video, image-to-video, first-last-frame | 480p, 720p, 1080p | 2–30s | optional | 0 | 480p: 0.05<br>720p: 0.1<br>1080p: 0.2 | verified | 3 |
| `runway:wan3_prime` | Wan 3.0 Prime (via Runway) | active | yes | text-to-video, image-to-video, first-last-frame | 480p, 720p, 1080p | 2–30s | optional | 0 | 480p: 0.068<br>720p: 0.14<br>1080p: 0.28 | verified | 4 |
| `runway:grok_imagine_1_5` | Grok Imagine Video 1.5 (via Runway) | active | yes | text-to-video, image-to-video | 480p, 720p, 1080p | 1–15s | none | 7 | 480p: 0.1<br>720p: 0.16<br>1080p: 0.29 | verified | 3 |
| `runway:grok_imagine_1_5_lite` | Grok Imagine Video 1.5 Lite (via Runway) | active | yes | text-to-video, image-to-video | 480p, 720p | 1–15s | none | 0 | 480p: 0.02<br>720p: 0.03 | verified | 2 |
| `runway:gemini_omni_flash_1.1` | Gemini Omni Flash 1.1 (via Runway) | active | yes | text-to-video, image-to-video, first-last-frame, reference-to-video | 720p, 1080p | 3–10s | none | 5 | 720p: 0.1<br>1080p: 0.15 | verified | 4 |
| `ltx:ltx-2-3-fast` | LTX-2.3 Fast | active | yes | text-to-video, image-to-video | 720p, 1080p, 1440p, 4k | 6/8/10/12/14/16/18/20s | optional | 0 | 720p: 0.03<br>1080p: 0.06<br>1440p: 0.12<br>4k: 0.24 | verified | 2 |
| `ltx:ltx-2-3-pro` | LTX-2.3 Pro | active | yes | text-to-video, image-to-video | 720p, 1080p, 1440p, 4k | 6/8/10s | optional | 0 | 720p: 0.04<br>1080p: 0.08<br>1440p: 0.16<br>4k: 0.32 | verified | 3 |
| `ltx:ltx-2-5-fast` | LTX-2.5 Fast | active | yes | text-to-video, image-to-video, first-last-frame | 720p, 1080p, 1440p, 4k | 6/8/10/12/14/16/18/20s | optional | 0 | 720p: 0.09<br>1080p: 0.13<br>1440p: 0.19<br>4k: 0.3 | verified | 3 |
| `ltx:ltx-2-5-pro` | LTX-2.5 Pro | active | yes | text-to-video, image-to-video, first-last-frame | 720p, 1080p, 1440p, 4k | 6/8/10s | optional | 0 | 720p: 0.12<br>1080p: 0.17<br>1440p: 0.25<br>4k: 0.39 | verified | 4 |
| `fal:wan-3.0` | Wan 3.0 (via fal.ai) | active | yes | text-to-video | 480p, 720p, 1080p | 2–30s | optional | 0 | 480p: 0.05<br>720p: 0.1<br>1080p: 0.2 | verified | 3 |
| `fal:kling-v3-standard-i2v` | Kling 3.0 Standard I2V (via fal.ai) | active | yes | image-to-video, first-last-frame | 720p | 3–15s | optional | 0 | 720p: 0.14 | partial | 4 |
| `fal:kling-v3-pro-i2v` | Kling 3.0 Pro I2V (via fal.ai) | active | yes | image-to-video, first-last-frame | 1080p | 3–15s | optional | 0 | 1080p: 0.168 | partial | 5 |
| `fal:minimax-h3-max-turbo` | MiniMax H3 Max Turbo (via fal.ai) | unverified | no | image-to-video | 720p | 5–10s | none | 0 | 720p: 0.025 | partial | 2 |
| `fal:seedance-2.5-i2v` | Seedance 2.5 I2V (via fal.ai) | unverified | no | image-to-video, first-last-frame | 480p, 720p, 1080p | 4–30s | optional | 0 | 480p: 0.2<br>720p: 0.3<br>1080p: 0.68 | unverified | 5 |
| `fal:veo3.1` | Veo 3.1 (via fal.ai) | deprecated | no | text-to-video | 720p, 1080p | 4/6/8s | optional | 0 | 720p: 0.4<br>1080p: 0.4 | unverified | 5 |
| `google:veo-3.1-generate-preview` | Veo 3.1 Preview (Gemini API, direct) | discontinued | no | text-to-video, image-to-video, first-last-frame | 720p, 1080p | 4/6/8s | always | 3 | 720p+a: 0.4<br>1080p+a: 0.4 | verified | 5 |
| `google:gemini-omni-1.1-flash` | Gemini Omni 1.1 Flash (Gemini API, direct) | unverified | no | text-to-video, image-to-video | 720p | 4–10s | always | 0 | 720p+a: 0.1 | partial | 4 |

| Image model | Status | USD / image | Refs | Notes |
|---|---|---|---|---|
| `fal:flux-schnell` | active | 0.0056 | 0 | Cheapest storyboard frames. Priced per megapixel; estimate assumes ~1.8 MP. |
| `runway:muse_image` | active | 0.01 | 10 |  |
| `runway:gen4_image_turbo` | active | 0.02 | 3 (required) | Requires 1–3 reference images: low-cost character-consistent storyboard frames. |
| `runway:gemini_image3.1_flash` | active | 0.07 | 10 | High quality character sheets and first frames (1K tier price). |
| `fal:nano-banana-2` | active | 0.08 | 0 |  |

| Audio model | Task | Languages | Price | Notes |
|---|---|---|---|---|
| `elevenlabs:eleven_v4_turbo` | tts | en, ka, ru | $0.04 per 1k chars | Supports Georgian (ka) and Russian. Default narration voice model. |
| `elevenlabs:eleven_v4` | tts | en, ka, ru | $0.08 per 1k chars |  |
| `elevenlabs:eleven_flash_v2_5` | tts | en, ru | $0.04 per 1k chars | No Georgian support. |
| `elevenlabs:scribe_v2` | stt | en, ru | $0.22 per hour | Georgian transcription support not confirmed on the fetched pages. |
| `elevenlabs:music_v2_5` | music | — | $0.15 per minute | Generated music licensing follows ElevenLabs terms for the account plan. |
| `elevenlabs:eleven_text_to_sound_v2` | sfx | — | $0.12 per minute | Pricing page conflicts (per minute vs per generation); per-minute figure used with a 1-minute minimum. |
