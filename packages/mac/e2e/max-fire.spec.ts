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

test('while typing, it catches and goes out as quickly as you said, and that is kept', async ({ page }) => {
  await page.goto('/');
  await openFire(page);
  // Only while typing are there delays to set.
  await expect(page.getByRole('slider', { name: 'Catches' })).toHaveCount(0);
  await page.getByRole('radiogroup', { name: 'When it burns' }).getByRole('radio', { name: 'While Typing' }).click();
  await expect(page.getByRole('slider', { name: 'Catches' })).toHaveValue('0.6');
  await expect(page.getByRole('slider', { name: 'Goes out' })).toHaveValue('0.4');
  await page.getByRole('slider', { name: 'Catches' }).fill('0');
  await page.getByRole('slider', { name: 'Goes out' }).fill('2.5');
  await expect(page.getByText('2.5 s', { exact: true })).toBeVisible();
  // How much the preview burns (the fire sets it on the box, 0–1).
  const box = page.locator('[data-fire="typing"]');
  const burn = (): Promise<number> => box.evaluate((el) => Number((el as HTMLElement).style.getPropertyValue('--burn') || 0));
  await expect.poll(burn).toBeLessThan(0.05);
  // At once: a single key sets it off.
  await page.getByRole('textbox', { name: 'Try the fire' }).press('a');
  await expect.poll(burn).toBeGreaterThan(0.9);
  // It lingers well past the old 0.4 s, then goes out.
  await page.waitForTimeout(1500);
  expect(await burn()).toBeGreaterThan(0.9);
  await expect.poll(burn, { timeout: 5_000 }).toBeLessThan(0.05);
  await page.reload();
  await openFire(page);
  await expect(page.getByRole('slider', { name: 'Catches' })).toHaveValue('0');
  await expect(page.getByRole('slider', { name: 'Goes out' })).toHaveValue('2.5');
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
