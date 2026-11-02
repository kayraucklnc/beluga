import { expect, test } from './fixtures.js';

/** Settings › Appearance › Reduce transparency: a solid window, kept across a reload (BLG-409). */
test('Reduce transparency makes the window solid, and is remembered', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-transparency', 'full');
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Appearance' }).click();
  const reduce = page.getByRole('switch', { name: 'Reduce transparency' });
  await expect(reduce).not.toBeChecked();
  await reduce.click();
  await expect(page.locator('html')).toHaveAttribute('data-transparency', 'reduce');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-transparency', 'reduce');
});
