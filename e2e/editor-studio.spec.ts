import { test, expect, type Page } from '@playwright/test';
import { register } from './helpers';

/*
 * End-to-end walk through the editor studio: story graph → shot editor → localized AI edit
 * (development fixture) → compare → accept → 2D camera keyframes → reload → export.
 * Runs only in fixture mode (LIVE_GENERATION_ENABLED=false) — it must never spend provider credits.
 */

test.beforeEach(async ({ request }, testInfo) => {
  const status = await (await request.get('/api/system/status')).json();
  testInfo.skip(status.liveGenerationEnabled, 'Live AI generation is on — skipping a test that would spend real provider credits.');
});

const SHOTS = 'test-results/editor-studio';

async function call<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const text = await r.text();
      if (!r.ok) throw new Error(`${m} ${u} → ${r.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 180_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

test('editor studio: graph → shot → AI fix (fixture) → compare → accept → camera → export', async ({ page }) => {
  test.setTimeout(600_000);
  await register(page);

  // A small film made with development fixtures (free, labelled TEST FIXTURE).
  const created = await call<{ projectId: string }>(page, 'POST', '/api/movies', { brief: { idea: 'A courier rides a bike through a neon city at night and delivers a glowing parcel.', lengthSec: 15, quality: 'economy', withDialogue: false, withMusic: false, keyframes: false, language: 'en' }, idempotencyKey: `e2e-movie-${Date.now()}` });
  const pid = created.projectId;
  await until(() => call<{ planJob: { status: string } | null }>(page, 'GET', `/api/movies/${pid}`), (m) => m.planJob?.status === 'completed');
  const est = await call<{ estimate: { totalCredits: number } }>(page, 'POST', `/api/movies/${pid}/estimate`, { onlyMissing: true });
  await call(page, 'POST', `/api/movies/${pid}/generate`, { approvedCredits: est.estimate.totalCredits, idempotencyKey: `e2e-gen-${Date.now()}` });
  await until(() => call<{ movieJob: { status: string } | null }>(page, 'GET', `/api/movies/${pid}`), (m) => ['completed', 'failed'].includes(m.movieJob?.status ?? ''), 300_000);

  // 1) Story graph.
  await page.goto(`/app/editor/${pid}`);
  await expect(page.getByText('FILM START')).toBeVisible();
  await expect(page.getByText('SHOT 01')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/1-story-graph.png` });

  // Open shot 1 in the shot editor (node "Edit" button).
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await expect(page.getByText(/Shot editor · Shot 1/)).toBeVisible();
  const player = page.locator('video').first();
  await expect(player).toBeVisible();
  const box = (await player.boundingBox())!;

  // 2) Select 1.0–2.0 s, draw a rectangle on the bottom-right, write the comment-style instruction, run.
  const bar = page.getByRole('slider', { name: 'Shot time' });
  const bb = (await bar.boundingBox())!;
  const dur = Number(await bar.getAttribute('aria-valuemax'));
  await page.keyboard.down('Shift');
  await page.mouse.move(bb.x + (bb.width * 1) / dur, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + (bb.width * 2) / dur, bb.y + bb.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(page.getByText(/Selected 1(.d)?s/)).toBeVisible();
  await page.getByRole('button', { name: 'Rectangle' }).click();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9, { steps: 8 });
  await page.mouse.up();
  await page.getByPlaceholder(/Fix the hand anatomy/).fill('Fix the hand anatomy, keep the face, camera and background the same');
  await expect(page.getByText(/Test mode — no AI model is called/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/2-shot-editor-ai.png` });
  await page.getByRole('button', { name: /Run test edit/ }).click();
  await expect(page.getByRole('button', { name: 'Compare before / after' })).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Compare before / after' }).click();
  await expect(page.getByText(/Compare V1/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/3-compare.png` });
  await page.getByRole('button', { name: 'Accept edit' }).click();
  await expect(page.getByText(/is now in the movie/)).toBeVisible();

  // The shot now uses V2; the timeline clip follows; other shots untouched.
  const studio = await call<{ shots: { id: string; activeVersionId: string; versions: { id: string; number: number; assetId: string }[] }[] }>(page, 'GET', `/api/projects/${pid}/shots`);
  const s1 = studio.shots[0]!;
  expect(s1.versions.find((v) => v.id === s1.activeVersionId)!.number).toBe(2);
  expect(studio.shots.slice(1).every((s) => s.versions.length === 1)).toBe(true);

  // 3) Camera: zoom the framing window, keyframe at the start and at the end, preview the result.
  await page.getByRole('button', { name: /^Camera$/ }).click();
  const frame = page.getByRole('slider', { name: /Camera framing/ });
  const fb = (await frame.boundingBox())!;
  await page.mouse.move(fb.x + fb.width - 10, fb.y + fb.height - 10);
  await page.mouse.down();
  await page.mouse.move(fb.x + fb.width * 0.7, fb.y + fb.height * 0.7, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: /Keyframe at/ }).click();
  await bar.click({ position: { x: bb.width * 0.9, y: bb.height / 2 } });
  const fb2 = (await frame.boundingBox())!;
  await page.mouse.move(fb2.x + fb2.width / 2, fb2.y + fb2.height / 2);
  await page.mouse.down();
  await page.mouse.move(fb2.x + fb2.width / 2 + box.width * 0.12, fb2.y + fb2.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: /Keyframe at/ }).click();
  await expect(page.getByText(/zoom 1[1-9]\d%|zoom [2-4]\d\d%/).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/4-camera.png` });
  await page.getByRole('radio', { name: /Result/ }).click().catch(async () => page.getByText('Result (as exported)').click());
  await page.screenshot({ path: `${SHOTS}/5-camera-result.png` });

  // 4) Persistence + export: save, reload, render the movie.
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByText('FILM START')).toBeVisible();
  const tl = await call<{ timeline: { clips: { shotId?: string; camera?: { keyframes: unknown[] }; versionId?: string; assetId: string }[] } }>(page, 'GET', `/api/projects/${pid}/timeline`);
  const c1 = tl.timeline.clips.find((c) => c.shotId === s1.id)!;
  expect(c1.camera?.keyframes.length).toBe(2);
  expect(c1.assetId).toBe(s1.versions.find((v) => v.number === 2)!.assetId);
  const r = await call<{ job: { id: string } }>(page, 'POST', `/api/projects/${pid}/render`, { timeline: tl.timeline, preset: 'master', idempotencyKey: `e2e-render-${Date.now()}` });
  const done = await until(() => call<{ job: { status: string; error?: { message: string } } }>(page, 'GET', `/api/generations/${r.job.id}`), (j) => ['completed', 'failed'].includes(j.job.status), 240_000);
  expect(done.job.error?.message ?? 'ok').toBe('ok');
  expect(done.job.status).toBe('completed');
  await page.screenshot({ path: `${SHOTS}/6-after-reload.png` });
});
