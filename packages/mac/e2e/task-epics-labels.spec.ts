import { expect, test, type Page } from './fixtures.js';

/** Epics look like one on the board, and labels come from a set (BLG-267, BLG-269). */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const SHOTS = process.env.EPIC_SHOTS;

test('an epic is a deck on the board; labels are picked from the set, and a new one is made on purpose', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page).getByRole('button', { name: 'bob-api', exact: true })).toBeVisible();
  // ⌘K › Go to Tasks.
  await page.keyboard.press('Meta+K');
  await page.keyboard.type('Go to Tasks');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeVisible();
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'Board' }).click();
  const board = page.getByRole('list', { name: 'Board' });
  const epic = board.getByRole('button', { name: /Payments API v1/ });
  await expect(epic).toContainText('Epic');
  await expect(epic).toContainText(/\d of \d done/);
  // Its sub-tasks say which epic they're in.
  await expect(board.getByRole('button', { name: /Refund endpoint/ })).toContainText('BOB-1');
  if (SHOTS) {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/01-board-epic.png` });
  }

  // The list marks it too; its page says it's an epic.
  await epic.click();
  await expect(page.getByText(/^Epic/).first()).toBeVisible();
  // Labels: the set, with no typing a new one in passing.
  await page.getByRole('button', { name: /Payments|Important/ }).first().waitFor();
  await page.locator('[class*="propLabels"] button').last().click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /^Bug/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Payments/ })).toBeVisible();
  await expect(menu.getByPlaceholder('Find or create…')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-labels-menu.png` });
  await menu.getByRole('menuitem', { name: 'New Label…' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Label' });
  await sheet.getByLabel('Name').fill('Performance');
  await sheet.getByRole('radio', { name: 'gauge' }).click();
  await sheet.getByRole('radio', { name: 'Orange' }).click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/03-new-label.png` });
  await sheet.getByRole('button', { name: 'Create and Add' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('[class*="propLabels"]')).toContainText('Performance');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/04-task-page.png` });
});
