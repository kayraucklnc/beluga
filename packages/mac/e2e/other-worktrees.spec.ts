import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/** Worktrees made outside Klaud: folded by what made them, an info page instead of an empty chat, and nothing removed without asking. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

/** A project with two worktrees a script made: one with a commit of its own, one with nothing new (stale). */
function makeRepo(): { repo: string; ext: string; stale: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), 'klaud-e2e-others-'));
  const repo = path.join(base, 'outside-app');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(path.join(repo, 'README.md'), '# hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const ext = path.join(base, 'review-154');
  git(repo, 'worktree', 'add', '-q', '-b', 'pr-154', ext);
  writeFileSync(path.join(ext, 'fix.txt'), 'fix\n');
  git(ext, 'add', '.');
  git(ext, 'commit', '-q', '-m', 'Fix the catalog');
  const stale = path.join(base, 'old-spike');
  git(repo, 'worktree', 'add', '-q', '-b', 'spike', stale);
  return { repo, ext, stale };
}

async function addProject(page: Page, repo: string): Promise<void> {
  await sidebar(page).getByRole('button', { name: /Add a project/ }).first().click();
  // The + may open a small menu first (Add Projects… / New Group).
  const item = page.getByRole('menuitem', { name: /Add Projects/ });
  await item.waitFor({ state: 'visible', timeout: 2000 }).then(() => item.click(), () => undefined);
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

test('a worktree made outside Klaud shows what it is, and removing it asks first', async ({ page }) => {
  const { repo, ext, stale } = makeRepo();
  await addProject(page, repo);
  const fold = sidebar(page).getByRole('button', { name: /^Other Worktrees: 2 worktrees/ });
  await expect(fold).toBeVisible();
  await expect(fold).toHaveAttribute('title', /made outside Klaud/);
  await fold.click();
  await sidebar(page).getByRole('button', { name: 'review-154', exact: true }).click();

  const info = page.getByTestId('worktree-info');
  await expect(info).toBeVisible();
  await expect(info.getByText('Made outside Klaud')).toBeVisible();
  await expect(info.getByText('pr-154', { exact: true })).toBeVisible();
  await expect(info.getByText('Fix the catalog')).toBeVisible();
  await expect(info.getByText(/1 commit ahead/)).toBeVisible();
  await expect(info.getByText(/No Claude Code conversation ran in this folder/)).toBeVisible();
  await expect(info.getByRole('button', { name: 'Start a Conversation Here' })).toBeVisible();

  // Remove asks first; Cancel keeps everything.
  await info.getByRole('button', { name: 'Remove Worktree…' }).click();
  const alert = page.getByRole('alertdialog', { name: 'Remove “review-154”?' });
  await expect(alert).toBeVisible();
  await expect(alert.getByText(/The branch/)).toContainText('pr-154');
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(alert).toBeHidden();
  expect(existsSync(ext)).toBe(true);

  // Confirmed: the folder goes, the branch stays.
  await info.getByRole('button', { name: 'Remove Worktree…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.poll(() => existsSync(ext)).toBe(false);
  expect(git(repo, 'branch', '--list', 'pr-154')).toContain('pr-154');
  await expect(sidebar(page).getByRole('button', { name: 'review-154', exact: true })).toBeHidden();

  // Clean Up… lists the stale one, ticked, and removes it only when asked.
  const rest = sidebar(page).getByRole('button', { name: /^Other Worktrees: 1 worktree/ });
  await rest.hover();
  await rest.getByRole('button', { name: 'Clean Up Other Worktrees…' }).click();
  const clean = page.getByRole('alertdialog', { name: /Clean up other worktrees/ });
  await expect(clean).toBeVisible();
  await expect(clean.getByRole('checkbox', { name: /old-spike/ })).toBeChecked();
  await expect(clean.getByText(/already in/)).toBeVisible();
  expect(existsSync(stale)).toBe(true);
  await clean.getByRole('button', { name: 'Remove 1' }).click();
  await expect.poll(() => existsSync(stale)).toBe(false);
  expect(git(repo, 'branch', '--list', 'spike')).toContain('spike');
});

test("starting a conversation in another tool's worktree shows the chat", async ({ page }) => {
  const { repo } = makeRepo();
  await addProject(page, repo);
  await sidebar(page).getByRole('button', { name: /^Other Worktrees: 2 worktrees/ }).click();
  await sidebar(page).getByRole('button', { name: 'old-spike', exact: true }).click();
  await page.getByTestId('worktree-info').getByRole('button', { name: 'Start a Conversation Here' }).click();
  await expect(page.getByTestId('worktree-info')).toBeHidden();
  await expect(page.getByText(/becomes one of yours once you send a message/)).toBeVisible();
  await page.getByRole('button', { name: 'About This Worktree' }).click();
  await expect(page.getByTestId('worktree-info')).toBeVisible();
});
