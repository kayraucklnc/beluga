import { expect, test } from './fixtures.js';

/** The first-run welcome (src/onboarding): it shows once, its settings apply, and it stays gone. */

test.use({ storageState: { cookies: [], origins: [] } });

test('a fresh install walks through the welcome, picks a look, and never sees it again', async ({ page }) => {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Klaud' });
  await expect(welcome).toBeVisible();
  await welcome.getByRole('button', { name: /Get Started/ }).click();
  await expect(welcome.getByRole('heading', { name: 'Work on everything at once.' })).toBeVisible();

  // Skip Tour goes straight to the look.
  await welcome.getByRole('button', { name: 'Skip Tour' }).click();
  await welcome.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // The settings apply as they're changed.
  await welcome.getByRole('radio', { name: '⌘ Return' }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('klaud.prefs.v1') ?? '{}').sendWith)).toBe('cmd-enter');
  await welcome.getByRole('button', { name: 'Finish', exact: true }).click();

  await welcome.getByRole('button', { name: /Open Klaud|Look Around First/ }).click();
  await expect(welcome).toHaveCount(0);
  const mark = await page.evaluate(() => JSON.parse(localStorage.getItem('klaud.onboarding.v1') ?? '{}').how);
  expect(mark).toBe('finished');

  await page.reload();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(welcome).toHaveCount(0);
});

test('Skip Setup leaves at once, and the palette brings the welcome back', async ({ page }) => {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Klaud' });
  await welcome.getByRole('button', { name: 'Skip Setup' }).click();
  await expect(welcome).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('klaud.onboarding.v1') ?? '{}').how)).toBe('skipped');

  await page.keyboard.press('Meta+k');
  await page.keyboard.type('Onboard Again');
  await page.keyboard.press('Enter');
  await expect(welcome).toBeVisible();
});
