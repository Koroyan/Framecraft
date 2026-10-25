# Deployment

## Services

| Service | Image / command | Scale |
|---|---|---|
| PostgreSQL 15+ | managed (Neon, RDS, Supabase, Cloud SQL…) | 1 primary |
| Object storage | Cloudflare R2 / S3 (`STORAGE_DRIVER=s3`) | — |
| API | `apps/server/Dockerfile` → `node dist/main.js` | 2+ behind a load balancer |
| Worker | same image → `node dist/worker-main.js` | N replicas; `WORKER_QUEUES=generation` and `media` can be split |
| Migrations | same image → `node dist/migrate.js` (run on every deploy, before the API starts) | job |
| Web | `apps/web/Dockerfile` (Next standalone), build arg `API_ORIGIN=http://api:4000` | 2+ |

The browser only talks to the web origin; Next.js proxies `/api/*` to the API. Put both behind one domain with TLS.

## Required production environment

`NODE_ENV=production`, `DATABASE_URL=postgres://…`, `SESSION_SECRET` and `STORAGE_SIGNING_SECRET` (≥32 random chars each), `STORAGE_DRIVER=s3` + `S3_*`, `PUBLIC_APP_URL=https://your-domain`, `HOST=0.0.0.0`. The API **refuses to start** if secrets are missing, if `DATABASE_URL` is PGlite, or if `DEV_FIXTURES_ENABLED=true`.

Then add provider keys and set `LIVE_GENERATION_ENABLED=true` once the smoke test passes (see API_CONFIGURATION.md).

### Who can use it and who pays (production defaults)

| Setting | Production default | Meaning |
|---|---|---|
| `SIGNUP_MODE` | `invite` | `invite` = only `SIGNUP_ALLOWLIST` (emails and/or `@domain`s); `open` = anyone (**requires** `TURNSTILE_SECRET_KEY`); `closed` = no new accounts |
| `SIGNUP_BONUS_CREDITS` | `0` | No free credits — nothing is generated without a paid credit pack (admins can grant credits) |
| `REQUIRE_EMAIL_VERIFICATION` | `true` | Buying credits needs a confirmed email; **requires** `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` + `EMAIL_FROM` on your domain |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | unset | Cloudflare Turnstile on sign-up and sign-in when the secret is set |
| `DEFAULT_DAILY_SPEND_LIMIT` | `1000` credits | Daily cap given to every new account (users can change theirs in Settings) |
| `GLOBAL_DAILY_PROVIDER_BUDGET_USD` | `50` | Hard stop for all provider spend per day, across all users |
| `PAYMENT_PROVIDER` | — | `stripe` (needs `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`); the simulated `sandbox` checkout is always disabled in production |

The API refuses to start when open sign-ups have no Turnstile secret, when email verification is on but email is console-only, or when Stripe keys are missing. Also set a monthly spend limit in each provider's own dashboard (Runway, ElevenLabs, Anthropic) as the last line of defence.

## Local production-like stack

```bash
cp .env.example .env   # set SESSION_SECRET and STORAGE_SIGNING_SECRET
docker compose up --build
```

This runs PostgreSQL, MinIO (with the bucket created), migrations, API, worker and web. Note: Docker wasn't available on the build machine, so **the Dockerfiles and compose file are written but have not been executed**. Validate them on first use.

## Without Docker

```bash
pnpm install && pnpm build
DATABASE_URL=postgres://… node apps/server/dist/migrate.js
pnpm start   # API + web; plus `pnpm --filter @framecraft/server start:worker` when using PostgreSQL
```

## Operations

- Health: `GET /api/health`. Queue health: Admin → Overview, or `GET /api/admin/queue`.
- Stuck jobs: locks older than 10 minutes are reclaimed automatically. Expired credit reservations are released by the maintenance job every 5 minutes.
- Backups: PostgreSQL point-in-time recovery plus bucket versioning. Generated media is the expensive asset; keep it until your retention policy says otherwise.
- Create the first admin: `node dist/create-admin.js admin@your-domain "strong-password-123"`.
