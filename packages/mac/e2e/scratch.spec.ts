import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * The panel's Scratch tab: what Claude saves to the workspace's .beluga/scratch/ while it works, live and
 * newest first. Following, the preview shows each new file as it's written (JSON laid out, pictures
 * as pictures, redrawn when they change); picking one stays on it.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const tab = (page: Page, name: string) => panel(page).getByRole('tablist', { name: 'Panel' }).getByRole('tab', { name, exact: true });

// 2×2 PNGs, red and blue.
const RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==', 'base64');
const BLUE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNkYPjPwMDAxMAAAA0GAQOqgnhHAAAAAElFTkSuQmCC', 'base64');

test('Scratch: .beluga/scratch/ live, newest first, followed by the preview', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /webhook-retries/);

  await page.keyboard.press('Meta+Alt+6');
  await expect(tab(page, 'Scratch')).toHaveAttribute('aria-selected', 'true');
  const finder = panel(page).getByRole('button', { name: 'Show in Finder' });
  await expect(finder).toBeVisible();
  const dir = (await finder.getAttribute('title'))!;
  expect(dir).toMatch(/\/\.beluga\/scratch$/);

  // Claude writes a JSON response: it shows up, laid out.
  writeFileSync(path.join(dir, 'api-response.json'), '{"ok":true,"items":[1,2]}');
  const files = panel(page).getByRole('listbox', { name: 'Scratch files' });
  await expect(files.getByRole('option', { name: /api-response\.json/ })).toBeVisible();
  const json = panel(page).getByRole('region', { name: 'api-response.json' });
  await expect(json).toContainText('"items": [');

  // Then a screenshot, in a folder: it's on top and the preview follows it.
  mkdirSync(path.join(dir, 'shots'), { recursive: true });
  writeFileSync(path.join(dir, 'shots', 'home.png'), RED);
  await expect(files.getByRole('option').first()).toContainText('home.png');
  const shot = panel(page).getByRole('region', { name: 'home.png' }).locator('img');
  await expect(shot).toBeVisible();
  const before = await shot.getAttribute('src');
  // Written again: the picture is read again.
  writeFileSync(path.join(dir, 'shots', 'home.png'), BLUE);
  await expect.poll(() => shot.getAttribute('src')).not.toBe(before);

  // Picking the older one stays on it while new files arrive.
  await files.getByRole('option', { name: /api-response\.json/ }).click();
  writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nStill on it.');
  await expect(files.getByRole('option').first()).toContainText('notes.md');
  await expect(panel(page).getByRole('region', { name: 'api-response.json' })).toBeVisible();
  // Back to following: the newest again.
  await panel(page).getByRole('tab', { name: 'Latest' }).click();
  await expect(panel(page).getByRole('region', { name: 'notes.md' }).getByRole('heading', { name: 'Notes' })).toBeVisible();
});

const SHOTS = path.resolve(import.meta.dirname, '../../../.context/shots');

test('Scratch: drawn in outline before anything lands, moving while Claude works; .context/ files show too', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await page.keyboard.press('Meta+Alt+6');
  await expect(tab(page, 'Scratch')).toHaveAttribute('aria-selected', 'true');

  // Nothing yet, Claude idle: the outline, still, and both folders named.
  await expect(panel(page).getByText('Nothing saved yet')).toBeVisible();
  await expect(panel(page)).toContainText('.beluga/scratch/');
  await expect(panel(page)).toContainText('.context/');
  await panel(page).screenshot({ path: path.join(SHOTS, 'scratch-idle.png') });

  // Claude starts: the outline moves and says so.
  await composer(page).fill('Take a screenshot of the login page');
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('status').filter({ hasText: 'Claude is working' })).toBeVisible();
  await panel(page).screenshot({ path: path.join(SHOTS, 'scratch-working.png') });

  // A file lands in .context/ (another tool's folder Claude was told to use): it shows, tagged.
  const dir = (await panel(page).getByRole('button', { name: 'Show in Finder' }).getAttribute('title'))!;
  const root = path.dirname(path.dirname(dir));
  mkdirSync(path.join(root, '.context'), { recursive: true });
  writeFileSync(path.join(root, '.context', 'login.png'), RED);
  const files = panel(page).getByRole('listbox', { name: 'Scratch files' });
  const shot = files.getByRole('option', { name: /login\.png/ });
  await expect(shot).toBeVisible();
  await expect(shot).toContainText('.context');
  await page.waitForTimeout(400); // the screenshot's: its thumbnail fades in
  await panel(page).screenshot({ path: path.join(SHOTS, 'scratch-context-file.png') });

  // Claude works again: a row on top of the list says so, where the next file will land.
  await composer(page).fill('And the signup page');
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('status').filter({ hasText: 'Claude is working' })).toBeVisible();
  await panel(page).screenshot({ path: path.join(SHOTS, 'scratch-list-working.png') });
});
