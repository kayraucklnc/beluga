import { expect, test, type Page } from './fixtures.js';

/** Tasks Claude shows in an answer (BLG-26): `task:BOB-3` chips and a beluga-tasks list, live, that open the task. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const SHOT = process.env.TASK_CARDS_SHOT;

async function openWorkspace(page: Page, name: string): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

test('shows tasks in the answer, live, and opens one', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await openWorkspace(page, 'webhook-retries');
  await expect(page.getByRole('button', { name: 'Stop Claude' })).toHaveCount(0, { timeout: 90_000 });
  await composer(page).fill('where do my tasks stand?');
  await composer(page).press('Enter');

  const intro = page.getByText(/is waiting on bob’s review/).last();
  await expect(intro.getByRole('button', { name: /^BOB-3: Add auth to the payment routes, In Review/ })).toBeVisible({ timeout: 20_000 });
  const cards = page.getByRole('list', { name: '5 tasks' }).last();
  await expect(cards.getByRole('button', { name: /BOB-4.*Idempotent webhook retries/ })).toContainText('In Progress');
  await expect(cards.getByRole('button', { name: /BOB-5.*Refund endpoint/ })).toContainText('Backlog');
  // A key the board doesn't have: quiet, not a broken card.
  await expect(cards.getByRole('listitem').last()).toContainText(/BOB-99\s*not found/);
  if (SHOT) {
    await page.mouse.move(0, 0);
    await cards.evaluate((el) => el.closest('[data-message], article, li')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
    const box = await intro.boundingBox();
    const end = await cards.boundingBox();
    if (box && end) await page.screenshot({ path: SHOT, clip: { x: Math.min(box.x, end.x) - 24, y: box.y - 24, width: Math.max(box.width, end.width) + 48, height: end.y + end.height - box.y + 48 } });
  }

  // A click opens the task's page.
  await cards.getByRole('button', { name: /BOB-5/ }).click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Refund endpoint');
});
