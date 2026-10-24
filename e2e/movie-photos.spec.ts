import { test, expect, type Page } from '@playwright/test';
import { register } from './helpers';

/** Paid paths must never run against a live server: skip them unless the app is in fixture mode. */
test.beforeEach(async ({ request }, testInfo) => {
  if (!/creator journey|movie maker/.test(testInfo.titlePath.join(' '))) return;
  const status = await (await request.get('/api/system/status')).json();
  testInfo.skip(status.liveGenerationEnabled, 'Live AI generation is on — skipping tests that would spend real provider credits.');
});


// 2x2 PNG (valid image bytes, so the server's content sniffing accepts it).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8Dwn4GBgYGBgQEAHwQDAWKGu1QAAAAASUVORK5CYII=', 'base64');

async function addPhoto(page: Page, name: string, note: string, index: number) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Add photo/ }).click();
  await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: PNG });
  await page.getByText('I own this file or have permission').click();
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByAltText(`Reference photo${index}`)).toBeVisible();
  await page.getByLabel(`Note for photo${index}`).fill(note);
}

test('movie maker: user photos referenced as photo1 / photo2 become the cast and location', async ({ page }) => {
  await register(page);
  await page.goto('/app/movie');
  await page.getByLabel('Film story').fill('A young painter who looks like');
  await addPhoto(page, 'painter.png', 'Nino, the painter', 1);
  // Adding a photo inserts its token into the story automatically.
  await expect(page.getByLabel('Film story')).toHaveValue(/photo1/);
  await page.getByLabel('Film story').pressSequentially(' returns to her childhood house like ');
  await addPhoto(page, 'house.png', 'grandmother’s house', 2);
  await expect(page.getByLabel('Film story')).toHaveValue(/photo1.*house like.*photo2/s);
  await page.screenshot({ path: 'test-results/movie-photos.png' });

  await page.getByRole('button', { name: /Write the screenplay/ }).click();
  await expect(page).toHaveURL(/\/app\/movie\/[0-9a-f-]+/);
  await expect(page.getByText(/offline planner/i)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('tab', { name: /Cast/ }).click();
  await expect(page.getByText('Nino, the painter', { exact: true })).toBeVisible();
  await expect(page.getByText('grandmother’s house', { exact: true })).toBeVisible();
  await expect(page.getByAltText('Reference photo')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/movie-cast.png' });
});
