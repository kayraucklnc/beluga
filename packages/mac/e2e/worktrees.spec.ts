import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

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
  // Screenshots only: let animations settle so the picture is still.
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

/**
 * A project with a worktree a Claude Code sub-agent left (in .claude/worktrees), added to Beluga.
 * Its own, since usage.spec's Clean Up… removes the demo's finished sub-agent worktrees.
 */
async function addAgentProject(page: Page): Promise<void> {
  const repo = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-e2e-agents-')), 'agents-app');
  const git = (...args: string[]): void => void execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd: repo, stdio: 'pipe' });
  mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'README.md'), '# agents\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('worktree', 'add', '-q', '-b', 'agent-e2e0wt', path.join(repo, '.claude', 'worktrees', 'agent-e2e0wt'));
  await sidebar(page).getByRole('button', { name: /Add a project/ }).first().click();
  await page.getByRole('menuitem', { name: 'Add Projects…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add projects' });
  await sheet.getByRole('textbox', { name: 'Folder path' }).fill(repo);
  await sheet.getByRole('button', { name: 'Add', exact: true }).last().click();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('lists every worktree with who made it and whether it’s done; filters narrow it', async ({ page }) => {
  addDependencies(await folderOf(page, 'webhook-retries'));
  await addAgentProject(page);
  await sidebar(page).getByRole('button', { name: 'Worktrees' }).click();
  await expect(page.getByRole('heading', { name: 'Worktrees' })).toBeVisible();
  await expect(row(page, 'add-auth')).toBeVisible();
  await expect(row(page, 'add-auth')).toContainText('Beluga');
  // Sub-agent worktrees: Claude's, with who started them (or that nothing says).
  await page.getByRole('tab', { name: /^Sub-agents/ }).click();
  await expect(grid(page).getByRole('row').filter({ hasText: 'Sub-agent' }).first()).toBeVisible();
  await expect(row(page, 'add-auth')).toHaveCount(0);
  await page.getByRole('tab', { name: /^All/ }).click();
  // What can be cleared comes in as each is looked at.
  await expect(row(page, 'webhook-retries').getByRole('cell').nth(5)).toContainText(/\d+(\.\d+)? (KB|MB)/, { timeout: 20_000 });
  await shot(page, 'worktrees-page');
});

test('Remove Build Files clears dependencies and keeps the worktree', async ({ page }) => {
  const dir = await folderOf(page, 'webhook-retries');
  await sidebar(page).getByRole('button', { name: 'Worktrees' }).click();
  await row(page, 'webhook-retries').getByRole('checkbox').check();
  const bar = page.getByRole('toolbar', { name: 'Selected worktrees' });
  await expect(bar).toContainText('1 selected');
  await bar.getByRole('button', { name: 'Remove Build Files…' }).click();
  const alert = page.getByRole('alertdialog', { name: /Remove build files from 1 worktree\?/ });
  await expect(alert).toContainText('Your work stays: files, commits, uncommitted changes, ignored files like .env');
  await alert.getByRole('button', { name: 'Remove Build Files' }).click();
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
  // It leaves the list at once; the folder goes in the background.
  await expect.poll(() => existsSync(dir), { timeout: 30_000 }).toBe(false);
  // Back from the Overview, as it was.
  await sidebar(page).getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('tab', { name: /^Archived, \d+$/ }).click();
  const archived = page.getByRole('listitem', { name: /^new-hero, archived/ });
  await archived.hover();
  await archived.getByRole('button', { name: 'Restore' }).click();
  await expect.poll(() => existsSync(path.join(dir, 'draft.md')), { timeout: 20_000 }).toBe(true);
  expect(readFileSync(path.join(dir, 'draft.md'), 'utf8')).toBe('not committed');
});
