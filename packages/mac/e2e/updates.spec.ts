import { expect, test, type Page } from './fixtures.js';

/**
 * Beluga's own updates. The browser build has no app shell (the updater lives in
 * src-tauri/src/updater.rs), so the window's update store is seeded before the page loads and
 * what the buttons ask for is read back from window.__BELUGA_UPDATE_CALLS__ (lib/updates.ts).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const calls = (page: Page) => page.evaluate(() => window.__BELUGA_UPDATE_CALLS__ ?? []);

const READY = {
  current: '0.4.0',
  mode: 'ask',
  phase: 'ready',
  lastCheck: Date.now() - 5 * 60_000,
  available: { version: '0.5.0', date: '2026-10-18T10:00:00Z', notes: '## What’s new\n\n- **Update when idle**: Beluga updates itself while you’re away\n- Faster sidebar' },
  choice: 'quit',
  waitingOn: ['you'],
};

async function open(page: Page, seed?: object): Promise<void> {
  if (seed) await page.addInitScript((s) => void (window.__BELUGA_UPDATES__ = s as never), seed);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
}

test('nothing about updates shows while there is no update', async ({ page }) => {
  await open(page);
  await expect(page.locator('[data-update-pill]')).toHaveCount(0);
});

test('a downloaded update: a pill, then a sheet with the notes and three ways to install', async ({ page }) => {
  await open(page, READY);
  const pill = sidebar(page).getByRole('button', { name: 'Beluga 0.5 is ready' });
  await expect(pill).toBeVisible();
  await pill.click();

  const sheet = page.getByRole('dialog', { name: 'Beluga 0.5 is ready' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('You have 0.4.0');
  await expect(sheet.getByLabel('What’s new')).toContainText('Beluga updates itself while you’re away');
  await expect(sheet.getByRole('heading', { name: 'What’s new' })).toBeVisible();

  // Update When Idle: the sheet closes and the pill says so.
  await sheet.getByRole('button', { name: 'Update When Idle' }).click();
  await expect(sheet).toBeHidden();
  await expect(pill).toContainText('when idle');
  expect(await calls(page)).toEqual(['update_choose {"choice":"idle"}']);

  // Opened again it says what it waits for; Restart Now installs right away.
  await pill.click();
  await expect(sheet).toContainText('Waiting for you to step away for 10 minutes.');
  await sheet.getByRole('button', { name: 'Restart Now' }).click();
  await expect(sheet.getByRole('button', { name: 'Restarting…' })).toBeDisabled();
  expect(await calls(page)).toContain('update_choose {"choice":"now"}');
});

test('Later closes the sheet and leaves the update for when you quit', async ({ page }) => {
  await open(page, READY);
  await sidebar(page).getByRole('button', { name: 'Beluga 0.5 is ready' }).click();
  // The sheet offers the idle way for every update too.
  const always = page.getByRole('dialog').getByLabel('Update automatically from now on');
  await always.check();
  await always.uncheck();
  await page.getByRole('dialog').getByRole('button', { name: 'Later' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(await calls(page)).toEqual(['update_set_mode {"mode":"idle"}', 'update_set_mode {"mode":"ask"}', 'update_choose {"choice":"quit"}']);
  await expect(sidebar(page).locator('[data-update-pill="ready"]')).toBeVisible();
});

test('with the sidebar hidden the pill waits in the corner', async ({ page }) => {
  await open(page, READY);
  await page.keyboard.press('Control+Meta+KeyS');
  await expect(sidebar(page)).toBeHidden();
  await expect(page.locator('[data-update-pill="ready"]')).toBeVisible();
  await page.keyboard.press('Control+Meta+KeyS');
});

test('after an update installed: What’s new, once', async ({ page }) => {
  await open(page, { current: '0.5.0', mode: 'idle', phase: 'idle', waitingOn: [], news: { version: '0.5.0', notes: '- Faster sidebar' } });
  const pill = sidebar(page).getByRole('button', { name: 'Updated to 0.5 · What’s new' });
  await pill.click();
  const sheet = page.getByRole('dialog', { name: 'Beluga is now 0.5' });
  await expect(sheet).toContainText('Faster sidebar');
  await sheet.getByRole('button', { name: 'OK' }).click();
  await expect(pill).toBeHidden();
  expect(await calls(page)).toEqual(['update_dismiss_news']);
});

test('Settings › General: Update automatically, Check for updates, Check Now and when Beluga last looked', async ({ page }) => {
  await open(page, { ...READY, available: null, choice: null, phase: 'idle' });
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByText('Last checked: 5 minutes ago')).toBeVisible();
  const auto = settings.getByRole('switch', { name: 'Update automatically' });
  const check = settings.getByRole('switch', { name: 'Check for updates' });
  await expect(auto).toHaveAttribute('aria-checked', 'false');
  await expect(check).toHaveAttribute('aria-checked', 'true');
  await auto.click();
  await expect(auto).toHaveAttribute('aria-checked', 'true');
  await expect(settings.getByText(/installs once you step away/)).toBeVisible();
  // Not looking at all can't update automatically.
  await check.click();
  await expect(auto).toHaveAttribute('aria-checked', 'false');
  await expect(settings.getByText(/only looks when you click Check Now/)).toBeVisible();
  // Updating automatically looks again.
  await auto.click();
  await expect(check).toHaveAttribute('aria-checked', 'true');
  await settings.getByRole('button', { name: 'Check Now' }).first().click();
  await expect(settings.getByText(/Beluga is up to date\. · Last checked: Just now/).first()).toBeVisible();
  expect(await calls(page)).toEqual(['update_set_mode {"mode":"idle"}', 'update_set_mode {"mode":"off"}', 'update_set_mode {"mode":"idle"}', 'update_check']);
});
