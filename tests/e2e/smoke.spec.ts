import { expect, test } from '@playwright/test';

test('app shell is available with heading', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Seq', exact: true })).toBeVisible();
  await expect(page.getByRole('application', { name: 'Genome browser viewport' })).toBeVisible();
});
