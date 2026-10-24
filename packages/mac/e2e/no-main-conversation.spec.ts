import { expect, test, type Locator, type Page } from './fixtures.js';

/**
 * No standing "main" conversation in a project (BLG-70): a project's conversations are the chats
 * and worktrees you start. New Chat on main makes a new, separate chat every time, and nothing
 * opens the main checkout as a conversation (it's the project's home instead).
 *
 * E2E_SHOTS=<folder> saves screenshots of the sidebar along the way.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea):not([aria-label="Plan name"]):not([aria-label="Message Claude about the plan"])');
const projectRow = (page: Page, name: string): Locator => sidebar(page).getByRole('button', { name, exact: true }).and(page.locator('[aria-expanded]'));
const shots = process.env.E2E_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function unfold(page: Page, project: string): Promise<void> {
  await expect(projectRow(page, project)).toBeVisible();
  const show = sidebar(page).getByRole('button', { name: `Show what's in ${project}` });
  if (await show.isVisible()) await show.click();
  await expect(projectRow(page, project)).toHaveAttribute('aria-expanded', 'true');
}

/** A new chat in bob-api from the sidebar's +, with its first message. */
async function newChat(page: Page, text: string): Promise<void> {
  await projectRow(page, 'bob-api').hover();
  await sidebar(page).getByRole('button', { name: 'New chat in bob-api' }).click();
  await expect(composer(page)).toBeVisible();
  await expect(composer(page)).toHaveValue('');
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(sidebar(page).getByRole('button', { name: text, exact: true })).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await unfold(page, 'bob-api');
});

test('a project lists its chats and worktrees, with no main row, and ⌘K offers no main conversation', async ({ page }) => {
  await shot(page, 'sidebar');
  // Nor the Overview, which lists every conversation.
  await sidebar(page).getByRole('button', { name: 'Overview' }).click();
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeVisible();
  await shot(page, 'overview');
  await expect(page.getByRole('listitem', { name: /^main,/ })).toHaveCount(0);
  await expect(page.getByRole('listitem', { name: /^add-auth,/ })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'main', exact: true })).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: 'add-auth', exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'How do deploys work?', exact: true })).toBeVisible();
  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog').filter({ has: page.getByRole('combobox') }).first();
  await expect(palette).toBeVisible();
  await page.keyboard.type('bob-api');
  await shot(page, 'palette');
  await expect(page.getByRole('option', { name: /bob-api › main/ })).toHaveCount(0);
  await expect(page.getByRole('option', { name: /bob-api › add-auth/ })).toBeVisible();
});

test('New Chat twice makes two separate chats on main', async ({ page }) => {
  const rows = () => sidebar(page).locator('[data-kind="chat"]');
  const before = await rows().count();
  await newChat(page, 'Where are the routes defined?');
  await newChat(page, 'What does the billing module do?');
  await expect(rows()).toHaveCount(before + 2);
  // Each is its own conversation: the second didn't land in the first.
  await sidebar(page).getByRole('button', { name: 'Where are the routes defined?', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('Where are the routes defined?');
  await expect(page.getByRole('main')).not.toContainText('What does the billing module do?');
  await shot(page, 'two-chats');
});

test('⌘N in a project starts a new chat there', async ({ page }) => {
  await projectRow(page, 'bob-api').click();
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeVisible();
  await page.keyboard.press('Meta+n');
  await composer(page).fill('Is there a health check route?');
  await composer(page).press('Enter');
  const row = sidebar(page).getByRole('button', { name: 'Is there a health check route?', exact: true });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute('data-kind', 'chat');
  // In the project tree (under bob-api), not with the stand-alone chats above it.
  await expect(sidebar(page).locator('[data-arrange-tree]').getByRole('button', { name: 'Is there a health check route?', exact: true })).toBeVisible();
});
