import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('health reports the backend the suite is running on', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBeTruthy();
});

test('an unauthenticated visitor is sent to sign in', async ({ page }) => {
  await page.goto('/my-drive');
  await expect(page).toHaveURL(/\/login/);
});

test('a seeded employee signs in and reaches My Drive', async ({ page }) => {
  await signIn(page, 'scientist');
  await page.goto('/my-drive');
  await expect(page).toHaveTitle(/My Drive/);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
});
