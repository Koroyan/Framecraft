import { loadEnv } from '../config/env';
import { createVideoProviders, PROVIDER_INFO } from '../providers/video';
import { ElevenLabsProvider } from '../providers/audio/elevenlabs';
import { AnthropicLlm } from '../director/llm';
import { VIDEO_MODELS } from '../catalog/video-models';

/**
 * Credential & capability validation. Makes only free, authenticated read calls —
 * never a generation. Run after adding keys to .env.
 */
const env = loadEnv();
const video = createVideoProviders(env);
const rows: { provider: string; envVar: string; configured: boolean; result: string }[] = [];

for (const key of ['runway', 'ltx', 'fal', 'google', 'replicate'] as const) {
  const p = video[key]!;
  const info = PROVIDER_INFO[key]!;
  if (!p.isConfigured()) {
    rows.push({ provider: info.displayName, envVar: info.envVar, configured: false, result: 'not configured' });
    continue;
  }
  const check = p.checkCredentials ? await p.checkCredentials() : { ok: true, message: 'key present (no free credential-check endpoint; verified on first smoke test)' };
  rows.push({ provider: info.displayName, envVar: info.envVar, configured: true, result: `${check.ok ? 'OK' : 'FAILED'} — ${check.message}` });
}
const el = new ElevenLabsProvider(env.ELEVENLABS_API_KEY);
rows.push({ provider: 'ElevenLabs', envVar: 'ELEVENLABS_API_KEY', configured: el.isConfigured(), result: el.isConfigured() ? JSON.stringify(await el.checkCredentials()) : 'not configured' });
rows.push({ provider: 'Anthropic (AI Director)', envVar: 'ANTHROPIC_API_KEY', configured: new AnthropicLlm(env.ANTHROPIC_API_KEY, { fast: env.LLM_MODEL_FAST, smart: env.LLM_MODEL_SMART }).available, result: env.ANTHROPIC_API_KEY ? 'key present (verified on first planning call)' : 'not configured — offline planner in use' });

console.table(rows);
const routable = VIDEO_MODELS.filter((m) => (m.status === 'active' || m.status === 'preview') && video[m.provider]?.isConfigured());
console.log(`\nLive generation flag: LIVE_GENERATION_ENABLED=${env.LIVE_GENERATION_ENABLED}`);
console.log(`Routable video models with current credentials: ${routable.length ? routable.map((m) => m.key).join(', ') : 'none'}`);
