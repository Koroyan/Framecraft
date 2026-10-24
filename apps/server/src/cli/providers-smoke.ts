import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../config/env';
import { createVideoProviders } from '../providers/video';
import { VIDEO_MODELS } from '../catalog/video-models';
import type { ProviderVideoRequest, VideoProvider } from '../providers/video/types';
import { probe } from '../media/ffmpeg';

/**
 * REAL, PAID smoke test against one provider model. It refuses to run unless:
 *   --model <key>            e.g. ltx:ltx-2-3-fast
 *   --max-usd <amount>       hard cap; aborts if the estimate exceeds it
 *   --yes-spend-real-money   explicit authorization flag
 * The result is saved to ./smoke-output/ and validated with ffprobe.
 */
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const modelKey = arg('--model');
const maxUsd = Number(arg('--max-usd'));
if (!modelKey || !Number.isFinite(maxUsd) || !args.includes('--yes-spend-real-money')) {
  console.log('Usage: pnpm providers:smoke --model ltx:ltx-2-3-fast --max-usd 0.50 --yes-spend-real-money');
  console.log('\nCheapest routable candidates:');
  for (const m of VIDEO_MODELS.filter((x) => x.status === 'active').sort((a, b) => Math.min(...a.pricing.map((p) => p.usdPerSecond)) - Math.min(...b.pricing.map((p) => p.usdPerSecond))).slice(0, 6)) {
    console.log(`  ${m.key.padEnd(34)} from $${Math.min(...m.pricing.map((p) => p.usdPerSecond)).toFixed(3)}/s, min ${m.capabilities.durations.allowed?.[0] ?? m.capabilities.durations.min}s`);
  }
  process.exit(1);
}
const env = loadEnv();
const model = VIDEO_MODELS.find((m) => m.key === modelKey);
if (!model) throw new Error(`Unknown model ${modelKey}`);
const provider = createVideoProviders(env)[model.provider] as VideoProvider;
if (!provider?.isConfigured()) throw new Error(`${model.provider} credentials are not configured`);

const resolution = model.capabilities.resolutions[0]!;
const req: ProviderVideoRequest = {
  model,
  mode: model.capabilities.modes.includes('text-to-video') ? 'text-to-video' : 'image-to-video',
  prompt: 'A slow cinematic dolly shot of a steaming cup of coffee on a wooden table by a rainy window, soft morning light',
  aspectRatio: model.capabilities.aspectRatios.includes('9:16') ? '9:16' : model.capabilities.aspectRatios[0]!,
  resolution,
  durationSec: model.capabilities.durationsByResolution?.[resolution]?.[0] ?? model.capabilities.durations.allowed?.[0] ?? model.capabilities.durations.min,
  audio: false,
};
if (req.mode !== 'text-to-video') throw new Error('Smoke test supports text-to-video models only');
const problems = provider.validateRequest(req);
if (problems.length) throw new Error(problems.join('; '));
const est = provider.estimateCost(req);
console.log(`Estimated cost: $${est.usd.toFixed(3)} (${est.confidence}); cap $${maxUsd.toFixed(2)}`);
if (est.usd > maxUsd) {
  console.error('Estimate exceeds --max-usd. Aborting without any API call.');
  process.exit(1);
}
const started = Date.now();
const sub = await provider.submitGeneration(req, { idempotencyKey: `smoke-${Date.now()}` });
console.log(`Submitted: ${sub.externalId}`);
let status = sub.immediate ?? (await provider.getGenerationStatus(sub.externalId, model));
while (status.state === 'queued' || status.state === 'running') {
  await new Promise((r) => setTimeout(r, 6000));
  status = await provider.getGenerationStatus(sub.externalId, model);
  process.stdout.write(`\r${status.state} ${status.progress !== undefined ? `${Math.round(status.progress * 100)}%` : ''}   `);
  if (Date.now() - started > 20 * 60_000) throw new Error('Timed out after 20 minutes');
}
console.log();
if (status.state !== 'succeeded') {
  console.error('Generation did not succeed:', status.error);
  process.exit(1);
}
const out = provider.retrieveOutput(status)[0]!;
const dir = path.resolve('smoke-output');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${model.key.replace(/[^\w.-]/g, '_')}-${Date.now()}.mp4`);
const res = await fetch(out.url!, { headers: out.headers });
fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
const p = await probe(file);
console.log(`Saved ${file}`);
console.log(`Validated: ${p.width}x${p.height}, ${p.durationSec.toFixed(2)}s, audio=${p.hasAudio}, reported cost=${status.costUsd ?? 'n/a'}`);
