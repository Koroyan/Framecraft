# Framecraft — AI video & film studio

Framecraft creates TikToks, Reels, ads and multi-scene AI films. You describe what you want; the routing engine picks the **least expensive model that meets the quality bar** for every shot. The price is shown before anything is spent, and the result opens in a real editor.

- **Quick Create**: prompt, live estimate with routing explanation, generate, preview, download, edit.
- **Social Media Studio**: 19 templates with real workflows (beats → per-shot estimates → batch generation), 3 creative concepts, hooks, titles, captions, hashtags and scripts in English, Georgian and Russian, plus platform safe-area previews.
- **Cinematic Studio**: camera, lens, lighting, grade, mood, shot type, first/last frame, references and manual model choice. Camera presets use a real API parameter where one exists (LTX `camera_motion`).
- **AI Movie Maker**: screenplay, characters, locations, scenes and shots. You can use your own photos (**photo1, photo2…** in the story). Director Mode editing, a budget-approval gate, per-shot generation that resumes without repeating paid work, auto-assembly and render.
- **Editor**: timeline, trim, split, reorder (drag or buttons), replace, regenerate a shot, transitions, music and voice tracks, text overlays, subtitles (manual, from dialogue, or from speech), brand logo, undo/redo, autosave, versions, and FFmpeg export presets.
- **Credits & billing**: wallet, append-only ledger, atomic reservations, settlement at the real provider cost, refunds, plans, packs, spending limits, sandbox checkout and a Stripe adapter.
- **Admin**: live metrics (users, generations, cost by model and provider, gross margin, queue, storage), provider and model toggles, pricing editor, routing, pricing and spending config, plans, templates, users, failed-job refunds, quality evaluations and an audit log.

> **Honesty rules built in:** without provider keys, the app renders FFmpeg **test fixtures** with "DEV FIXTURE – NOT AI GENERATED" burned into every frame. They're flagged in the UI and never charged. Fixtures can't be enabled in production. No paid API call is possible until `LIVE_GENERATION_ENABLED=true` *and* a provider key is set.

## Quick start (no Docker, no keys)

Requirements: **Node 20.11+** and **pnpm 10+** (pnpm 12 tested). Everything else is bundled: an embedded PostgreSQL (PGlite) and FFmpeg binaries.

```bash
pnpm install
pnpm db:seed      # optional: demo accounts admin@framecraft.local / creator@framecraft.local (password: framecraft-demo-1)
pnpm dev          # web http://localhost:3000 · api http://localhost:4000
```

## Commands

| Task | Command |
|---|---|
| Install dependencies | `pnpm install` |
| Configure environment | `cp .env.example .env` and edit (all optional for dev) |
| Start dev servers (web + API + embedded worker) | `pnpm dev` |
| Run database migrations | `pnpm db:migrate` |
| Start a background worker (PostgreSQL only) | `pnpm dev:worker` (dev) · `pnpm --filter @framecraft/server start:worker` (prod) |
| Unit + integration tests | `pnpm test` |
| End-to-end tests (Playwright) | `npx playwright install chromium` once, then `pnpm test:e2e` |
| Typecheck / lint | `pnpm typecheck` · `pnpm lint` |
| Build production assets | `pnpm build` |
| Start production build locally | `pnpm start` |
| Full stack in Docker | `docker compose up --build` |
| Validate provider keys (free) | `pnpm providers:check` |
| Paid smoke test (capped) | `pnpm providers:smoke --model ltx:ltx-2-3-fast --max-usd 0.50 --yes-spend-real-money` |
| Create an admin | `pnpm --filter @framecraft/server admin:create you@example.com "a-strong-password1"` |

## Repository layout

```
packages/shared     domain vocabulary, templates, zod schemas, prompt composition (used by web + server)
apps/server         Fastify API, worker, routing/pricing engine, provider adapters, billing, FFmpeg pipeline
  src/catalog       verified model catalog (capabilities, prices, status, docs links)
  src/routing       requirement analysis + quality/cost router
  src/providers     Runway, LTX, fal.ai, Google, Replicate, ElevenLabs, image adapters, dev fixture
  src/generation    job creation (estimate → reserve → enqueue) and the re-entrant worker pipeline
  src/movie         AI Movie Maker orchestration · src/editor timelines & renders · src/director AI Director
  drizzle/          SQL migrations
apps/web            Next.js 16 app (landing, studio, editor, admin)
e2e/                Playwright tests
docs/               architecture, configuration, deployment, billing, troubleshooting, model status, launch checklist
```

## Documentation

- [Implementation status](IMPLEMENTATION_STATUS.md): what's done, tested, pending and blocked.
- [Architecture](docs/ARCHITECTURE.md) and key decisions.
- [API keys & provider configuration](docs/API_CONFIGURATION.md).
- [Model integration status](docs/MODEL_STATUS.md).
- [Billing, credits & refunds](docs/BILLING.md).
- [Deployment](docs/DEPLOYMENT.md).
- [Troubleshooting](docs/TROUBLESHOOTING.md).
- [Self-hosting evaluation](docs/SELF_HOSTING.md).
- [Launch checklist](docs/LAUNCH_CHECKLIST.md).
