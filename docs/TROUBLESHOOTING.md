# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Banner "live AI generation is off" | Expected until `LIVE_GENERATION_ENABLED=true` **and** a provider key is set. Run `pnpm providers:check`. |
| Videos are colour bars saying "DEV FIXTURE" | Development fixtures, shown because no live provider is available. They're not AI output and are never charged. |
| "needs <provider> API credentials" when generating | The router picked a model from a provider without a key. Add the key, or disable that provider/model in Admin. |
| "No available model meets the … quality bar" | Hard requirements (duration, audio, references, resolution, plan limit) excluded every qualifying model. The estimate lists blockers and alternatives; lower the quality mode or change settings. |
| Film shots show "voice-over needed" | No model within the plan supports native audio together with the shot's reference photos. References were kept for consistency; add a voice-over in the editor. |
| Job stuck in "Generating" | Check provider status; jobs poll every `PROVIDER_POLL_INTERVAL_MS`. Admin → Overview shows queue health. Worker locks older than 10 minutes are reclaimed automatically. |
| "previous submission attempt was interrupted" | A worker crashed between submitting and recording the provider job id. To avoid double charges, it isn't resent: credits are returned and the user can retry. Check the provider dashboard (audit action `generation.submission_uncertain`). |
| Transitions look like fades through black | The bundled FFmpeg (2018 build) has no `xfade`. Set `FFMPEG_PATH` to FFmpeg 6/7 (the Docker image uses Debian's FFmpeg). |
| Text/subtitle font missing or boxes | Set `FFMPEG_FONT_FILE` to a TTF with Georgian/Cyrillic glyphs (e.g. DejaVu Sans or Noto Sans Georgian). |
| Provider rejects image input as too large | With local storage, inputs are sent inline (≤15 MB). Use S3/R2 so providers fetch presigned URLs. |
| `Invalid environment configuration` on start | The message lists the variable; empty `KEY=` lines are treated as unset. |
| PGlite "database is locked" / two processes | The embedded DB supports one process. Run only `pnpm dev` (the API embeds the worker), or switch to PostgreSQL to run separate workers. |
| 429 on login/registration | Brute-force protection (10/min in production). |
| Cross-origin request blocked (403) | `PUBLIC_APP_URL` must match the origin users browse to. |
