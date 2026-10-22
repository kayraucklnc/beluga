import { expect, test, type Page } from '@playwright/test';

/**
 * A running plan is a black box at the top level (KLD-29): its task chats getting answers make
 * one Unread row for the plan ("Card checkout for launch · 2 updates"), never one per chat.
 * Inside the plan each task keeps its own mark, and ⋯ can show the task chats in the sidebar.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const unreadSection = (page: Page) => sidebar(page).getByRole('region', { name: 'Unread' });
const composer = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').first();
const PLAN = 'Card checkout for launch';
const TASK_WORKTREES = ['checkout-auth', 'checkout-events'];

const block = (page: Page) => sidebar(page).locator('[data-slot^="project:"]').filter({ has: page.locator('[data-drag^="project:"][aria-label="bob-api"]') }).last();
const planRow = (page: Page) => block(page).locator('[data-plan-row]').and(page.getByRole('button', { name: PLAN, exact: true }));
const row = (page: Page, name: string) => sidebar(page).getByRole('button', { name, exact: true });

async function unfold(page: Page, project: string): Promise<void> {
  const show = sidebar(page).getByRole('button', { name: `Show what's in ${project}` });
  if (await show.isVisible()) await show.click();
}

/** The plan page's ⋯ › Show Task Chats in the Sidebar (checked while they show). */
async function taskChats(page: Page, on: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Plan Options' }).click();
  const item = page.getByRole('menuitem', { name: 'Show Task Chats in the Sidebar' });
  if (on) await expect(item).not.toHaveAttribute('data-checked', 'true');
  else await expect(item).toHaveAttribute('data-checked', 'true');
  await item.click();
}

test.use({ viewport: { width: 1440, height: 1400 } });

test('a running plan whose task chats get answers is one Unread row, not one per chat; inside, each task keeps its mark', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await unfold(page, 'bob-api');
  await planRow(page).click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue(PLAN);

  // For the detail: ⋯ shows its task chats under the plan's row (off by default).
  for (const name of TASK_WORKTREES) await expect(row(page, name)).toHaveCount(0);
  await taskChats(page, true);
  for (const name of TASK_WORKTREES) await expect(row(page, name)).toBeVisible();

  // Ask each task's Claude something that takes a while, and leave.
  for (const name of TASK_WORKTREES) {
    await row(page, name).click();
    await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
    await page.waitForTimeout(500);
    await composer(page).fill('Take a deep dive into the webhooks, take your time');
    await composer(page).press('Enter');
    await expect(row(page, name)).toHaveAttribute('data-signal-row', 'working', { timeout: 10_000 });
  }
  // Back to one row.
  await planRow(page).click();
  await taskChats(page, false);
  for (const name of TASK_WORKTREES) await expect(row(page, name)).toHaveCount(0);
  await unfold(page, 'landing');
  await row(page, 'new-hero').click();

  // Both answered: the plan is in Unread once, with how many updates; its chats aren't, one by one.
  const listed = unreadSection(page).getByRole('button', { name: new RegExp(`^${PLAN} · .*2 updates`) });
  await expect(listed).toBeVisible({ timeout: 90_000 });
  await expect(unreadSection(page).getByRole('button', { name: new RegExp(`^${PLAN} ·`) })).toHaveCount(1);
  for (const name of TASK_WORKTREES) await expect(unreadSection(page).getByRole('button', { name: new RegExp(`^${name} ·`) })).toHaveCount(0);
  await expect(unreadSection(page).getByRole('button', { name: /^Plan: / })).toHaveCount(0);
  if (process.env.SHOTS) await sidebar(page).screenshot({ path: `${process.env.SHOTS}/unread-plan-row.png` });

  // Opening it opens the plan; inside, each task's chat has its own mark, a click away.
  await listed.click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue(PLAN);
  await page.locator('main').getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'List' }).click();
  const auth = page.getByRole('region', { name: 'Safe payments' }).locator('li').filter({ hasText: 'Add auth to the payment routes' }).first();
  await expect(auth.locator('[data-task-chat="unread"]')).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/plan-task-marks.png` });
  await auth.getByText('Add auth to the payment routes', { exact: true }).click();
  await page.getByRole('complementary', { name: 'Details' }).getByRole('button', { name: /Open Worktree/ }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', /checkout-auth/);
  // Read there: the plan now has one update left.
  await expect(unreadSection(page).getByRole('button', { name: new RegExp(`^${PLAN} · .*1 update`) }).or(unreadSection(page).getByRole('button', { name: `${PLAN} · read` }))).toBeVisible();
});
