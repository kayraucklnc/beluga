import { expect, test, type Page } from '@playwright/test';

/**
 * Tasks between Claudes (the gateway) against the demo with the network on: your Claude asks
 * bob's Claude (you trust bob: it goes straight out) and mia's (you don't yet: the card asks
 * you first), the answers come back into the conversation, and Requests lists them. The last
 * test turns the network off again, so the other specs see the sidebar as before.
 */

test.describe.configure({ mode: 'serial' });

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const task = (page: Page, title: RegExp) => page.getByRole('region', { name: title });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('your Claude asks bob’s Claude and mia’s (after you say yes); answers come back here', async ({ page }) => {
  const card = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  if (await card.isVisible().catch(() => false)) await card.getByRole('button', { name: 'Turn On' }).click();
  await expect(sidebar(page).getByRole('button', { name: /^bob, Online/ })).toBeVisible({ timeout: 30_000 });
  await sidebar(page).getByRole('button', { name: /^webhook-retries/ }).first().click();
  await expect(composer(page)).toHaveAttribute('placeholder', /webhook-retries/);
  await composer(page).fill('ask bob to run the tests in bob-api');
  await composer(page).press('Enter');
  const bob = task(page, /^Task: To bob’s Claude/).last();
  await expect(bob).toBeVisible({ timeout: 15_000 });
  await expect(bob).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  // Your Claude passes the answer on; the card keeps it one click away (not shown twice).
  await expect(page.getByText(/^bob's Claude says: All 27 tests/).last()).toBeVisible();
  await bob.getByRole('button', { name: 'Show bob’s reply' }).click();
  await expect(bob).toContainText('27 tests');
  await expect(bob.getByRole('table', { name: 'Data' })).toContainText('passed');

  await composer(page).fill('ask mia to review the landing page copy');
  await composer(page).press('Enter');
  const ask = task(page, /^Task: Ask mia’s Claude\?/).last();
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await expect(ask).toContainText('You haven’t marked mia as trusted');
  await ask.getByRole('button', { name: 'Ask mia' }).click();
  const mia = task(page, /^Task: To mia’s Claude/).last();
  await expect(mia).toHaveAttribute('data-state', 'awaiting_approval', { timeout: 15_000 });
  await expect(mia).toContainText('Waiting for mia to approve');
  await expect(mia).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await mia.getByRole('button', { name: 'Show mia’s reply' }).click();
  await expect(mia).toContainText('landing copy is final');
});

test('Requests lists what you sent, and Not now never sends', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: /^webhook-retries/ }).first().click();
  await expect(composer(page)).toHaveAttribute('placeholder', /webhook-retries/);
  await composer(page).fill('ask mia whether the hero image is final');
  await composer(page).press('Enter');
  const ask = task(page, /^Task: Ask mia’s Claude\?/).last();
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await ask.getByRole('button', { name: 'Not now' }).click();
  await expect(task(page, /^Task: To mia’s Claude/).last()).toHaveAttribute('data-state', 'cancelled');

  await sidebar(page).getByRole('button', { name: /^Requests/ }).click();
  await expect(page.locator('header').first()).toContainText('Requests');
  const sent = page.getByRole('list', { name: 'Sent requests' });
  await expect(sent.getByRole('button', { name: /^To bob’s Claude: run the tests in bob-api, Done/ })).toBeVisible();
  await expect(sent.getByRole('button', { name: /^To mia’s Claude: whether the hero image is final, Cancelled/ })).toBeVisible();
  await sent.getByRole('button', { name: /^To bob’s Claude/ }).click();
  const card = page.getByRole('region', { name: /^Task: To bob’s Claude/ });
  await card.getByRole('button', { name: 'Show bob’s reply' }).click();
  await expect(card).toContainText('27 tests');
  await page.getByRole('tab', { name: /^Received/ }).click();
  await expect(page.getByRole('list', { name: 'Received requests' })).toContainText('Nothing received yet');
});

test('turning the network off again', async ({ page }) => {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'People & access' }).click();
  const on = page.getByRole('switch', { name: 'Talk with friends directly' });
  if ((await on.getAttribute('aria-checked')) === 'true') await on.click();
  await expect(on).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
  await page.keyboard.press('Escape');
});
