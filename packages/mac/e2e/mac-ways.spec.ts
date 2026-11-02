import { expect, test, type Page } from './fixtures.js';
import { expectPicked } from './helpers.js';

/** The Mac ways in: Stop, the toolbar's main action, right-click menus, the new worktree form, Find. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const toolbar = (page: Page) => page.locator('main header').first();

async function openWorkspace(page: Page, name: string): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('■ Stop stops Claude here, and what was queued comes back to the box', async ({ page }) => {
  await openWorkspace(page, 'webhook-retries');
  await composer(page).fill('Take a deep dive into the codebase');
  await composer(page).press('Enter');
  await expect(page.getByText('Take a deep dive into the codebase').last()).toBeVisible();
  const stop = page.getByRole('button', { name: 'Stop Claude' });
  await expect(stop).toBeVisible();
  await composer(page).fill('and then summarise it');
  await composer(page).press('Enter');
  await expect(page.getByRole('region', { name: 'Queued messages' })).toBeVisible();
  await stop.click();
  await expect(page.getByText('Stopped by you').last()).toBeVisible();
  await expect(stop).toBeHidden();
  await expect(composer(page)).toHaveValue('and then summarise it');
  await expect(page.getByRole('region', { name: 'Queued messages' })).toBeHidden();

  // ⌘. does the same from the keyboard.
  await composer(page).fill('Take a deep dive into the codebase');
  await composer(page).press('Enter');
  await expect(stop).toBeVisible();
  await page.keyboard.press('Meta+.');
  await expect(stop).toBeHidden();
  await expect(page.getByText('Stopped by you')).toHaveCount(2);
});

test('the toolbar puts what the workspace needs next up front, the rest one click away with its keys', async ({ page }) => {
  await openWorkspace(page, 'add-auth');
  // The main step of the split button (its "Other steps for this branch" half comes after it).
  const primary = toolbar(page).locator('button[class*="primary"]').first();
  await expect(primary).toHaveText(/Merge|Commit|Create PR|PR #|Fix Checks|Solve Conflict|Run/);
  // Calm: the one thing to do next, Run, and ⋯ (no row of git icons, no terminal or ⌘K buttons).
  const tools = toolbar(page).getByRole('group', { name: 'Workspace actions' }).getByRole('button');
  expect(await tools.count()).toBeLessThanOrEqual(2);
  await expect(toolbar(page).getByRole('button', { name: /^(Show|Hide) the terminal|^Everything you can do/ })).toHaveCount(0);
  await toolbar(page).getByRole('button', { name: 'More for this workspace' }).click();
  await expect(page.getByRole('menuitem', { name: /Ask Your Agent to Review…/ })).toBeVisible();
  const archive = page.getByRole('menuitem', { name: /Archive…/ });
  await expect(archive).toContainText('⌃⌘A');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  // The workspace's right-click menu says the same things.
  await sidebar(page).getByRole('button', { name: 'add-auth', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /Show in Finder/ })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('files: a tree in the panel, a preview, and a right-click menu that mentions a file in the chat', async ({ page }) => {
  await openWorkspace(page, 'add-auth');
  const panel = page.getByRole('complementary', { name: 'Panel' });
  await panel.getByRole('tab', { name: 'Files' }).click();
  const file = panel.getByRole('treeitem', { name: 'auth.ts' });
  // A file opened earlier (the preview is kept) already shows its folder open.
  if (!(await file.isVisible())) await panel.getByRole('treeitem', { name: 'src' }).click();
  await expect(file).toBeVisible();
  await file.click();
  await expect(panel.getByRole('region', { name: 'auth.ts' }).getByText('requireUser').first()).toBeVisible();
  await file.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Copy Path' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Show in Finder' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Open in Full' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Save a Copy…' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Mention in Chat' }).click();
  await expect(composer(page)).toHaveValue(/src\/auth\.ts/);
  await composer(page).fill('');
});

test('a new worktree: pick the branch, name it, Create Worktree; then one click starts Claude', async ({ page }) => {
  const project = sidebar(page).getByRole('button', { name: 'bob-api' }).first();
  await project.hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  await expect(toolbar(page)).toContainText('New Worktree');
  await expect(toolbar(page)).toContainText('bob-api');
  const base = page.getByRole('combobox', { name: 'Based on' });
  await expectPicked(base, /origin\/main|main/);
  await page.getByLabel('Worktree name').fill('e2e-polish');
  await page.getByRole('button', { name: /Create Worktree/ }).click();
  await expect(sidebar(page).getByRole('button', { name: 'e2e-polish', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(toolbar(page)).toContainText('e2e-polish');
  // An empty conversation offers a first task.
  await page.getByRole('button', { name: 'Explain This Project' }).click();
  await expect(page.getByText(/Explain how this project is organized/)).toBeVisible();
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 20_000 });
});

test('⌘F finds in this conversation; Return goes to the next match; Escape closes', async ({ page }) => {
  await openWorkspace(page, 'webhook-retries');
  await composer(page).fill('remember the word pineapple');
  await composer(page).press('Enter');
  await expect(page.getByText('remember the word pineapple').last()).toBeVisible();
  await page.keyboard.press('Meta+f');
  const find = page.getByRole('search', { name: 'Find in this conversation' });
  await expect(find).toBeVisible();
  await page.keyboard.type('pineapple');
  await expect(find).toContainText(/1 of \d+/);
  await page.keyboard.press('Escape');
  await expect(find).toBeHidden();
});
