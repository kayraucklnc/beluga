import { expect, test, type Locator, type Page } from './fixtures.js';
import { openSharedWorkspace } from './helpers.js';

/**
 * Every file scrolls, wherever it's shown: the panel's Files preview, full size, the Files view
 * (your friends' shared folders), a shared workspace's Files, and diffs in the panel and full
 * size. Each place gets a long .ts, a long .json, a long .md and a tall image (the demo's bob-api).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const center = (page: Page) => page.getByRole('main');

/** Each kind of file, by where it is in bob-api, and something that shows it has opened. */
const FILES = [
  { folder: 'src', name: 'payments.ts', ready: (r: Locator) => r.locator('[data-n="100"]') },
  { folder: 'data', name: 'plans.json', ready: (r: Locator) => r.locator('[data-n="100"]') },
  { folder: 'docs', name: 'GUIDE.md', ready: (r: Locator) => r.getByRole('heading', { name: 'Troubleshooting' }) },
  { folder: 'design', name: 'landing.svg', ready: (r: Locator) => r.locator('img[alt$="landing.svg"]') },
] as const;

async function openWorkspace(page: Page, name = 'add-auth'): Promise<void> {
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

const scrollOf = (el: Locator) => el.evaluate((e) => ({ top: e.scrollTop, height: e.scrollHeight, view: e.clientHeight }));

/** Taller than its box, and both the wheel and the keyboard (Page Down) move it. */
async function expectScrolls(page: Page, el: Locator, what: string): Promise<void> {
  await expect.poll(async () => { const s = await scrollOf(el); return s.height - s.view; }, { message: `${what} is taller than its box` }).toBeGreaterThan(80);
  await el.evaluate((e) => e.scrollTo({ top: 0 }));
  await el.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(async () => (await scrollOf(el)).top, { message: `the wheel scrolls ${what}` }).toBeGreaterThan(50);
  await el.evaluate((e) => e.scrollTo({ top: 0 }));
  await el.focus();
  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await scrollOf(el)).top, { message: `Page Down scrolls ${what}` }).toBeGreaterThan(50);
}

/** Open a folder (if it isn't) and pick a file, in the panel's tree. */
async function pickInTree(page: Page, folder: string, name: string): Promise<void> {
  const dir = panel(page).getByRole('treeitem', { name: folder, exact: true });
  await expect(dir).toBeVisible();
  if ((await dir.getAttribute('aria-expanded')) !== 'true') await dir.click();
  await panel(page).getByRole('treeitem', { name, exact: true }).click();
}

/** Go into a folder and open a file in the Files view's list (from the share's top). */
async function pickInList(page: Page, folder: string, name: string): Promise<void> {
  const list = center(page).getByRole('listbox', { name: 'Files' });
  await list.getByRole('option', { name: folder, exact: true }).click();
  await list.getByRole('option', { name: new RegExp(`^${name.replace('.', '\\.')}`) }).click();
  await list.getByRole('option', { name: 'Back' }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('the panel’s Files preview scrolls every kind of file', async ({ page }) => {
  await openWorkspace(page);
  await panel(page).getByRole('tab', { name: 'Files', exact: true }).click();
  for (const f of FILES) {
    await pickInTree(page, f.folder, f.name);
    const region = panel(page).getByRole('region', { name: f.name });
    await expect(f.ready(region)).toBeAttached();
    await expectScrolls(page, region.locator('[data-reader-scroll]'), `${f.name} in the panel`);
  }
});

test('full size, every kind of file scrolls', async ({ page }) => {
  await openWorkspace(page);
  await panel(page).getByRole('tab', { name: 'Files', exact: true }).click();
  for (const f of FILES) {
    // Each opens from the panel (it steps aside while a file is full size, and is back after Esc).
    await pickInTree(page, f.folder, f.name);
    await panel(page).getByRole('region', { name: f.name }).getByRole('button', { name: 'Open in full' }).click();
    const region = center(page).getByRole('region', { name: f.name });
    await expect(f.ready(region)).toBeAttached();
    await expectScrolls(page, region.locator('[data-reader-scroll]'), `${f.name} full size`);
    await page.getByRole('button', { name: 'Back to Chat' }).click();
    await expect(panel(page).getByRole('region', { name: f.name })).toBeVisible();
  }
});

test('the Files view (a friend’s shared folder) scrolls every kind of file', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: /^Files/ }).click();
  await center(page).getByRole('option', { name: /^api \(read-only\)/ }).click();
  for (const f of FILES) {
    await pickInList(page, f.folder, f.name);
    const region = center(page).getByRole('region', { name: f.name });
    await expect(f.ready(region)).toBeAttached({ timeout: 15_000 });
    await expectScrolls(page, region.locator('[data-reader-scroll]'), `${f.name} in Files`);
  }
});

test('a shared workspace’s Files (read-only) scrolls every kind of file', async ({ page }) => {
  await openSharedWorkspace(page, 'bob-api', 'bob', /payments/);
  await center(page).getByRole('tab', { name: 'Files' }).click();
  await expect(center(page).getByRole('listbox', { name: 'Files' }).getByRole('option', { name: 'src', exact: true })).toBeVisible();
  for (const f of FILES) {
    await pickInList(page, f.folder, f.name);
    const region = center(page).getByRole('region', { name: f.name });
    await expect(f.ready(region)).toBeAttached({ timeout: 15_000 });
    await expectScrolls(page, region.locator('[data-reader-scroll]'), `${f.name} in a shared workspace`);
  }
});

test('a long diff scrolls in the panel and full size', async ({ page }) => {
  await openWorkspace(page);
  await panel(page).getByRole('tab', { name: 'Changes', exact: true }).click();
  await panel(page).getByRole('option', { name: /server\.ts/ }).click();
  const diff = panel(page).getByRole('region', { name: 'Changes in server.ts' });
  await expect(diff.locator('tr').nth(60)).toBeAttached();
  await expectScrolls(page, diff.locator('[tabindex="0"]'), 'the diff in the panel');
  await diff.getByRole('button', { name: 'Open in full' }).click();
  const full = center(page).getByLabel('The changes');
  await expect(full.locator('tr').nth(60)).toBeAttached();
  await expectScrolls(page, full, 'the diff full size');
  // Split view too.
  await center(page).getByRole('tab', { name: 'Split' }).click();
  await expectScrolls(page, full, 'the split diff full size');
  await center(page).getByRole('tab', { name: 'Unified' }).click();
  await page.keyboard.press('Escape');
  await expect(composer(page)).toBeVisible();
});
