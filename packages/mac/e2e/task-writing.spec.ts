import { expect, test, type Page } from './fixtures.js';

/**
 * A task its agent is still writing (BLG-598): its page shows the brief in outline with who is
 * writing it, and Start, the title and the comment box wait until it's written.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const SHOTS = process.env.BELUGA_SHOTS;

test('a task being written: a skeleton brief, and nothing to type into until it’s done', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: 'Tasks' }).click();
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'Board' }).click();
  const column = page.getByRole('list', { name: 'Board' }).getByRole('listitem', { name: /^Backlog/ });
  await column.getByRole('button', { name: 'New Task in Backlog' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Task' });
  // The demo's agent takes its time when asked to, so the writing can be watched.
  await sheet.getByRole('textbox', { name: 'Describe the task' }).fill('export the invoices as a csv, take your time');
  await sheet.getByRole('button', { name: 'Create Task' }).click();
  await expect(sheet).toBeHidden();
  await column.getByRole('button', { name: /export the invoices as a csv/ }).click();

  // Its page while it's written.
  const status = page.getByRole('status').filter({ hasText: /is writing this task…/ });
  await expect(status).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await expect(page.getByText('You can start it once its brief is written')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Comment' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Edit Goal' })).toHaveCount(0);
  if (SHOTS) {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/task-being-written.png` });
  }

  // Written: the brief, and everything open again.
  await expect(status).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Goal' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Title' })).not.toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Comment' })).toBeEnabled();
  if (SHOTS) {
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/task-written.png` });
  }
});
