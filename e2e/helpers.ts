import { expect, type Page } from '@playwright/test';

export const uniqueEmail = (p = 'e2e') => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.dev`;

export async function register(page: Page, email = uniqueEmail()) {
  await page.goto('/register');
  await page.getByLabel('Name').fill('E2E Creator');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/app/);
  return email;
}

export async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app/);
}

/** The page never scrolls sideways (mobile-first requirement). */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}
