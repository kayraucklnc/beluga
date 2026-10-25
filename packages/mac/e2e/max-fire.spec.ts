import { expect, test, type Page } from './fixtures.js';

/** Settings › Fire & Confetti: a preset sets the look, your own colours keep their name, and both stay after a reload. */

async function openFire(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Sidebar' }).waitFor();
  await page.locator('main').click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Fire & Confetti' }).click();
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

test('the effects can be on everywhere, or just pixels, not only on Max', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  const chat = sidebar.getByRole('button', { name: 'How do deploys work?' });
  if (!(await chat.isVisible())) await sidebar.getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await chat.click();
  // Not on Max: nothing by default.
  const canvases = page.locator('main canvas[aria-hidden]');
  await expect(canvases).toHaveCount(0);
  await openFire(page);
  await page.getByRole('radio', { name: /^Just Pixels/ }).click();
  await page.getByRole('radio', { name: 'Everywhere' }).click();
  await expect(page.getByRole('radiogroup', { name: 'As you type' }).getByRole('radio', { name: 'Pixels', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  // Everywhere: the box throws pixels now, without burning.
  await expect(canvases).toHaveCount(2);
  await expect(page.getByText('Max', { exact: true })).toHaveCount(0);
});
