# Architecture

```
Browser ──► Next.js (apps/web) ──/api/* rewrite──► Fastify API (apps/server) ──► PostgreSQL
                                                     │   ▲                        (jobs, ledger, queue)
                                                     ▼   │
                                              Worker(s): queue_jobs (SKIP LOCKED)
                                                     │
                     ┌───────────────────────────────┼──────────────────────────────┐
                     ▼                               ▼                              ▼
          Video providers (Runway, LTX,      FFmpeg (normalize, stitch,      Object storage
          fal.ai, Google, Replicate)         render, subtitles, thumbs)      (local / S3 / R2 / MinIO)
          Audio (ElevenLabs) · LLM (Claude)
```

## Request → video

1. **Estimate** (`generation/service.ts → prepareEstimate`): validate inputs and ownership, apply plan limits, analyse the prompt (people, multiple characters, action, dialogue…), then route.
2. **Route** (`routing/router.ts`):
   - Filter out models that can't satisfy the hard requirements: mode, aspect, resolution ≥ requested, documented native audio, reference count and duration (with optional stitching).
   - Set the quality bar per mode, raised one tier for complex shots in Economy/Balanced.
   - Among models that qualify, pick the lowest *expected* cost (price ÷ reliability). Prefer one continuous clip unless stitching saves at least 40%.
   - Never silently downgrade. If nothing qualifies, return blockers and alternatives.
3. **Price** (`pricing/pricing.ts`): convert provider cost plus processing to credits with markup, a minimum-margin floor and a buffer when pricing is only partly confirmed. Unverified pricing is never charged.
4. **Commit** (`commitGeneration`): one DB transaction writes the job row, the credit reservation (a conditional `UPDATE`, so no overspend under concurrency) and the queue entry.
5. **Worker** (`generation/pipeline.ts`), re-entrant and checkpointed:
   - Prepare the prompt (AI Director or deterministic composition).
   - Write a `provider_jobs` row *before* submitting. If a crash leaves a "submitting" row, it is never blindly resubmitted, which prevents double charges.
   - Poll by rescheduling the queue job; fal.ai webhooks wake it early.
   - Download, ffprobe-validate and store the output; the last frame is chained into the next segment.
   - Conform (exact duration and aspect) only when needed, otherwise keep the original encode.
   - Settle credits at the provider-reported cost when available, never above the reservation.

## Key decisions

| Decision | Why |
|---|---|
| **Drizzle ORM + PostgreSQL**, with **PGlite** (embedded Postgres) for dev/tests | Real Postgres semantics locally with zero setup (no Docker on the build machine). Prisma's CLI and engines need a live server. Migrations are plain SQL in `apps/server/drizzle`. |
| **Postgres-backed queue** instead of BullMQ/Redis | Jobs are enqueued in the same transaction as the job and credit reservation (transactional outbox), so nothing is ever "charged but not queued". One fewer service to operate. `FOR UPDATE SKIP LOCKED` scales to many workers. Redis can be added later for rate-limit storage. |
| Provider REST via an injectable `fetch` | Each adapter's exact payload is unit-testable against mocked HTTP. Provider-specific fields stay inside adapters. |
| Catalog in code, state in DB | The verified catalog (capabilities, prices, sources) is versioned code. Admin decisions (enable, status, tier, prices) persist in `model_registry` / `model_pricing` and survive catalog syncs. |
| Quality tiers are provisional | No invented benchmarks. Admin evaluations replace priors once there are enough of them. |
| Native audio only where documented | Prevents promising audio that a model can't be instructed to produce. |
| Fixtures are a separate provider | The real pipeline (queue, storage, validation, editor) runs locally, but outputs are unmistakably labelled and never charged. |
| Movie photo references (`photo1…`) | User photos are mapped to characters, locations or shot objects (by Claude vision, or heuristically offline) and passed as provider reference images. Tokens are never sent to video models. |
| Native audio in films is "preferred" | If no model in the plan offers native audio together with the shot's references, references win (consistency) and the shot is flagged "voice-over needed". |

## Data model (main tables)

`users, sessions, accounts, user_settings, consents` · `projects, project_versions, assets` · `characters, character_references, locations, location_references` · `scenes, shots, storyboards` · `providers, model_registry, model_pricing, model_evaluations` · `generation_jobs, provider_jobs` · `credit_wallets, credit_reservations, credit_transactions` · `plans, credit_packs, subscriptions, payments, webhook_events` · `templates, saved_prompts, notifications, audit_logs, admin_config, queue_jobs, provider_spend`.

All user data is owner-scoped. Every read path filters by `user_id`, and media is served only through short-lived signed URLs.
