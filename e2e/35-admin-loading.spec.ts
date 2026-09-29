/**
 * Regression: the *Add employee* dialog's pickers must work while the employee list is still
 * loading. The table was handed a fresh `[]` on every render until the list arrived, which
 * TanStack Table answers with a page-index reset — a state update — so the page re-rendered for
 * ever and any open picker's options were detached before they could be clicked.
 */
import { expect, test } from '@playwright/test';
import { contextFor } from './helpers';

test('the department picker works while the employee list is still loading', async ({ browser }) => {
  const { context, page } = await contextFor(browser, 'admin');
  try {
    // Hold the list back long enough to open the picker against the loading state.
    await page.route('**/api/admin/users?**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      await route.continue();
    });
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'Add employee' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add employee' });
    await dialog.getByLabel('Department').click();
    const option = page.getByRole('option', { name: 'No department' });
    await expect(option).toBeVisible();
    await page.waitForTimeout(10_000); // across the list's arrival
    await option.click();
    await expect(dialog.getByLabel('Department')).toHaveText(/No department/);
  } finally {
    await context.close();
  }
});
