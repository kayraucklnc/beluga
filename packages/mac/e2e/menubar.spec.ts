import { expect, test } from './fixtures.js';

/** Settings › Menu Bar (BLG-280): what the menu-bar number counts, how it reads, and the whale's spout. */

test.use({ video: process.env.MENUBAR_VIDEO ? { mode: 'on', size: { width: 1440, height: 900 } } : 'off' });

test('picks what the menu-bar number counts and when the whale spouts', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Menu Bar', exact: true }).click();
  // It says what the number means.
  await expect(settings.getByText(/The number is what’s new for you/)).toBeVisible();
  await page.waitForTimeout(2500);
  // A preset sets it all: people in the room, in words.
  await settings.getByRole('radio', { name: /Who’s Here/ }).click();
  await expect(settings.getByText(/The number is people in the room/)).toBeVisible();
  await expect(settings.getByRole('radio', { name: /here$/ })).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(2500);
  // Tuning the spout makes it your own.
  await settings.getByRole('radio', { name: 'While Claude Works' }).click();
  await settings.getByRole('slider', { name: 'Splash' }).fill('1');
  await expect(settings.getByRole('radio', { name: /Your Own/ })).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(3000);
  await settings.getByRole('radio', { name: 'Never' }).click();
  await expect(settings.getByRole('slider', { name: 'Splash' })).toBeHidden();
  // Kept on this Mac.
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  await page.getByRole('dialog').getByRole('button', { name: 'Menu Bar', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('radio', { name: 'Never' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('dialog').getByRole('button', { name: 'Back to the Default' }).click();
  await expect(page.getByRole('dialog').getByRole('radio', { name: /What’s New/ })).toHaveAttribute('aria-checked', 'true');
});
