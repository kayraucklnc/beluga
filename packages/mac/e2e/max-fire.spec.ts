import { expect, test, type Page } from './fixtures.js';

/** Settings › Max Fire: a preset sets the look, your own colours keep their name, and both stay after a reload. */

async function openFire(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Sidebar' }).waitFor();
  await page.locator('main').click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Max Fire' }).click();
}

test('a preset sets the fire, your own colours are named, and both are kept', async ({ page }) => {
  await page.goto('/');
  await openFire(page);
  await expect(page.getByRole('radio', { name: /^Hades/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: /^Bonfire/ }).click();
  await expect(page.getByRole('radio', { name: /^Bonfire/ })).toHaveAttribute('aria-checked', 'true');
  // A slider moved: it's your own now.
  await page.getByRole('slider', { name: 'Height' }).fill('0.2');
  await expect(page.getByRole('radio', { name: /^Your Own/ })).toBeVisible();
  await page.getByRole('button', { name: 'New Colors' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Dragon’s Breath');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('radio', { name: /Dragon’s Breath/ })).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await openFire(page);
  await expect(page.getByRole('radio', { name: /Dragon’s Breath/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('slider', { name: 'Height' })).toHaveValue('0.2');
});
