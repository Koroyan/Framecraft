# Configuring API keys

Adding keys requires **no code changes**. Providers activate automatically when their key is present *and* live generation is switched on.

## Step by step

1. `cp .env.example .env`.
2. Add one or more provider keys (see the table).
3. Restart the API (and workers).
4. **Validate credentials, free:** `pnpm providers:check`. This makes read-only authenticated calls only (e.g. Runway `/v1/organization`, Gemini `models.list`, ElevenLabs `/v1/models`) and lists the models that become routable.
5. **Run one capped paid smoke test**, with your explicit approval:
   ```bash
   pnpm providers:smoke --model ltx:ltx-2-3-fast --max-usd 0.50 --yes-spend-real-money
   ```
   It refuses to run without the flag and aborts *before any API call* if the estimate exceeds `--max-usd`. The MP4 is saved to `apps/server/smoke-output/` and validated with ffprobe.
6. Set `LIVE_GENERATION_ENABLED=true` and restart. The dev banner disappears and estimates show "live".
7. In **Admin → Models & pricing**, review the enabled models. Record real quality ratings over time so routing moves from provisional tiers to measured quality.

## Keys

| Variable | Provider | Unlocks | Where to get it |
|---|---|---|---|
| `RUNWAYML_API_SECRET` | Runway Developer API | Gen-4/4.5, Veo 3.1 (+Fast), Kling 3.0/O3, Seedance 2/2.5, MiniMax H3, Wan 3.0, Grok Imagine 1.5, Gemini Omni 1.1; image models | dev.runwayml.com → API keys (buy credits; $0.01 each) |
| `LTX_API_KEY` | LTX | LTX-2.3/2.5 Fast & Pro (cheapest per second, real camera control) | console.ltx.io |
| `FAL_KEY` | fal.ai | Wan 3.0, Kling 3.0 I2V; FLUX schnell / Nano Banana images | fal.ai dashboard → keys |
| `GEMINI_API_KEY` | Google Gemini API | (Veo preview is discontinued; Omni direct is unverified) | aistudio.google.com |
| `REPLICATE_API_TOKEN` | Replicate | Generic adapter; add verified models to the catalog first | replicate.com/account |
| `ELEVENLABS_API_KEY` | ElevenLabs | Voice-over (EN/KA/RU), music, SFX, speech-to-text subtitles | elevenlabs.io → API keys |
| `ANTHROPIC_API_KEY` | Anthropic Claude | AI Director: prompt enhancement (claude-haiku-5-5), screenplays and photo understanding (claude-opus-5-5) | console.anthropic.com |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe | Real checkout (set `PAYMENT_PROVIDER=stripe`) | dashboard.stripe.com |
| `S3_*` | Cloudflare R2 / S3 / MinIO | Production media storage; providers can fetch inputs by URL | your bucket |

### Recommended minimal setup

- **Cheapest useful start:** `LTX_API_KEY` (Economy/Balanced from ~$0.03–0.04/s with native audio) plus `RUNWAYML_API_SECRET` (High/Cinematic: Kling 3.0 Pro, Veo 3.1, and reference-capable models for consistent characters).
- Add `ANTHROPIC_API_KEY` for real screenplays, photo understanding and better prompts. Without it the offline planner produces editable drafts.
- Add `ELEVENLABS_API_KEY` for voice-over and transcription. Georgian uses the `eleven_v4` family.

### Webhooks

Set `PROVIDER_WEBHOOK_BASE_URL=https://your-domain` to receive fal.ai completion webhooks (Ed25519-verified against fal's JWKS) at `/api/webhooks/providers/fal`. Without it, all jobs are polled; this is the default and works fine.

Stripe webhooks go to `https://your-domain/api/webhooks/stripe`. Subscribe to `checkout.session.completed`, `invoice.paid` and `customer.subscription.deleted`.

### Spending protection

- `GLOBAL_DAILY_PROVIDER_BUDGET_USD` is a hard daily kill-switch across all users (also editable under Admin → Routing & limits → spending).
- Per-job cap: `spending.maxCreditsPerJob`. Users can set personal per-video and daily limits in Settings.
- Automatic provider retries are capped by `spending.maxProviderRetries` (default 1). Content-policy rejections are never retried.
