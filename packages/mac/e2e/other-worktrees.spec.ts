import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/** Worktrees made outside Klaud: plain rows after Klaud's own (name, then where), an info page instead of an empty chat, and nothing removed without asking. */

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

/** A project with `n` worktrees a script made, one after another (the last made is the most recent). */
function makeBusyRepo(n: number): { repo: string; trees: string[] } {
  const base = mkdtempSync(path.join(os.tmpdir(), 'klaud-e2e-many-'));
  const repo = path.join(base, 'many-app');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(path.join(repo, 'README.md'), '# hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const trees = Array.from({ length: n }, (_, i) => {
    const dir = path.join(base, `wt-${i}`);
    git(repo, 'worktree', 'add', '-q', '-b', `wt-${i}`, dir);
    return dir;
  });
  return { repo, trees };
}

test('a worktree made outside Klaud is a plain row with where it is; its page says what it is, and removing it asks first', async ({ page }) => {
  const { repo, ext, stale } = makeRepo();
  await addProject(page, repo);
  // No folds by what made them: just the worktrees, by name.
  const row = sidebar(page).getByRole('button', { name: 'review-154', exact: true });
  await expect(row).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'old-spike', exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: /^(Other Worktrees|Conductor|Claude Code)\b/ })).toHaveCount(0);
  // Where it is: quietly after the name, the whole path in the tooltip.
  await expect(row).toHaveAttribute('title', /klaud-e2e-others-[^/]+\/review-154$/);
  await expect(row).toContainText(/klaud-e2e-others-|…\//);
  await row.click();

  const info = page.getByTestId('worktree-info');
  await expect(info).toBeVisible();
  await expect(info.getByText('Made outside Klaud')).toBeVisible();
  await expect(info.getByText('pr-154', { exact: true })).toBeVisible();
  await expect(info.getByText('Fix the catalog')).toBeVisible();
  await expect(info.getByText(/1 commit ahead/)).toBeVisible();
  await expect(info.getByText(/No Claude Code conversation ran in this folder/)).toBeVisible();
  await expect(info.getByRole('button', { name: 'Start a Conversation Here' })).toBeVisible();
  await expect(info).not.toContainText(/Conductor/);

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

  // Clean Up Worktrees… is the project's: it lists the stale one, ticked, without saying what made it, and removes it only when asked.
  await sidebar(page).getByRole('button', { name: 'outside-app', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Clean Up Worktrees…' }).click();
  const clean = page.getByRole('alertdialog', { name: 'Clean up worktrees in outside-app?' });
  await expect(clean).toBeVisible();
  await expect(clean.getByRole('checkbox', { name: /old-spike/ })).toBeChecked();
  await expect(clean.getByText(/already in/)).toBeVisible();
  await expect(clean).not.toContainText(/Conductor|Other Worktrees/);
  expect(existsSync(stale)).toBe(true);
  await clean.getByRole('button', { name: 'Remove 1' }).click();
  await expect.poll(() => existsSync(stale)).toBe(false);
  expect(git(repo, 'branch', '--list', 'spike')).toContain('spike');
  // Nothing made outside Klaud is left: the project's menu stops offering it.
  await sidebar(page).getByRole('button', { name: 'outside-app', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /Show in Finder|Hide Project/ }).first()).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Clean Up Worktrees…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('many worktrees made outside Klaud: the five most recent, then "Show N more" opens the rest in place', async ({ page }) => {
  const { repo, trees } = makeBusyRepo(8);
  // The first one made gets a commit last: now it's the most recently active.
  writeFileSync(path.join(trees[0]!, 'late.txt'), 'x\n');
  git(trees[0]!, 'add', '.');
  git(trees[0]!, 'commit', '-q', '-m', 'Late work');
  await addProject(page, repo);
  const row = (name: string) => sidebar(page).getByRole('button', { name, exact: true });
  await expect(row('wt-0')).toBeVisible();
  for (const name of ['wt-7', 'wt-6', 'wt-5', 'wt-4']) await expect(row(name)).toBeVisible();
  for (const name of ['wt-1', 'wt-2', 'wt-3']) await expect(row(name)).toBeHidden();
  const more = sidebar(page).getByRole('button', { name: 'Show 3 more' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  for (let i = 0; i < 8; i++) await expect(row(`wt-${i}`)).toBeVisible();
  // Expanded, it stays in place as Show Fewer.
  await sidebar(page).getByRole('button', { name: 'Show Fewer' }).click();
  await expect(row('wt-1')).toBeHidden();
  // The project home offers the same clean-up.
  await sidebar(page).getByRole('button', { name: 'many-app', exact: true }).click();
  await page.getByRole('region', { name: 'Worktrees' }).getByRole('button', { name: 'Clean Up Worktrees…' }).click();
  const clean = page.getByRole('alertdialog', { name: /Clean up worktrees in many-app|Nothing to clean up/ });
  await expect(clean).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(clean).toBeHidden();
});

test("starting a conversation in another tool's worktree shows the chat", async ({ page }) => {
  const { repo } = makeRepo();
  await addProject(page, repo);
  await sidebar(page).getByRole('button', { name: 'old-spike', exact: true }).click();
  await page.getByTestId('worktree-info').getByRole('button', { name: 'Start a Conversation Here' }).click();
  await expect(page.getByTestId('worktree-info')).toBeHidden();
  await expect(page.getByText(/becomes one of yours once you send a message/)).toBeVisible();
  await page.getByRole('button', { name: 'About This Worktree' }).click();
  await expect(page.getByTestId('worktree-info')).toBeVisible();
});
