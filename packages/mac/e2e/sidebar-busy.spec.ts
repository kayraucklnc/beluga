import { expect, test } from '@playwright/test';

/**
 * Folded, a project still says Claude is at work inside it (the dot matrix on its row), beside
 * whatever count or "needs you" mark it has, never hidden by them.
 */
test('a folded project shows Claude working inside it', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  await sidebar.getByRole('button', { name: 'webhook-retries', exact: true }).click();
  const box = page.locator('textarea:not(.xterm-helper-textarea)');
  await expect(box).toHaveAttribute('placeholder', /webhook-retries/);
  const fold = sidebar.getByRole('button', { name: /^Fold bob-api/ });
  await fold.click();
  await box.fill('run the tests please');
  await box.press('Enter');
  const row = sidebar.getByRole('button', { name: 'bob-api', exact: true });
  await expect(row.locator('[data-busy] [data-dot-matrix]')).toBeVisible({ timeout: 10_000 });
  // Unfold it again for the other tests.
  await sidebar.getByRole('button', { name: /^Show what's in bob-api/ }).click();
});
