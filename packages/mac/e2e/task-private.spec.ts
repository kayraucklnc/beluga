import { expect, test, type Page } from './fixtures.js';

/** Private tasks (BLG-501): words asking for it make it private, a lock shows it, and Share with Team sends it. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const SHOT = process.env.TASK_PRIVATE_SHOT;

async function openTasks(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: 'Tasks' }).click();
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeVisible();
}

test('a task asked for “just for me” is private until shared with the team', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('button', { name: 'New Task', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New Task' });
  await sheet.getByRole('textbox', { name: 'Describe the task' }).fill('Draft the X launch thread, just for me');
  const who = sheet.getByRole('radiogroup', { name: 'Who sees it' });
  await expect(who.getByRole('radio', { name: 'Only You' })).toHaveAttribute('aria-checked', 'true');
  await expect(sheet).toContainText('Your words asked to keep it to yourself');
  if (SHOT) await sheet.screenshot({ path: `${SHOT}-new-task.png` });
  await sheet.getByRole('button', { name: 'Create Task' }).click();
  await expect(sheet).toBeHidden();

  const row = page.getByRole('row', { name: /X launch thread.*, private$/ });
  await expect(row).toBeVisible({ timeout: 20_000 });
  if (SHOT) {
    await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'Board' }).click();
    const card = page.getByRole('button', { name: /X launch thread.*, private$/ });
    await expect(card).toBeVisible();
    await page.mouse.move(0, 0);
    const column = page.getByRole('list', { name: 'Board' }).getByRole('listitem', { name: /^Ready/ });
    await column.screenshot({ path: `${SHOT}-board.png` });
    await card.click();
  } else await row.click();

  const banner = page.getByRole('status').filter({ hasText: 'Private.' });
  await expect(banner).toContainText('Only you see it');
  if (SHOT) await page.locator('main').screenshot({ path: `${SHOT}-page.png` });
  await banner.getByRole('button', { name: 'Share with Team' }).click();
  await expect(banner).toBeHidden();
  await page.getByRole('button', { name: 'More' }).first().click();
  await expect(page.getByRole('menuitem', { name: /Make Private/ })).toBeVisible();
});
