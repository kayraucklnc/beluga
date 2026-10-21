import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Arranging the sidebar's projects Finder-style: drag to reorder (it stays after a reload), drop
 * into a group at a place, reorder groups, fold projects and groups, hide and show.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });

/** Projects start folded (what you unfold is remembered): show what's in one, if it's folded. */
async function unfold(page: Page, name: string): Promise<void> {
  const toggle = page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: new RegExp(`^(Show what's in|Fold) ${name}$`) }).first();
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-label'))!.startsWith('Show')) await toggle.click();
}
/** A project's own row (not its worktrees'). */
const project = (page: Page, name: string) => sidebar(page).locator('[data-drag^="project:"]').filter({ has: page.getByText(name, { exact: true }) }).first();
const inGroup = (group: Locator, name: string) => group.locator('[data-drag^="project:"]').filter({ has: group.page().getByText(name, { exact: true }) });
const top = async (l: Locator): Promise<number> => (await l.boundingBox())!.y;

/** Pick a row up and let go at (x, y), moving in steps like a hand would. */
async function dragTo(page: Page, row: Locator, x: number, y: number): Promise<void> {
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 64, box.y + box.height / 2 + 8, { steps: 3 });
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
}

/** Just above a row (its block's upper half): "before it". */
async function above(row: Locator): Promise<[number, number]> {
  const b = (await row.boundingBox())!;
  return [b.x + 70, b.y + 3];
}

async function addRepo(page: Page, name: string): Promise<void> {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'klaud-e2e-arrange-')), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  await sidebar(page).getByRole('button', { name: /Add a project/ }).first().click();
  await page.getByRole('menuitem', { name: 'Add Projects…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add projects' });
  await sheet.getByRole('textbox', { name: 'Folder path' }).fill(dir);
  await sheet.getByRole('button', { name: 'Add', exact: true }).last().click();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(project(page, name)).toBeVisible();
}

async function newGroup(page: Page, name: string): Promise<Locator> {
  await sidebar(page).getByRole('button', { name: /Add a project/ }).first().click();
  await page.getByRole('menuitem', { name: 'New Group' }).click();
  const field = sidebar(page).getByRole('textbox', { name: 'Name of the new group' });
  await field.fill(name);
  await field.press('Enter');
  const head = sidebar(page).getByRole('button', { name: `Group ${name}` });
  await expect(head).toBeVisible();
  // The menu has finished closing (a drag started on it as it fades goes nowhere).
  await expect(page.getByRole('menu')).toHaveCount(0);
  return head;
}

// Tall enough that the whole sidebar shows (the other specs add projects, shares and people).
test.use({ viewport: { width: 1440, height: 1600 } });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a project folds; folded, it keeps only the item you are in, until you go elsewhere', async ({ page }) => {
  const row = project(page, 'bob-api');
  await unfold(page, 'bob-api');
  const addAuth = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  const webhook = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(addAuth).toBeVisible();
  // The main checkout isn't a place to work: it isn't listed.
  await expect(sidebar(page).getByRole('button', { name: 'main', exact: true })).toHaveCount(0);
  // In add-auth, fold the project: only add-auth stays.
  await addAuth.click();
  await row.getByRole('button', { name: 'Fold bob-api' }).click();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(addAuth).toBeVisible();
  await expect(webhook).toHaveCount(0);
  // Somewhere else: the folded project shows nothing under it.
  await sidebar(page).getByRole('button', { name: /^Overview/ }).click();
  await expect(addAuth).toHaveCount(0);
  // → unfolds it again (the row has the keyboard focus).
  await row.focus();
  await page.keyboard.press('ArrowRight');
  await expect(addAuth).toBeVisible();
  await expect(webhook).toBeVisible();
});

test('dragging a project reorders it, and the order stays after a reload', async ({ page }) => {
  await addRepo(page, 'arr-one');
  await addRepo(page, 'arr-two');
  // arr-two above arr-one.
  await dragTo(page, project(page, 'arr-two'), ...(await above(project(page, 'arr-one'))));
  await expect.poll(async () => (await top(project(page, 'arr-two'))) < (await top(project(page, 'arr-one')))).toBe(true);
  await page.reload();
  await expect(project(page, 'arr-two')).toBeVisible();
  expect(await top(project(page, 'arr-two'))).toBeLessThan(await top(project(page, 'arr-one')));
  // And with the keyboard: ⌃⌘↓ moves it back down past arr-one.
  await project(page, 'arr-two').focus();
  await page.keyboard.press('Control+Meta+ArrowDown');
  await expect.poll(async () => (await top(project(page, 'arr-one'))) < (await top(project(page, 'arr-two')))).toBe(true);
});

test('a project dropped between a group’s projects lands there; a folded group shows a count', async ({ page }) => {
  const head = await newGroup(page, 'Arr Work');
  const group = sidebar(page).getByRole('group', { name: 'Arr Work' });
  await expect(head).toContainText('Empty');
  // Onto the folder: in.
  const hb = (await head.boundingBox())!;
  await dragTo(page, project(page, 'arr-one'), hb.x + 80, hb.y + hb.height * 0.7);
  await expect(inGroup(group, 'arr-one')).toBeVisible();
  // Between: arr-two goes in before arr-one.
  await dragTo(page, project(page, 'arr-two'), ...(await above(inGroup(group, 'arr-one'))));
  await expect(inGroup(group, 'arr-two')).toBeVisible();
  expect(await top(inGroup(group, 'arr-two'))).toBeLessThan(await top(inGroup(group, 'arr-one')));
  // Fold it: its projects hide, the count says how many.
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(inGroup(group, 'arr-one')).toHaveCount(0);
  await expect(head).toContainText('2');
  await head.click();
  await expect(inGroup(group, 'arr-one')).toBeVisible();
});

test('groups reorder among the top level', async ({ page }) => {
  const first = sidebar(page).getByRole('button', { name: 'Group Arr Work' });
  const second = await newGroup(page, 'Arr Later');
  expect(await top(second)).toBeGreaterThan(await top(first));
  await dragTo(page, second, ...(await above(first)));
  await expect.poll(async () => (await top(second)) < (await top(first))).toBe(true);
  await page.reload();
  await expect(second).toBeVisible();
  expect(await top(second)).toBeLessThan(await top(first));
  // Esc while dragging puts it back.
  const b = (await first.boundingBox())!;
  await page.mouse.move(b.x + 60, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 60, (await second.boundingBox())!.y + 2, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await top(second)).toBeLessThan(await top(first));
  // An empty group goes with Delete Group; one with projects ungroups, they stay where it was.
  await second.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete Group' }).click();
  await expect(second).toBeHidden();
  await first.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Ungroup/ }).click();
  await expect(first).toBeHidden();
  await expect(project(page, 'arr-one')).toBeVisible();
});

test('hidden projects wait under Hidden Projects, with Show', async ({ page }) => {
  await project(page, 'arr-one').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide Project' }).click();
  await expect(project(page, 'arr-one')).toHaveCount(0);
  const fold = sidebar(page).getByRole('button', { name: /Hidden Projects/ });
  await fold.click();
  await sidebar(page).getByRole('button', { name: 'Show arr-one', exact: true }).click();
  await expect(project(page, 'arr-one')).toBeVisible();
  await expect(fold).toHaveCount(0);
});
