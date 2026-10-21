import { expect, test, type Page } from '@playwright/test';

/**
 * A pasted image is referenced in the words where the cursor was ("[image 1]"), and the project
 * home's New Worktree box offers the same / and @ suggestions as a chat.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').last();

// A 2×2 red PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==';

test('a pasted image goes in the words where the cursor is', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  const box = composer(page);
  await box.fill('the bug is here and');
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(15, 15));
  await box.evaluate(async (el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);
  await expect(box).toHaveValue(/^the bug is here \[image \d+\] and$/);
  await expect(page.getByRole('group', { name: 'Images to send' }).locator('img')).toHaveCount(1);
  // Taking the image out takes its reference out of the words too.
  await page.getByRole('button', { name: /Remove image/ }).click({ force: true });
  await expect(box).toHaveValue('the bug is here and');
});

test('the New Worktree box suggests commands and the project’s files', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  const task = page.getByLabel('Task for the new worktree');
  await task.fill('/');
  const list = page.getByRole('listbox', { name: 'Suggestions' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option').first()).toBeVisible();
  await task.fill('look at @');
  await expect(list).toBeVisible();
  await task.press('Escape');
  await expect(list).toBeHidden();
});
