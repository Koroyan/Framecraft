import { test, expect } from '@playwright/test';
import { login, register } from './helpers';

/** Paid paths must never run against a live server: skip them unless the app is in fixture mode. */
test.beforeEach(async ({ request }, testInfo) => {
  if (!/creator journey|movie maker/.test(testInfo.titlePath.join(' '))) return;
  const status = await (await request.get('/api/system/status')).json();
  testInfo.skip(status.liveGenerationEnabled, 'Live AI generation is on — skipping tests that would spend real provider credits.');
});


test.describe('public site', () => {
  test('landing page presents the product honestly', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('expensive');
    await expect(page.getByText('Illustrative artwork — not AI output').first()).toBeVisible();
    // Live data from the API: real catalog and plans.
    await expect(page.getByText(/Kling 3\.0 Pro/).first()).toBeVisible();
    await expect(page.getByText('Most popular')).toBeVisible();
    // No invented social proof.
    await expect(page.getByText(/testimonial|trusted by \d|10,000\+ creators/i)).toHaveCount(0);
    await page.screenshot({ path: 'test-results/landing.png', fullPage: false });
  });

  test('protected pages redirect to sign-in', async ({ page }) => {
    await page.goto('/app/projects');
    await expect(page).toHaveURL(/\/login\?next=/);
  });
});

test.describe('creator journey', () => {
  test('register → quick create → labelled fixture video → editor', async ({ page }) => {
    await register(page);
    await expect(page.getByText('Development mode')).toBeVisible();
    await page.goto('/app/create');
    await page.getByLabel('Video description').fill('A futuristic car driving through Tokyo at night, neon reflections');
    // Live estimate from the routing engine.
    await expect(page.getByText('Estimate', { exact: true })).toBeVisible();
    await expect(page.getByText(/credits/).first()).toBeVisible();
    await page.getByText('Why this model?').click();
    await expect(page.getByText(/Needs text to video/)).toBeVisible();
    await page.screenshot({ path: 'test-results/create.png' });

    await page.getByRole('button', { name: /Generate/ }).click();
    await expect(page.getByText('Pipeline test complete')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('TEST FIXTURE · NOT AI').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Download MP4/ })).toHaveAttribute('href', /\/api\/media\//);
    await page.screenshot({ path: 'test-results/result.png' });

    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Editor' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clip 1' })).toBeVisible();
    await page.getByRole('tab', { name: /Text/ }).click();
    await page.getByRole('button', { name: /Add text at playhead/ }).click();
    await expect(page.getByText(/Unsaved changes|Saving…|All changes saved/)).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.screenshot({ path: 'test-results/editor.png' });
  });

  test('template workflow plans multiple shots with per-shot estimates', async ({ page }) => {
    await register(page);
    await page.goto('/app/create?template=restaurant');
    await page.getByPlaceholder('Salobie Bia').fill('Salobie Bia');
    await page.getByPlaceholder('Khachapuri fresh from the oven').fill('Adjarian khachapuri');
    await page.getByRole('button', { name: /Plan shots/ }).click();
    await expect(page.getByText('Total estimate')).toBeVisible();
    await expect(page.getByText(/Sizzle/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Generate 3 shots/ })).toBeEnabled({ timeout: 20_000 });
  });

  test('movie maker plans a film offline and shows the budget gate', async ({ page }) => {
    await register(page);
    await page.goto('/app/movie');
    await page.getByPlaceholder(/detective investigating/).fill('A lighthouse keeper discovers a message in a bottle from the future');
    await page.getByRole('button', { name: /Write the screenplay/ }).click();
    await expect(page).toHaveURL(/\/app\/movie\/[0-9a-f-]+/);
    await expect(page.getByText(/offline planner/i)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('tab', { name: /Shots/ })).toBeVisible();
    await page.getByRole('button', { name: /Budget & generate/ }).click();
    await expect(page.getByText('Total for remaining shots')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Generate film/ })).toBeDisabled();
    await page.getByText(/I approve spending/).click();
    await expect(page.getByRole('button', { name: /Generate film/ })).toBeEnabled();
    await page.screenshot({ path: 'test-results/movie.png' });
  });
});

test.describe('admin', () => {
  test('admin dashboard is restricted and shows live metrics', async ({ page }) => {
    await register(page);
    await page.goto('/app/admin');
    await expect(page.getByText('Administrator access required.')).toBeVisible();
    await page.context().clearCookies();
    await login(page, 'admin@framecraft.local', 'framecraft-demo-1');
    await page.goto('/app/admin');
    await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible();
    await expect(page.getByText('Generations (30d)')).toBeVisible();
    await page.getByRole('tab', { name: 'Models & pricing' }).click();
    await expect(page.getByText('runway:kling3.0_pro')).toBeVisible();
    await page.screenshot({ path: 'test-results/admin.png' });
  });
});

test.describe('accessibility basics', () => {
  test('images have alt text and icon buttons have names', async ({ page }) => {
    await register(page);
    for (const path of ['/app', '/app/create', '/app/social', '/app/billing']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const missingAlt = await page.locator('img:not([alt])').count();
      expect(missingAlt, `${path} images without alt`).toBe(0);
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll('button')].filter((b) => !(b.textContent ?? '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')).length,
      );
      expect(unnamed, `${path} unnamed buttons`).toBe(0);
    }
  });
});
