import { expect, test, type Page } from './fixtures.js';

/**
 * Editing a message you sent (BLG-385): it opens in place, and sending asks where it goes: Rewind
 * Here (what came after leaves the chat) or New Fork (a new worktree from that point; this one stays).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)').first();
const SHOTS = process.env.BELUGA_SHOTS;

async function openWorkspace(page: Page, name: string, project: string): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: project }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

async function answer(page: Page, text: string): Promise<void> {
  const done = page.locator('[data-turn="done"]');
  const before = await done.count();
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect.poll(() => done.count(), { timeout: 30_000 }).toBeGreaterThan(before);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

const mine = (page: Page, text: string) => page.locator('[data-mine="true"]', { hasText: text });

test('Rewind Here: the message and what came after leave the chat, the edit goes in its place', async ({ page }) => {
  await openWorkspace(page, 'new-hero', 'landing');
  await answer(page, 'Summarize the hero copy');
  await answer(page, 'Now list what to cut');
  const first = mine(page, 'Summarize the hero copy').last();
  await first.hover();
  await first.getByRole('button', { name: 'Edit message' }).click();
  const box = page.getByRole('textbox', { name: 'Edit your message' });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('Summarize the hero copy');
  await expect(page.getByRole('tab', { name: 'Rewind Here' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('the files go back to how they were then')).toBeVisible();
  await box.fill('Summarize the hero copy in one line');
  if (SHOTS) await page.locator('[data-edit-prompt]').screenshot({ path: `${SHOTS}/01-edit-rewind.png` });
  await page.getByRole('tab', { name: 'New Fork' }).click();
  await expect(page.getByText('Goes on in a new worktree from this point')).toBeVisible();
  if (SHOTS) await page.locator('[data-mine="true"]').filter({ has: page.locator('[data-edit-prompt]') }).screenshot({ path: `${SHOTS}/02-edit-fork.png` });
  await page.getByRole('tab', { name: 'Rewind Here' }).click();
  await box.press('Enter');
  await expect(box).toBeHidden();
  await expect(mine(page, 'Summarize the hero copy in one line')).toHaveCount(1);
  await expect(mine(page, 'Now list what to cut')).toHaveCount(0);
  await expect(page.getByText('Went back to before your edited message.')).toBeVisible();
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 30_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/03-after-rewind.png` });
});

test('Escape keeps the message as it was', async ({ page }) => {
  await openWorkspace(page, 'new-hero', 'landing');
  await answer(page, 'What does the hero say?');
  const row = mine(page, 'What does the hero say?').last();
  await row.hover();
  await row.getByRole('button', { name: 'Edit message' }).click();
  const box = page.getByRole('textbox', { name: 'Edit your message' });
  await box.fill('Something else');
  await box.press('Escape');
  await expect(box).toBeHidden();
  await expect(row).toContainText('What does the hero say?');
});

test('New Fork: goes on in a new worktree, this one stays as it was', async ({ page }) => {
  await openWorkspace(page, 'new-hero', 'landing');
  await answer(page, 'Draft a punchier headline');
  await answer(page, 'Make it shorter');
  const row = mine(page, 'Draft a punchier headline').last();
  await row.hover();
  await row.getByRole('button', { name: 'Edit message' }).click();
  await page.getByRole('tab', { name: 'New Fork' }).click();
  const box = page.getByRole('textbox', { name: 'Edit your message' });
  await box.fill('Draft a calmer headline');
  await box.press('Enter');
  await expect(page.getByText(/Forked from “new-hero” at your edited message/)).toBeVisible({ timeout: 20_000 });
  await expect(mine(page, 'Draft a punchier headline')).toHaveCount(0);
  await expect(mine(page, 'Draft a calmer headline')).toHaveCount(1);
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 30_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/04-after-fork.png` });
  // The original still has both.
  await openWorkspace(page, 'new-hero', 'landing');
  await expect(mine(page, 'Draft a punchier headline')).toHaveCount(1);
  await expect(mine(page, 'Make it shorter')).toHaveCount(1);
});
