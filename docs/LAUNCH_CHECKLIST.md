# Launch-readiness checklist

## Must do before taking money
- [ ] Production PostgreSQL, R2/S3 bucket, domain + TLS, secrets (`SESSION_SECRET`, `STORAGE_SIGNING_SECRET`).
- [ ] Bucket CORS: allow `GET` (and `HEAD`) from the app's origin. The editor reads video pixels in the browser (WebGL colour/object preview and click-to-select); without CORS those features fall back to an honest "preview unavailable" note and the export still applies the edits.
- [ ] `docker compose up --build` (or your platform) verified. The Dockerfiles have **not been executed yet** (no Docker on the build machine).
- [ ] Provider keys added → `pnpm providers:check` green → one capped `pnpm providers:smoke` per provider you enable.
- [ ] Review every enabled model in Admin → Models & pricing against the provider's current price page. Prices change.
- [ ] Confirm fal.ai prices marked *partial* (Kling v3) and decide on the *unverified* models.
- [ ] Generate 10–20 real clips per main model and record quality evaluations, so tiers become measured.
- [ ] `LIVE_GENERATION_ENABLED=true`; set `GLOBAL_DAILY_PROVIDER_BUDGET_USD` to a cautious value.
- [ ] Choose and integrate a payment processor that supports your merchant country (see BILLING.md); test webhooks end to end in its test mode.
- [ ] Legal review of Terms, Privacy and AI content policy (the current texts are starter templates), VAT/sales tax, refund policy wording.
- [ ] Email: Resend account + verified sending domain (`EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`). Verification emails are built; receipts and job notifications are not sent by email yet.
- [ ] Access: keep `SIGNUP_MODE=invite` with `SIGNUP_ALLOWLIST` for the beta; before `open`, add Cloudflare Turnstile keys.
- [ ] Spend caps: provider dashboards (monthly), `GLOBAL_DAILY_PROVIDER_BUDGET_USD`, `DEFAULT_DAILY_SPEND_LIMIT`.
- [ ] Error monitoring (e.g. Sentry) and uptime checks on `/api/health`.

## Should do soon after
- [ ] Password reset flow (email sending exists now; the reset flow itself is not built).
- [ ] Google OAuth sign-in (accounts table ready; flow not enabled).
- [ ] Provider-side subscription cancellation for Stripe.
- [ ] Continuity QA with vision (compare consecutive shots / character references) — planned; not implemented.
- [ ] Per-user rate-limit storage in Redis when running multiple API replicas.
- [ ] Watermark for free-plan exports (plan flag exists; not yet applied in render).
- [ ] Storage quotas per plan (limit stored; not yet enforced).
- [ ] Social publishing integrations (require platform API approval).
