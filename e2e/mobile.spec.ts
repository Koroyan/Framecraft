import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow, register } from './helpers';

test('mobile: landing, navigation and create flow fit the phone screen', async ({ page }) => {
  await page.goto('/');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: 'test-results/mobile-landing.png' });

  await register(page);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: 'test-results/mobile-dashboard.png' });

  await page.getByRole('link', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/app\/new/);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: 'test-results/mobile-new-video.png', fullPage: true });
  await page.getByRole('radio', { name: 'Text to video' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/app\/create/);
  await page.getByLabel('Video description').fill('Golden retriever surfing a small wave at sunset');
  await expect(page.getByText('Estimate', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: 'test-results/mobile-create.png', fullPage: true });

  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('link', { name: 'Credits & Billing' })).toBeVisible();
});
