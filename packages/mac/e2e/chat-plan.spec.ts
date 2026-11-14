import { expect, test, type Page } from './fixtures.js';

/**
 * A chat's own plan (chatPlans, BLG-418): "turn this into a plan" opens the Plan tab in the right
 * panel, at the Plan page's proportions, and the draft fills it; Close keeps it as an earlier plan,
 * read-only; New Plan starts the next one. With the pref off, the chat's panel is as it was.
 */

test.describe.configure({ mode: 'serial' });

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const planTab = (page: Page) => panel(page).getByRole('tab', { name: 'Plan', exact: true });
const box = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').last();

/** The demo's chat in bob-api (its project unfolded when it's folded). */
async function openChat(page: Page): Promise<void> {
  const chat = sidebar(page).getByRole('button', { name: 'How do deploys work?' });
  if (!(await chat.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await chat.click();
}

async function chatPlans(page: Page, on: boolean): Promise<void> {
  // The window takes keys once its sidebar is there.
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Chat plans' });
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
  await page.keyboard.press('Escape');
}

test('with chatPlans off, a chat’s panel has no Plan tab', async ({ page }) => {
  await page.goto('/');
  await openChat(page);
  await expect(panel(page).getByRole('tab', { name: 'Files' })).toBeVisible();
  await expect(planTab(page)).toHaveCount(0);
});

test('“turn this into a plan” opens the Plan tab at the Plan page’s proportions; Close, New Plan and the earlier plan', async ({ page }) => {
  await page.goto('/');
  await chatPlans(page, true);
  await openChat(page);
  await expect(planTab(page)).toHaveCount(0);

  await box(page).fill('Turn this into a plan');
  await box(page).press('Enter');
  // The chat is the plan's home now: its tab opens by itself, and the draft fills it live.
  await expect(planTab(page)).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
  await expect(panel(page).getByRole('button', { name: 'Approve Plan' })).toBeVisible({ timeout: 30_000 });
  await expect(panel(page)).toContainText('Groundwork');

  // As wide as the window less the sidebar and the Plan page's 380 px chat; other tabs keep their width.
  const window = page.viewportSize()!.width;
  const side = (await sidebar(page).boundingBox())!.width;
  const wide = (await panel(page).boundingBox())!.width;
  expect(Math.abs(wide - (window - side - 380))).toBeLessThanOrEqual(2);
  await panel(page).getByRole('tab', { name: 'Files' }).click();
  await expect.poll(async () => (await panel(page).boundingBox())!.width).toBeLessThan(wide - 100);
  await planTab(page).click();
  await expect.poll(async () => (await panel(page).boundingBox())!.width).toBeCloseTo(wide, 0);

  // Close, after a confirm: no current plan, New Plan, and the closed one among the earlier plans.
  await panel(page).getByRole('button', { name: 'Close Plan' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close Plan' }).click();
  await expect(panel(page).getByRole('button', { name: 'New Plan' })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Earlier Plans (1)' })).toBeVisible();

  // New Plan: the chat's agent opens the next one, and its draft shows.
  await panel(page).getByRole('button', { name: 'New Plan' }).click();
  await expect(panel(page).getByRole('button', { name: 'Approve Plan' })).toBeVisible({ timeout: 30_000 });
  await expect(panel(page).getByRole('button', { name: 'Close Plan' })).toBeVisible();

  // The earlier plan opens read-only: nothing to approve, close, start or rename.
  await panel(page).getByRole('button', { name: 'Earlier Plans (1)' }).click();
  await page.getByRole('menuitem').first().click();
  await expect(panel(page).getByText('Earlier plan · read-only')).toBeVisible();
  await expect(panel(page)).toContainText('Groundwork');
  await expect(panel(page).getByRole('button', { name: 'Approve Plan' })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Close Plan' })).toHaveCount(0);
  await expect(panel(page).getByRole('textbox', { name: 'Plan name' })).toHaveAttribute('readonly', '');
  await panel(page).getByRole('button', { name: 'Current Plan' }).click();
  await expect(panel(page).getByRole('button', { name: 'Approve Plan' })).toBeVisible();
});
