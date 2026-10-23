import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from './fixtures.js';
import { expectPicked, pick, popupMenu } from './helpers.js';

/** Klaud's own pop-up buttons (components/Select.tsx) instead of the native <select>: the mouse, the keyboard and the search field. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const activeRow = (page: Page): Locator => popupMenu(page).locator('[role="option"][data-active]');

async function openAppearance(page: Page): Promise<Locator> {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Appearance' }).click();
  return page.getByRole('combobox', { name: 'Appearance' });
}

/** A project with more branches than fit a short menu (so its Based on pop-up gets a search field). */
function manyBranches(): string {
  const repo = path.join(mkdtempSync(path.join(os.tmpdir(), 'klaud-e2e-select-')), 'pick-branches');
  const git = (...args: string[]): void => void execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(path.join(repo, 'README.md'), '# branches\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  for (const b of ['feature/payments-retry', 'feature/payments-ui', 'fix/login', 'fix/logout', 'docs/readme', 'chore/deps', 'spike/search', 'release/1.0', 'release/1.1', 'hotfix/webhooks', 'refactor/store', 'test/e2e']) git('branch', b);
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

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a pop-up opens over itself with a checkmark on the choice; the keyboard moves, picks and closes', async ({ page }) => {
  const appearance = await openAppearance(page);
  await pick(page, 'Appearance', 'Light');
  await expectPicked(appearance, 'light');
  await expect(appearance).toHaveText('Light');

  // Return opens it: the chosen row has the checkmark and sits right over the button (a Mac pop-up).
  await appearance.focus();
  await page.keyboard.press('Enter');
  await expect(appearance).toHaveAttribute('aria-expanded', 'true');
  const chosen = popupMenu(page).getByRole('option', { selected: true });
  await expect(chosen).toHaveText('Light');
  await expect(chosen.locator('[data-check]')).toBeVisible();
  await expect(popupMenu(page).locator('[data-check]')).toHaveCount(1);
  const [button, row] = [(await appearance.boundingBox())!, (await chosen.boundingBox())!];
  expect(Math.abs(button.y + button.height / 2 - (row.y + row.height / 2))).toBeLessThan(4);

  // ↓ moves the highlight, Return picks it and gives the button the focus back.
  await expect(activeRow(page)).toHaveText('Light');
  await page.keyboard.press('ArrowDown');
  await expect(activeRow(page)).toHaveText('Dark');
  await page.keyboard.press('ArrowDown'); // the last one: it stays
  await expect(activeRow(page)).toHaveText('Dark');
  await page.keyboard.press('Enter');
  await expect(popupMenu(page)).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(appearance).toBeFocused();

  // Esc closes without changing anything.
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(popupMenu(page)).toHaveCount(0);
  await expectPicked(appearance, 'dark');
  await expect(appearance).toBeFocused();

  // Type-ahead: in the open menu it highlights; on the closed button it picks, like the native one.
  await page.keyboard.press('ArrowDown');
  await expect(popupMenu(page)).toBeVisible();
  await page.keyboard.type('m');
  await expect(activeRow(page)).toHaveText('Match the system');
  await page.keyboard.press('Escape');
  await page.keyboard.type('l');
  await expectPicked(appearance, 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('press on a pop-up, drag to an option and let go: it is picked', async ({ page }) => {
  await openAppearance(page);
  const density = page.getByRole('combobox', { name: 'Density' });
  await pick(page, 'Density', 'Comfortable');
  const box = (await density.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const compact = popupMenu(page).getByRole('option', { name: 'Compact' });
  const target = (await compact.boundingBox())!;
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(popupMenu(page)).toHaveCount(0);
  await expectPicked(density, 'compact');
  // A plain click opens it and leaves it open; a click on an option picks.
  await density.click();
  await expect(popupMenu(page)).toBeVisible();
  await popupMenu(page).getByRole('option', { name: 'Comfortable' }).click();
  await expectPicked(density, 'comfortable');
});

test('a long list (branches) has a search field: type to filter, ↓ and Return pick, Esc clears then closes', async ({ page }) => {
  await addProject(page, manyBranches());
  await sidebar(page).getByRole('button', { name: 'pick-branches' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in pick-branches', exact: true }).click();
  const base = page.getByRole('combobox', { name: 'Based on' });
  await expectPicked(base, 'main');

  await base.click();
  const field = page.getByRole('textbox', { name: 'Filter the list' });
  await expect(field).toBeFocused();
  await expect(popupMenu(page).getByRole('option')).toHaveCount(13);
  await expect(popupMenu(page).getByRole('option', { name: 'main' })).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.type('pay');
  await expect(popupMenu(page).getByRole('option')).toHaveText(['feature/payments-retry', 'feature/payments-ui']);
  await expect(activeRow(page)).toHaveText('feature/payments-retry');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(popupMenu(page)).toHaveCount(0);
  await expectPicked(base, 'feature/payments-ui');
  await expect(base).toHaveText('feature/payments-ui');

  // Opened again: a fresh search, the checkmark on the new choice; nothing matching says so.
  await base.click();
  await expect(field).toHaveValue('');
  await expect(popupMenu(page).getByRole('option', { selected: true })).toHaveText('feature/payments-ui');
  await page.keyboard.type('zzz');
  await expect(popupMenu(page).getByText('No matches')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(field).toHaveValue('');
  await expect(popupMenu(page).getByRole('option')).toHaveCount(13);
  await page.keyboard.press('Escape');
  await expect(popupMenu(page)).toHaveCount(0);
  await expectPicked(base, 'feature/payments-ui');
});
