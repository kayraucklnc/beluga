import { expect, test } from './fixtures.js';

/** The first-run welcome (src/onboarding): it shows once, its settings apply, and it stays gone. */

test.use({ storageState: { cookies: [], origins: [] } });

test('a fresh install walks through the welcome, picks a look, and never sees it again', async ({ page }) => {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Beluga' });
  await expect(welcome).toBeVisible();
  // The beluga opens the welcome, and comes back on the last step.
  await expect(welcome.getByRole('img', { name: 'Beluga' })).toBeVisible();
  await welcome.getByRole('button', { name: /Get Started/ }).click();
  await expect(welcome.getByRole('heading', { name: 'Work on everything at once.' })).toBeVisible();

  // Skip Tour goes straight to the look.
  await welcome.getByRole('button', { name: 'Skip Tour' }).click();
  await welcome.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // The fire: it starts on Arcade, a box to try it in, and None is right there.
  const fire = (): Promise<{ preset: string; show: string; typing: string }> => page.evaluate(() => JSON.parse(localStorage.getItem('beluga.prefs.v1') ?? '{}').maxFire);
  await expect(welcome.getByRole('heading', { name: 'Set your words on fire.' })).toBeVisible();
  await expect(welcome.getByRole('radio', { name: 'Arcade' })).toHaveAttribute('aria-checked', 'true');
  await welcome.getByRole('textbox', { name: 'Try the fire' }).fill('Hello');
  await welcome.getByRole('radio', { name: 'Ghost' }).click();
  await expect.poll(async () => (await fire()).preset).toBe('ghost');
  await welcome.getByRole('radio', { name: 'None' }).click();
  await expect.poll(async () => (await fire()).show).toBe('off');
  await expect(welcome.getByRole('radio', { name: 'Everywhere' })).toHaveCount(0);
  await welcome.getByRole('radio', { name: 'Arcade' }).click();
  await expect.poll(async () => (await fire()).typing).toBe('pixels');
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // The settings apply as they're changed.
  await welcome.getByRole('radio', { name: '⌘ Return' }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('beluga.prefs.v1') ?? '{}').sendWith)).toBe('cmd-enter');
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // The permissions (BLG-101): one a step, each optional; the button opens its pane.
  await expect(welcome.getByRole('heading', { name: 'Let Claude see your screen.' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Allow in System Settings' }).click();
  await expect.poll(() => page.evaluate(() => window.__BELUGA_PRIVACY_CALLS__ ?? [])).toEqual(['screen']);
  await welcome.getByRole('button', { name: 'Not Now', exact: true }).click();
  await expect(welcome.getByRole('heading', { name: 'Let Claude use your other apps.' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Skip Permissions' }).click();

  // On-screen popups (BLG-9): a sample shows on the pop-up, and notifications are asked for.
  await expect(welcome.getByRole('heading', { name: 'Never miss it when Claude needs you.' })).toBeVisible();
  await expect(welcome.getByRole('switch', { name: 'Show on-screen popups when something needs me' })).toHaveAttribute('aria-checked', 'true');
  const popup = await page.context().newPage();
  await popup.goto('/popup.html');
  await page.bringToFront();
  await welcome.getByRole('button', { name: 'Show Me a Sample' }).click();
  await expect(popup.getByTestId('request-popup-card')).toHaveCount(2, { timeout: 10_000 });
  await popup.close();
  await welcome.getByRole('button', { name: 'Allow Notifications' }).click();
  await expect(welcome.getByRole('button', { name: 'Asked' })).toBeDisabled();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // The phone app: Android for now, and the real Pair a Phone….
  await expect(welcome.getByRole('heading', { name: 'Claude in your pocket.' })).toBeVisible();
  await expect(welcome.getByText('Android only for now')).toBeVisible();
  await expect(welcome.getByRole('button', { name: /Pair a Phone/ })).toBeVisible();
  await welcome.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(welcome.getByRole('img', { name: 'Beluga' })).toBeVisible();

  await welcome.getByRole('button', { name: /Open Beluga|Look Around First/ }).click();
  await expect(welcome).toHaveCount(0);
  const mark = await page.evaluate(() => JSON.parse(localStorage.getItem('beluga.onboarding.v1') ?? '{}').how);
  expect(mark).toBe('finished');

  await page.reload();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(welcome).toHaveCount(0);
});

test('Skip Setup leaves at once, and the palette brings the welcome back', async ({ page }) => {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Beluga' });
  await welcome.getByRole('button', { name: 'Skip Setup' }).click();
  await expect(welcome).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('beluga.onboarding.v1') ?? '{}').how)).toBe('skipped');

  await page.keyboard.press('Meta+k');
  await page.keyboard.type('Onboard Again');
  await page.keyboard.press('Enter');
  await expect(welcome).toBeVisible();
});

test('a permission macOS already allows shows as allowed, and the tour shows a real table', async ({ page }) => {
  await page.addInitScript(() => (window.__BELUGA_PRIVACY__ = { screen: 'granted' }));
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Beluga' });
  await welcome.getByRole('button', { name: /Get Started/ }).click();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  // The table weave: Claude picks Postgres, connects, and the answer is a table that sorts.
  await expect(welcome.getByRole('heading', { name: 'Answers you can sort, not just read.' })).toBeVisible();
  const table = welcome.getByRole('table');
  await expect(table).toBeVisible({ timeout: 10_000 });
  await table.getByRole('button', { name: 'MRR' }).click();
  await expect(table.locator('tbody tr').first()).toContainText('Globex');

  await welcome.getByRole('button', { name: 'Skip Tour' }).click();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(welcome.getByRole('heading', { name: 'Set your words on fire.' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(welcome.getByText('Allowed', { exact: true })).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
});
