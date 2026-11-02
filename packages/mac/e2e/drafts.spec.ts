import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';
import { expectPicked, pick } from './helpers.js';

/**
 * Unsent words stay with their own chat (BLG-24): a new worktree page keeps its task, its branch,
 * its name and its pasted images while you're elsewhere, and no other chat's box ever shows them.
 * Every chat keeps its own the same way; sending (or creating the worktree) clears it.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').last();
const images = (page: Page) => page.getByRole('group', { name: 'Images to send' });

// A 2×2 red PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==';

/** A project with a second branch to start from. */
function twoBranches(): string {
  const repo = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-e2e-drafts-')), 'keep-drafts');
  const git = (...args: string[]): void => void execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(path.join(repo, 'README.md'), '# drafts\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('branch', 'feature/drafts');
  return repo;
}

async function addProject(page: Page, repo: string): Promise<void> {
  await sidebar(page).getByRole('button', { name: /Add a project/ }).first().click();
  const item = page.getByRole('menuitem', { name: /Add Projects/ });
  await item.waitFor({ state: 'visible', timeout: 2000 }).then(() => item.click(), () => undefined);
  const sheet = page.getByRole('dialog', { name: 'Add projects' });
  await sheet.getByRole('textbox', { name: 'Folder path' }).fill(repo);
  await sheet.getByRole('button', { name: 'Add', exact: true }).last().click();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
}

async function newWorktree(page: Page, project: string): Promise<void> {
  await sidebar(page).getByRole('button', { name: project }).first().hover();
  await sidebar(page).getByRole('button', { name: `New worktree in ${project}`, exact: true }).click();
  await expect(page.getByRole('group', { name: 'New worktree' })).toBeVisible();
}

async function openWorkspace(page: Page, name: string): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

const groupChat = async (page: Page): Promise<void> => {
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', /Message/);
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a new worktree page keeps its words, branch, name and images while you’re in other chats, which never show them', async ({ page }) => {
  await addProject(page, twoBranches());
  await newWorktree(page, 'keep-drafts');
  await pick(page, 'Based on', 'feature/drafts');
  await page.getByLabel('Worktree name').fill('kept-name');
  const box = composer(page);
  await box.fill('fix the header on the settings page');
  await box.evaluate(async (el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);
  await expect(box).toHaveValue(/^fix the header on the settings page \[(?:image \d+|\d+\u2007[^\]\n]+)\] $/);
  await expect(images(page).locator('img')).toHaveCount(1);

  // Another chat's box is empty: nothing to send there by mistake.
  await groupChat(page);
  await expect(composer(page)).toHaveValue('');
  await expect(images(page)).toBeHidden();
  await composer(page).fill('words for the room');
  await openWorkspace(page, 'webhook-retries');
  await expect(composer(page)).toHaveValue('');
  // Another project's new worktree page is its own too.
  await newWorktree(page, 'bob-api');
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByLabel('Worktree name')).toHaveValue('');

  // Back: all of it is there.
  await newWorktree(page, 'keep-drafts');
  await expect(composer(page)).toHaveValue(/^fix the header on the settings page \[(?:image \d+|\d+\u2007[^\]\n]+)\] $/);
  await expect(page.getByLabel('Worktree name')).toHaveValue('kept-name');
  await expectPicked(page.getByRole('combobox', { name: 'Based on' }), 'feature/drafts');
  await expect(images(page).locator('img')).toHaveCount(1);
  // And the room kept its own.
  await groupChat(page);
  await expect(composer(page)).toHaveValue('words for the room');
});

test('every chat keeps its own unsent words; sending or creating the worktree clears them', async ({ page }) => {
  await groupChat(page);
  await composer(page).fill('for the room, later');
  await openWorkspace(page, 'webhook-retries');
  await expect(composer(page)).toHaveValue('');
  await composer(page).fill('remember the word mango');
  await groupChat(page);
  await expect(composer(page)).toHaveValue('for the room, later');
  await openWorkspace(page, 'webhook-retries');
  await expect(composer(page)).toHaveValue('remember the word mango');
  // Sent: gone from the box, here and when you come back.
  await composer(page).press('Enter');
  await expect(page.getByText('remember the word mango').last()).toBeVisible();
  await expect(composer(page)).toHaveValue('');
  await groupChat(page);
  await openWorkspace(page, 'webhook-retries');
  await expect(composer(page)).toHaveValue('');

  // A new worktree made from its page: the page starts empty again.
  await newWorktree(page, 'bob-api');
  await page.getByLabel('Worktree name').fill('e2e-drafts');
  await composer(page).fill('say hello');
  await page.getByRole('button', { name: /Create Worktree/ }).click();
  await expect(sidebar(page).getByRole('button', { name: 'e2e-drafts', exact: true })).toBeVisible({ timeout: 20_000 });
  await newWorktree(page, 'bob-api');
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByLabel('Worktree name')).toHaveValue('');
});
