import { expect, test, type Page } from './fixtures.js';

/**
 * Private tasks (BLG-501), against the demo's team scene (BELUGA_DEMO_SCENE=team: bob teams up on
 * bob-api): words asking for it make it private, a lock shows it, and Share with Team sends it.
 */

test.skip(process.env.BELUGA_DEMO_SCENE !== 'team', 'needs BELUGA_DEMO_SCENE=team');
test.use(process.env.TASK_PRIVATE_SHOT ? { deviceScaleFactor: 2 } : {});

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const SHOT = process.env.TASK_PRIVATE_SHOT;

async function openTasks(page: Page): Promise<void> {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const card = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  if (await card.isVisible()) await card.getByRole('button', { name: 'Turn On' }).click();
  await sidebar(page).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: 'Tasks' }).click();
  // bob asked to team up on bob-api.
  await page.getByRole('button', { name: 'Team Up' }).first().click({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Team Up' })).toHaveCount(0, { timeout: 30_000 });
}

test('a task asked for “just for me” is private until shared with the team', async ({ page }) => {
  test.setTimeout(150_000);
  await openTasks(page);
  await page.getByRole('button', { name: 'New Task', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New Task' });
  await sheet.getByRole('textbox', { name: 'Describe the task' }).fill('Draft the X launch thread, just for me');
  const who = sheet.getByRole('radiogroup', { name: 'Who sees it' });
  await expect(who.getByRole('radio', { name: 'Only You' })).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
  await expect(who.getByRole('radio', { name: /You and bob/ })).toHaveAttribute('aria-checked', 'false');
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
  await page.getByRole('navigation', { name: 'Where this task is' }).getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menuitem', { name: /Make Private/ })).toBeVisible();
});
