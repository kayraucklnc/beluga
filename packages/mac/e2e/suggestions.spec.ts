import { expect, test, type Locator } from '@playwright/test';

/** The / and @ suggestions: the highlighted one stays in view while the arrows move through a long list. */

async function inView(list: Locator, item: Locator): Promise<boolean> {
  const [l, i] = await Promise.all([list.boundingBox(), item.boundingBox()]);
  return Boolean(l && i && i.y >= l.y - 1 && i.y + i.height <= l.y + l.height + 1);
}

test('arrowing through / commands scrolls the list with the highlight', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: 'Group chat' }).click();
  const box = page.locator('main textarea').last();
  await box.fill('/');
  const list = page.getByRole('listbox', { name: 'Suggestions' });
  await expect(list).toBeVisible();
  const count = await list.getByRole('option').count();
  expect(count).toBeGreaterThan(10);
  // Up from the first wraps to the last, far below: it scrolls into view.
  await box.press('ArrowUp');
  let on = list.locator('[aria-selected="true"]');
  await expect(on).toHaveCount(1);
  expect(await inView(list, on)).toBe(true);
  // Down again wraps to the top.
  await box.press('ArrowDown');
  on = list.locator('[aria-selected="true"]');
  expect(await inView(list, on)).toBe(true);
  for (let i = 0; i < Math.min(count - 1, 20); i++) {
    await box.press('ArrowDown');
    expect(await inView(list, list.locator('[aria-selected="true"]'))).toBe(true);
  }
});
