import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, expect, type Page } from '@playwright/test';
import { register } from './helpers';

/*
 * Framecraft 6.0 — the AI Director inside the story graph, in a real browser on real video files.
 * Only free steps run: the on-device Director understands these requests (no AI call), free story and
 * timeline steps are applied and undone, and paid steps are shown with their price but never approved.
 *   C — a new shot between two shots from the connection's "+", with a complete prompt; undo
 *   B — Ask AI on a shot: a free change applies; a paid AI edit waits for approval (nothing charged)
 *   D — an AI action dragged onto a shot opens its card; the free camera move applies
 *   E — the Director keeps its conversation, its subject and an unsent draft through collapse and reload
 *   S — the storyboard shows the planned shot in place, with Ask AI and Generate
 *   K — Create a Cartoon: original styles, protected characters refused before anything is sent
 *   M — Character Bible: a brand mascot with personality and palette
 */

const SHOTS = 'test-results/director-6';
const ffmpegBin = (createRequire(path.resolve('apps/server/package.json'))('@ffmpeg-installer/ffmpeg') as { path: string }).path;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-e2e6-'));
test.afterAll(() => fs.rmSync(work, { recursive: true, force: true }));
const ff = (args: string[]) => execFileSync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

function patternClip(file: string, source: string, hz: number) {
  ff(['-f', 'lavfi', '-i', `${source}=s=640x360:r=30:d=3`, '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=3`, '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
}

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

async function upload(page: Page, file: string, projectId: string): Promise<{ id: string }> {
  const r = await page.context().request.post('/api/assets', { multipart: { rightsConfirmed: 'true', projectId, file: { name: path.basename(file), mimeType: 'video/mp4', buffer: fs.readFileSync(file) } } });
  expect(r.status(), await r.text()).toBe(201);
  return ((await r.json()) as { asset: { id: string } }).asset;
}

/** A project with three clips, opened on the story graph. */
async function storyProject(page: Page) {
  await register(page);
  const { project } = await call<{ project: { id: string } }>(page, 'POST', '/api/projects', { title: `E2E director ${Date.now()}`, kind: 'edit', aspectRatio: '16:9' });
  const files = [['testsrc2', 330], ['smptebars', 440], ['rgbtestsrc', 550]] as const;
  const ids: string[] = [];
  for (const [i, [src, hz]] of files.entries()) {
    const f = path.join(work, `c${i}-${Date.now()}.mp4`);
    patternClip(f, src, hz);
    ids.push((await upload(page, f, project.id)).id);
  }
  const { timeline } = await call<{ timeline: Record<string, unknown> }>(page, 'GET', `/api/projects/${project.id}/timeline`);
  await call(page, 'PUT', `/api/projects/${project.id}/timeline`, { timeline: { ...timeline, clips: ids.map((assetId, i) => ({ id: `c${i + 1}`, assetId, inSec: 0, outSec: 3, label: `Clip ${i + 1}` })) }, autosave: false, label: 'e2e setup' });
  await page.goto(`/app/editor/${project.id}`);
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible();
  const pro = page.getByRole('button', { name: 'Pro tools' });
  if ((await pro.isVisible()) && (await pro.getAttribute('aria-pressed')) !== 'true') await pro.click();
  await page.getByRole('tab', { name: 'Graph' }).click();
  await expect(page.getByTestId('story-graph')).toBeVisible();
  await expect(page.getByTestId('shot-card')).toHaveCount(3);
  return project.id;
}

const edgePlus = (page: Page) => page.getByRole('button', { name: 'Ask AI about the moment between these shots' });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('C — a new shot between two shots, written for the model, and undone', async ({ page }) => {
  const id = await storyProject(page);
  // FILM START → 1 → 2 → 3 → FINAL MOVIE: the second "+" is between clips 1 and 2.
  await expect(edgePlus(page)).toHaveCount(4);
  await edgePlus(page).nth(1).click();
  const card = page.getByRole('dialog', { name: /Ask AI about Between/ });
  await expect(card).toBeVisible();
  await card.getByRole('textbox', { name: 'Ask the AI Director' }).fill('Add a close-up showing the robot looking surprised');
  await card.getByRole('textbox', { name: 'Ask the AI Director' }).press('Enter');
  await expect(card.getByText('Understood instantly — no AI call, no credits')).toBeVisible();
  await expect(card.getByText(/New shot after .*“Close-up showing the robot looking surprised” · 4 s · Close-Up/)).toBeVisible();
  await card.getByRole('button', { name: 'Apply change' }).click();
  await expect(card.getByRole('button', { name: 'Undo' })).toBeVisible();

  // The planned shot sits between the two clips; the movie itself still plays three clips.
  const cards = page.getByTestId('shot-card');
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(1)).toContainText('Close-up showing the robot looking surprised');
  await expect(cards.nth(1).getByTestId('shot-status')).toHaveText('Draft');
  await page.screenshot({ path: `${SHOTS}/C1-planned-shot-between.png` });
  const studio = await call<{ shots: { description: string; prompt: string; status: string; versions: unknown[] }[] }>(page, 'GET', `/api/projects/${id}/shots`);
  const planned = studio.shots.find((s) => s.description === 'Close-up showing the robot looking surprised')!;
  expect(planned).toMatchObject({ status: 'planned', versions: [] });
  expect(planned.prompt).toContain('intimate close-up shot');
  const { timeline } = await call<{ timeline: { clips: unknown[] } }>(page, 'GET', `/api/projects/${id}/timeline`);
  expect(timeline.clips).toHaveLength(3);

  await card.getByRole('button', { name: 'Undo' }).click();
  await expect(cards).toHaveCount(3);
});

test('B — Ask AI on a shot: a free change applies; a paid edit only shows its price', async ({ page }) => {
  const id = await storyProject(page);
  const before = await call<{ wallet: { balance: number } }>(page, 'GET', '/api/billing');
  const first = page.getByTestId('shot-card').first();
  await first.getByRole('button', { name: 'Ask AI' }).click();
  const card = page.getByRole('dialog', { name: /Ask AI about Scene 1 · shot 1/ });
  await expect(card).toBeVisible();
  await card.getByRole('textbox', { name: 'Ask the AI Director' }).fill('make it 1 second');
  await card.getByRole('textbox', { name: 'Ask the AI Director' }).press('Enter');
  await expect(card.getByText(/Trim Scene 1 · shot 1 to 1 s/)).toBeVisible();
  await card.getByRole('button', { name: 'Apply change' }).click();
  await expect(first.getByTestId('shot-duration')).toHaveText(/^1(\.0)?s$/);

  // A paid step: the AI action card builds an AI edit of this shot only; its price waits for approval.
  await card.getByRole('button', { name: 'Close' }).click();
  await first.click({ position: { x: 120, y: 40 } });
  await page.getByRole('button', { name: 'AI actions' }).click();
  await page.getByRole('toolbar', { name: 'AI actions' }).getByRole('button', { name: /New background/ }).click();
  const action = page.getByRole('dialog', { name: 'New background' });
  await action.getByRole('textbox', { name: 'What should change' }).fill('a snowy village at dusk');
  await action.getByRole('button', { name: 'Show the plan and price' }).click();
  const ask = page.getByRole('dialog', { name: /Ask AI about Scene 1 · shot 1/ });
  await expect(ask.getByText(/AI edit of Scene 1 · shot 1 \(background\)/)).toBeVisible();
  // Either a price with an Approve button, or an honest reason — never a silent charge.
  await expect(ask.getByRole('button', { name: /Approve \d+ credits/ }).or(ask.getByText(/not set up|no video yet|accepts at most/))).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/B1-paid-step-waits.png` });
  // Nothing was charged.
  expect((await call<{ wallet: { balance: number } }>(page, 'GET', '/api/billing')).wallet.balance).toBe(before.wallet.balance);
  void id;
});

test('D — an AI action dragged onto a shot opens its card; the free camera move applies', async ({ page }) => {
  await storyProject(page);
  await page.getByRole('button', { name: 'AI actions' }).click();
  const chip = page.getByRole('toolbar', { name: 'AI actions' }).getByRole('button', { name: /Camera move/ });
  await chip.dragTo(page.getByTestId('shot-card').nth(2));
  const action = page.getByRole('dialog', { name: 'Camera move' });
  await expect(action).toBeVisible();
  await action.getByRole('button', { name: 'Dolly In' }).click();
  await action.getByRole('button', { name: 'Show the change' }).click();
  const ask = page.getByRole('dialog', { name: /Ask AI about Scene 1/ });
  await expect(ask.getByText(/Digital camera move on .*push in/)).toBeVisible();
  await ask.getByRole('button', { name: 'Apply change' }).click();
  await expect(page.getByTestId('shot-card').nth(2)).toContainText('push in');
});

test('E — the AI Director keeps its conversation, subject and unsent draft', async ({ page }) => {
  await storyProject(page);
  const director = page.getByTestId('director-node');
  await expect(director).toBeVisible();
  // Ask about one shot from its card: the Director now talks about that shot.
  await page.getByTestId('shot-card').nth(1).getByRole('button', { name: 'Ask AI' }).click();
  const card = page.getByRole('dialog', { name: /Ask AI about/ });
  await card.getByRole('textbox', { name: 'Ask the AI Director' }).fill('slow zoom in');
  await card.getByRole('textbox', { name: 'Ask the AI Director' }).press('Enter');
  await expect(card.getByText(/push in/)).toBeVisible();
  await card.getByRole('button', { name: 'Close' }).click();
  await expect(director.getByTestId('director-scope')).toHaveText(/shot 2|Scene 1 · shot/);
  // An unsent draft, then collapse, move around, reload.
  await director.getByRole('textbox', { name: 'Ask the AI Director' }).fill('Make the ending happier');
  await director.getByRole('button', { name: 'Collapse the AI Director' }).click();
  await expect(page.getByRole('button', { name: 'Expand the AI Director' })).toBeVisible();
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 300);
  await page.reload();
  await page.getByRole('tab', { name: 'Graph' }).click();
  await expect(page.getByTestId('story-graph')).toBeVisible();
  await page.getByRole('button', { name: 'Expand the AI Director' }).click();
  await expect(director.getByText('slow zoom in')).toBeVisible();
  await expect(director.getByRole('textbox', { name: 'Ask the AI Director' })).toHaveValue('Make the ending happier');
  await expect(director.getByTestId('director-scope')).toHaveText(/Scene 1 · shot/);
  await page.screenshot({ path: `${SHOTS}/E1-director-after-reload.png` });
});

test('S — the storyboard shows the planned shot in place, with Ask AI and Generate', async ({ page }) => {
  await storyProject(page);
  await edgePlus(page).nth(2).click();
  const card = page.getByRole('dialog', { name: /Ask AI about Between/ });
  await card.getByRole('textbox', { name: 'Ask the AI Director' }).fill('add a wide establishing shot of the kitchen');
  await card.getByRole('textbox', { name: 'Ask the AI Director' }).press('Enter');
  await card.getByRole('button', { name: 'Apply change' }).click();
  await expect(page.getByTestId('shot-card')).toHaveCount(4);
  await page.getByRole('tab', { name: 'Storyboard' }).click();
  const board = page.getByTestId('storyboard');
  await expect(board.getByTestId('story-card')).toHaveCount(4);
  const planned = board.getByTestId('story-card').nth(2);
  await expect(planned).toContainText('PLANNED');
  await expect(planned).toContainText('Wide establishing shot of the kitchen');
  await expect(planned.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/S1-storyboard-planned.png` });
});

test('K — Create a Cartoon: original styles; protected characters are refused before anything is sent', async ({ page }) => {
  await register(page);
  await page.goto('/app/new');
  await page.getByRole('textbox', { name: 'Describe your video' }).fill('Create a funny 30-second cartoon about a small robot who wants to become a chef');
  await expect(page.getByTestId('intent-suggestion')).toContainText('Cartoon');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/app\/cartoon\?/);
  await expect(page.getByLabel('Your idea')).toHaveValue(/small robot who wants to become a chef/);
  await expect(page.getByRole('radiogroup', { name: 'Cartoon style' }).getByRole('radio')).toHaveCount(12);
  await page.getByRole('radio', { name: /Clay stop motion/ }).click();
  await expect(page.getByRole('radio', { name: /Clay stop motion/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Your idea').fill('Pikachu learns to bake');
  await expect(page.getByText(/“Pikachu” is someone else’s character\. Framecraft makes original characters/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan my cartoon' })).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/K1-cartoon.png`, fullPage: true });
});

test('M — Character Bible: a brand mascot with personality and palette', async ({ page }) => {
  await register(page);
  await page.goto('/app/characters');
  await page.getByRole('button', { name: 'New character' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Cakey');
  await dialog.getByLabel('Kind').selectOption('mascot');
  await dialog.getByLabel('Personality').fill('cheerful, a little clumsy');
  await dialog.getByLabel('Drawn in the style').selectOption('cartoon_mascot');
  await dialog.getByRole('button', { name: 'Save character' }).click();
  const cardEl = page.getByText('Cakey').locator('xpath=ancestor::div[contains(@class,"overflow-hidden")][1]');
  await expect(cardEl).toContainText('mascot');
  await expect(cardEl).toContainText('cheerful, a little clumsy');
  await expect(cardEl).toContainText('Not in a shot yet');
  const { characters } = await call<{ characters: { name: string; styleMeta: Record<string, string> }[] }>(page, 'GET', '/api/characters');
  expect(characters.find((c) => c.name === 'Cakey')!.styleMeta).toMatchObject({ kind: 'mascot', personality: 'cheerful, a little clumsy', style: 'cartoon_mascot' });
});
