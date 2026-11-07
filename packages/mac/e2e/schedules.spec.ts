import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Schedules in a chat, on the demo: the setting in Settings › Agent, a schedule made with /schedule,
 * its Info row and sidebar mark, Run now and its run line, an edit that asks before it loses changes,
 * pause and resume, and removing it, with no reload. The same in Your Mac's chat.
 * Screenshots go to .beluga/scratch/schedule-*.png.
 */

const shots = path.join(import.meta.dirname, '..', '..', '..', '.beluga', 'scratch');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const info = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)').first();
const editor = (page: Page) => page.getByRole('dialog', { name: /^(New|Edit) Schedule$/ });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const shoot = async (page: Page, name: string): Promise<void> => {
  // The Tip of the last click would cover what the picture is for.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `schedule-${name}.png`) });
};

async function turnOn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+,');
  await settings(page).getByRole('button', { name: 'Agent', exact: true }).click();
  // On by default. The switch turns them off and on again.
  const on = settings(page).getByRole('switch', { name: 'Schedules in chats' });
  await expect(on).toBeChecked();
  await on.click();
  await expect(on).not.toBeChecked();
  await on.click();
  await expect(on).toBeChecked();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
}

async function openWorktree(page: Page, project: string, name: string): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: project }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
}

const openInfo = (page: Page) => page.getByRole('complementary', { name: 'Panel' }).getByRole('tab', { name: 'Info' }).click();

async function makeSchedule(page: Page, title: string, prompt: string): Promise<void> {
  await composer(page).fill('/schedule');
  await composer(page).press('Enter');
  await expect(page.getByRole('option', { name: /^new/ })).toBeVisible();
  await composer(page).press('Enter');
  await expect(editor(page)).toBeVisible();
  await editor(page).getByLabel('Name').fill(title);
  await editor(page).getByLabel('Prompt').fill(prompt);
  await expect(editor(page).getByText('Runs on this')).toBeVisible();
  await expect(editor(page).getByText('Deleting the chat deletes the schedule')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('create, run, edit, pause, resume and remove in a worktree chat', async ({ page }) => {
  await turnOn(page);
  await openWorktree(page, 'bob-api', 'add-auth');
  await openInfo(page);
  await expect(info(page).getByRole('heading', { name: /^Schedules/ })).toBeHidden();

  await makeSchedule(page, 'Nightly check', 'Look at the failing tests and say what changed.');
  await shoot(page, '01-editor');
  await editor(page).getByRole('button', { name: 'Create Schedule' }).click();
  await expect(editor(page)).toBeHidden();

  const row = info(page).locator('[data-schedule="Nightly check"]');
  await expect(row).toContainText('Every day at');
  await expect(row).toContainText('next in');
  await expect(row).toHaveAttribute('data-status', 'never');
  const mark = sidebar(page).locator('[data-schedule-mark]');
  await expect(mark).toHaveAttribute('data-schedule-mark', 'on');
  await shoot(page, '02-info-row');

  // Run now: a quiet line in the chat with the prompt folded, never a message of yours.
  await row.getByRole('button', { name: 'Run now' }).click();
  const line = page.locator('[data-schedule-run="Nightly check"]');
  await expect(line).toBeVisible();
  await expect(line).toContainText('due');
  await expect(line).not.toContainText('failing tests');
  await line.getByRole('button').click();
  await expect(line).toContainText('failing tests');
  await expect(page.locator('main').getByText('Look at the failing tests', { exact: false })).toHaveCount(1);
  await shoot(page, '03-run-line');
  await expect(row).toHaveAttribute('data-status', 'ok', { timeout: 30_000 });

  // Edit: changes ask before they go, then the row follows.
  await row.getByRole('button', { name: 'Edit' }).click();
  await editor(page).getByLabel('Name').fill('Nightly tests');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog').getByText('Discard your changes?')).toBeVisible();
  await shoot(page, '04-discard');
  await page.getByRole('button', { name: 'Keep Editing' }).click();
  await editor(page).getByRole('tab', { name: 'Every N minutes' }).click();
  await editor(page).getByLabel('Minutes').fill('45');
  await editor(page).getByRole('button', { name: 'Save' }).click();
  await expect(editor(page)).toBeHidden();
  const edited = info(page).locator('[data-schedule="Nightly tests"]');
  await expect(edited).toContainText('Every 45 minutes');

  // Pause: the mark is muted; resume: it's back. No reload.
  await edited.getByRole('switch').click();
  await expect(edited).toHaveAttribute('data-status', 'paused');
  await expect(edited).toContainText('paused');
  await expect(mark).toHaveAttribute('data-schedule-mark', 'paused');
  await shoot(page, '05-paused');
  await edited.getByRole('switch').click();
  await expect(edited).not.toHaveAttribute('data-status', 'paused');
  await expect(mark).toHaveAttribute('data-schedule-mark', 'on');

  // Settings lists it, and its link opens the chat.
  await edited.getByRole('button', { name: 'Edit' }).click();
  await editor(page).getByRole('button', { name: 'Cancel' }).click();
  await page.keyboard.press('Meta+,');
  await settings(page).getByRole('button', { name: 'Agent', exact: true }).click();
  const listed = settings(page).locator('[data-schedule-setting="Nightly tests"]');
  await listed.scrollIntoViewIfNeeded();
  await expect(listed).toContainText('Every 45 minutes');
  await shoot(page, '06-settings');
  await listed.getByRole('button', { name: 'More for Nightly tests' }).click();
  await expect(page.getByRole('menuitem', { name: 'Pause' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Run now' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(settings(page)).toBeHidden();
  await editor(page).getByRole('button', { name: 'Cancel' }).click();
  await page.keyboard.press('Meta+,');
  await settings(page).getByRole('button', { name: 'Agent', exact: true }).click();
  await listed.getByRole('button', { name: 'More for Nightly tests' }).click();
  await page.getByRole('menuitem', { name: 'Pause' }).click();
  await expect(listed).toHaveAttribute('data-status', 'paused');
  await listed.getByRole('button', { name: 'More for Nightly tests' }).click();
  await page.getByRole('menuitem', { name: 'Resume' }).click();
  await expect(listed).not.toHaveAttribute('data-status', 'paused');
  await listed.getByRole('button', { name: 'More for Nightly tests' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(listed).toBeVisible();
  await listed.getByRole('button', { name: /^add-auth/ }).click();
  await expect(settings(page)).toBeHidden();

  // ⌘K finds it too: a new one here, and a change to this one.
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('Edit Schedule');
  await page.keyboard.press('Enter');
  await expect(editor(page).getByLabel('Name')).toHaveValue('Nightly tests');
  await editor(page).getByRole('button', { name: 'Cancel' }).click();

  // Remove asks first; the section and the mark go.
  await edited.getByRole('button', { name: 'Edit' }).click();
  await editor(page).getByRole('button', { name: 'Remove' }).click();
  await shoot(page, '07-remove');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(editor(page)).toBeHidden();
  await expect(info(page).getByRole('heading', { name: /^Schedules/ })).toBeHidden();
  await expect(mark).toHaveCount(0);
  // The run line stays in the chat: it says what happened.
  await expect(line).toBeVisible();
});

test('a Your Mac chat has its section, mark and run line too', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByText('Your Mac', { exact: true }).click();
  await openInfo(page);
  await makeSchedule(page, 'Disk report', 'Say how full the disk is.');
  await editor(page).getByRole('button', { name: 'Create Schedule' }).click();
  const row = info(page).locator('[data-schedule="Disk report"]');
  await expect(row).toBeVisible();
  await expect(sidebar(page).locator('[data-schedule-mark="on"]')).toBeVisible();
  await row.getByRole('button', { name: 'Run now' }).click();
  await expect(page.locator('[data-schedule-run="Disk report"]')).toBeVisible();
  await shoot(page, '08-your-mac');
});
