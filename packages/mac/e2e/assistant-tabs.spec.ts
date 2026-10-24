import { expect, test } from './fixtures.js';

/**
 * Your Mac's chats as tabs (BLG-102): + starts a new chat, the tabs switch between them, and ×
 * deletes one for good after asking.
 */
test('Your Mac holds several chats as tabs, and deletes one for good', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await sidebar.getByText('Your Mac', { exact: true }).click();
  const strip = page.getByRole('tablist', { name: 'Your Mac’s chats' });
  await expect(strip).toBeVisible();
  const tabs = strip.getByRole('tab');
  await expect(tabs).toHaveCount(1);

  // Something in the first chat, so it's named by it.
  const box = page.locator('textarea:not(.xterm-helper-textarea)');
  await box.fill('What is using my CPU?');
  await box.press('Enter');
  await expect(tabs.first()).toContainText('What is using my CPU?');

  // A second chat: a new tab, open and empty.
  await page.getByRole('button', { name: 'New chat with Your Mac' }).click();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Ask your Mac', { exact: true })).toBeVisible();
  await box.fill('Take a screenshot');
  await box.press('Enter');
  await expect(tabs.nth(1)).toContainText('Take a screenshot');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/01-tabs.png` });

  // Back to the first: its conversation is still there.
  await tabs.first().click();
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('What is using my CPU?').last()).toBeVisible();

  // Delete the second, after saying yes.
  await tabs.nth(1).hover();
  await strip.getByRole('button', { name: 'Delete this chat' }).nth(1).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Delete “Take a screenshot”?');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/02-delete-confirm.png` });
  await ask.getByRole('button', { name: 'Delete Chat' }).click();
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toContainText('What is using my CPU?');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/03-after-delete.png` });
});
