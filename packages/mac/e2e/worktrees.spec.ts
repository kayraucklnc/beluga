import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The Worktrees page: every worktree in your projects, who made it, whether its work is done,
 * what it takes and how much of that can be cleared; tick some, then free up their space (they
 * stay) or archive them (everything of yours kept).
 */

test.describe.configure({ mode: 'serial' });

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const grid = (page: Page) => page.getByRole('grid', { name: 'Worktrees' });
const row = (page: Page, name: string) => grid(page).getByRole('row', { name, exact: true });
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SHOTS) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

/** A demo worktree's folder (the demo keeps its records beside its projects). */
async function folderOf(page: Page, name: string): Promise<string> {
  const title = await sidebar(page).locator('[title$="/bob-api"], [title$="/landing"]').first().getAttribute('title');
  const home = path.join(path.dirname(path.dirname(title!)), 'home');
  const records = JSON.parse(readFileSync(path.join(home, 'workspaces.json'), 'utf8')) as { workspaces: Array<{ name: string; path: string }> };
  return records.workspaces.find((w) => w.name === name)!.path;
}

/** Dependencies in a worktree (git ignores them; they're made again by npm install). */
function addDependencies(dir: string): void {
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'x'.repeat(300_000));
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('lists every worktree with who made it and whether it’s done; filters narrow it', async ({ page }) => {
  addDependencies(await folderOf(page, 'webhook-retries'));
  await sidebar(page).getByRole('button', { name: 'Worktrees' }).click();
  await expect(page.getByRole('heading', { name: 'Worktrees' })).toBeVisible();
  await expect(row(page, 'add-auth')).toBeVisible();
  await expect(row(page, 'add-auth')).toContainText('Klaud');
  // The demo's sub-agent worktrees: Claude's, with who started them (or that nothing says).
  await page.getByRole('tab', { name: /^Sub-agents/ }).click();
  await expect(grid(page).getByRole('row').filter({ hasText: 'Sub-agent' }).first()).toBeVisible();
  await expect(row(page, 'add-auth')).toHaveCount(0);
  await page.getByRole('tab', { name: /^All/ }).click();
  // What can be cleared comes in as each is looked at.
  await expect(row(page, 'webhook-retries').getByRole('cell').nth(5)).toContainText(/\d+(\.\d+)? (KB|MB)/, { timeout: 20_000 });
  await shot(page, 'worktrees-page');
});

test('Free Up Space clears dependencies and keeps the worktree', async ({ page }) => {
  const dir = await folderOf(page, 'webhook-retries');
  await sidebar(page).getByRole('button', { name: 'Worktrees' }).click();
  await row(page, 'webhook-retries').getByRole('checkbox').check();
  const bar = page.getByRole('toolbar', { name: 'Selected worktrees' });
  await expect(bar).toContainText('1 selected');
  await bar.getByRole('button', { name: 'Free Up Space…' }).click();
  const alert = page.getByRole('alertdialog', { name: /Free up space in 1 worktree\?/ });
  await expect(alert).toContainText('Your files, changes and ignored files like .env stay');
  await alert.getByRole('button', { name: 'Free Up Space' }).click();
  await expect.poll(() => existsSync(path.join(dir, 'node_modules')), { timeout: 15_000 }).toBe(false);
  expect(existsSync(path.join(dir, 'package.json'))).toBe(true);
  await expect(row(page, 'webhook-retries')).toBeVisible();
});

test('archiving several at once keeps everything of theirs, and they leave the list', async ({ page }) => {
  const dir = await folderOf(page, 'new-hero');
  writeFileSync(path.join(dir, 'draft.md'), 'not committed');
  await sidebar(page).getByRole('button', { name: 'Worktrees' }).click();
  await row(page, 'new-hero').getByRole('checkbox').check();
  await row(page, 'add-auth').getByRole('checkbox').check();
  await shot(page, 'worktrees-selected');
  await page.getByRole('toolbar', { name: 'Selected worktrees' }).getByRole('button', { name: 'Archive…' }).click();
  const alert = page.getByRole('alertdialog', { name: /Archive 2 worktrees\?/ });
  await expect(alert).toContainText('Everything of yours in them is kept');
  await alert.getByRole('button', { name: 'Archive 2 Worktrees' }).click();
  await expect(row(page, 'new-hero')).toHaveCount(0, { timeout: 30_000 });
  await expect(row(page, 'add-auth')).toHaveCount(0, { timeout: 30_000 });
  expect(existsSync(dir)).toBe(false);
  // Back from the Overview, as it was.
  await sidebar(page).getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('tab', { name: /^Archived, \d+$/ }).click();
  const archived = page.getByRole('listitem', { name: /^new-hero, archived/ });
  await archived.hover();
  await archived.getByRole('button', { name: 'Restore' }).click();
  await expect.poll(() => existsSync(path.join(dir, 'draft.md')), { timeout: 20_000 }).toBe(true);
  expect(readFileSync(path.join(dir, 'draft.md'), 'utf8')).toBe('not committed');
});
