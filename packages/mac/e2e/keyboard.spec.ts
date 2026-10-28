import { expect, test, type Page } from './fixtures.js';

/**
 * Settings › Keyboard (BLG-289): every shortcut yours to change. Recording a key by pressing it,
 * the window following at once, a clash offering Swap / Use Here, what macOS keeps refused,
 * finding a shortcut by its keys, and Reset All with Undo.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shots = process.env.BELUGA_SHOTS;
const dialog = (page: Page) => page.getByRole('dialog');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('⌘/ opens Settings › Keyboard, and a new key works at once', async ({ page }) => {
  await page.keyboard.press('Meta+Slash');
  await expect(page.getByRole('heading', { name: 'Keyboard' })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Run: ⌘R. Change' })).toBeVisible();
  if (shots) await dialog(page).screenshot({ path: `${shots}/01-keyboard-settings.png` });

  // Toggle Sidebar: ⌃⌘S → ⌥⌘B, by pressing it.
  await dialog(page).getByRole('button', { name: 'Toggle Sidebar: ⌃⌘S. Change' }).click();
  await expect(dialog(page).getByText('Press keys', { exact: true })).toBeVisible();
  if (shots) await dialog(page).screenshot({ path: `${shots}/02-keyboard-recording.png` });
  await page.keyboard.press('Alt+Meta+KeyB');
  await expect(dialog(page).getByRole('button', { name: 'Toggle Sidebar: ⌥⌘B. Change' })).toBeVisible();
  await expect(dialog(page).getByText('1 changed')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  // The old key does nothing now; the new one hides the sidebar.
  await page.keyboard.press('Control+Meta+KeyS');
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Alt+Meta+KeyB');
  await expect(sidebar(page)).toBeHidden();
  await page.keyboard.press('Alt+Meta+KeyB');
  await expect(sidebar(page)).toBeVisible();
});

test('a key something else has asks: Swap, Use Here or Cancel', async ({ page }) => {
  await page.keyboard.press('Meta+Slash');
  const d = dialog(page);
  await d.getByRole('button', { name: 'Run: ⌘R. Change' }).click();
  await page.keyboard.press('Shift+Meta+KeyP');
  const clash = d.getByRole('alert');
  await expect(clash).toContainText('⇧⌘P is Pull Request… Swap them, or take it?');
  if (shots) await d.screenshot({ path: `${shots}/03-keyboard-clash.png` });
  await clash.getByRole('button', { name: 'Swap' }).click();
  await expect(d.getByRole('button', { name: 'Run: ⇧⌘P. Change' })).toBeVisible();
  await expect(d.getByRole('button', { name: 'Pull Request…: ⌘R. Change' })).toBeVisible();

  // Use Here (↩) takes it, leaving the other without a key.
  await d.getByRole('button', { name: 'Commit…: ⇧⌘C. Change' }).click();
  await page.keyboard.press('Meta+KeyR');
  await expect(d.getByRole('alert')).toContainText('⌘R is Pull Request…');
  await page.keyboard.press('Enter');
  await expect(d.getByRole('button', { name: 'Commit…: ⌘R. Change' })).toBeVisible();
  await expect(d.getByRole('button', { name: 'Add a shortcut for Pull Request…' })).toBeVisible();

  // What macOS keeps is refused, and recording goes on.
  await d.getByRole('button', { name: 'Merge…: ⇧⌘M. Change' }).click();
  await page.keyboard.press('Meta+KeyQ');
  await expect(d.getByText('⌘Q is Quit Beluga: macOS keeps it')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(d.getByRole('button', { name: 'Merge…: ⇧⌘M. Change' })).toBeVisible();
  // esc stopped recording, not Settings.
  await expect(page.getByRole('heading', { name: 'Keyboard' })).toBeVisible();

  // Reset All puts everything back, with Undo.
  await d.getByRole('button', { name: 'Reset All' }).click();
  await expect(d.getByRole('button', { name: 'Run: ⌘R. Change' })).toBeVisible();
  await expect(page.getByText('Every shortcut is back to how it came')).toBeVisible();
});

test('find a shortcut by name or by pressing its keys', async ({ page }) => {
  await page.keyboard.press('Meta+Slash');
  const d = dialog(page);
  await d.getByRole('textbox', { name: 'Search shortcuts' }).fill('panel');
  await expect(d.getByText('Toggle Panel')).toBeVisible();
  await expect(d.getByText('Commit…')).toBeHidden();

  await d.getByRole('button', { name: 'Find by pressing the keys' }).click();
  await page.keyboard.press('Shift+Meta+KeyC');
  await expect(d.getByText('Commit…')).toBeVisible();
  await expect(d.getByText('Toggle Panel')).toBeHidden();
  if (shots) await d.screenshot({ path: `${shots}/04-keyboard-find-by-keys.png` });

  await d.getByRole('button', { name: 'Find by pressing the keys' }).click();
  await page.keyboard.press('Meta+KeyT');
  await expect(d.getByText(/Nothing uses.*it’s free/)).toBeVisible();
});
