import { expect, test, type Page } from './fixtures.js';

/**
 * Tasks between Claudes (the gateway) against the demo with the network on: your Claude asks
 * bob's Claude (you trust bob: it goes straight out) and mia's (you don't yet: the card asks
 * you first), the answers come back into the conversation, and Requests lists them. The last
 * test turns the network off again, so the other specs see the sidebar as before.
 */

test.describe.configure({ mode: 'serial' });

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });

/** Projects start folded (what you unfold is remembered): show what's in one, if it's folded. */
async function unfold(page: Page, name: string): Promise<void> {
  const toggle = page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: new RegExp(`^(Show what's in|Fold) ${name}$`) }).first();
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-label'))!.startsWith('Show')) await toggle.click();
}
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
  await unfold(page, 'bob-api');
  await sidebar(page).getByRole('button', { name: /^webhook-retries/ }).first().click();
  await expect(composer(page)).toHaveAttribute('placeholder', /webhook-retries/);
  // A fresh demo's Claude may still be at work here: ask once it's free, so the ask isn't queued.
  await expect(page.getByRole('button', { name: 'Stop Claude' })).toHaveCount(0, { timeout: 90_000 });
  const bob = task(page, /^Task: To bob’s agent/).last();
  // Right after the network is turned on, bob can show Online before the link to him is up: then
  // your Claude says he can't be reached, and you ask again (KLD-57 found this).
  const unreachable = page.getByText("I couldn't ask bob: bob can't be reached");
  // Your Claude asks you before it sends anything to a friend's Claude: Ask bob sends this one.
  const askBob = task(page, /^Task: Ask bob’s Claude\?/).last();
  await expect(async () => {
    const before = await unreachable.count();
    await composer(page).fill('ask bob to run the tests in bob-api');
    await composer(page).press('Enter');
    await expect(bob.or(askBob).or(unreachable.nth(before))).toBeVisible({ timeout: 15_000 });
    if (await askBob.getByRole('button', { name: 'Ask bob' }).isVisible()) await askBob.getByRole('button', { name: 'Ask bob' }).click();
    await expect(bob).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 60_000, intervals: [1000] });
  await expect(bob).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  // Your Claude passes the answer on; the card keeps it one click away (not shown twice).
  await expect(page.getByText(/^bob's Claude says: All 27 tests/).last()).toBeVisible();
  await bob.getByRole('button', { name: 'Show bob’s reply' }).click();
  await expect(bob).toContainText('27 tests');
  await expect(bob.getByRole('table', { name: 'Data' })).toContainText('passed');

  await composer(page).fill('ask mia to review the landing page copy');
  await composer(page).press('Enter');
  const ask = task(page, /^Task: Ask mia’s agent\?/).last();
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await expect(ask).toContainText('Your agent wants to send this, so it asks you first');
  await ask.getByRole('button', { name: 'Ask mia' }).click();
  const mia = task(page, /^Task: To mia’s agent/).last();
  await expect(mia).toHaveAttribute('data-state', 'awaiting_approval', { timeout: 15_000 });
  await expect(mia).toContainText('Waiting for mia to approve');
  await expect(mia).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await mia.getByRole('button', { name: 'Show mia’s reply' }).click();
  await expect(mia).toContainText('landing copy is final');
});

test('Requests lists what you sent, and Not now never sends', async ({ page }) => {
  await unfold(page, 'bob-api');
  await sidebar(page).getByRole('button', { name: /^webhook-retries/ }).first().click();
  await expect(composer(page)).toHaveAttribute('placeholder', /webhook-retries/);
  await composer(page).fill('ask mia whether the hero image is final');
  await composer(page).press('Enter');
  const ask = task(page, /^Task: Ask mia’s agent\?/).last();
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await ask.getByRole('button', { name: 'Not now' }).click();
  await expect(task(page, /^Task: To mia’s agent/).last()).toHaveAttribute('data-state', 'cancelled');

  // The sidebar has Requests while one waits for you (and while you look at them).
  await sidebar(page).getByRole('button', { name: /^Requests/ }).click();
  await expect(page.locator('header').first()).toContainText('Requests');
  await page.getByRole('tab', { name: /^Sent/ }).click();
  const sent = page.getByRole('list', { name: 'Sent requests' });
  await expect(sent.getByRole('button', { name: /^To bob’s agent: run the tests in bob-api, Done/ })).toBeVisible();
  await expect(sent.getByRole('button', { name: /^To mia’s agent: whether the hero image is final, Cancelled/ })).toBeVisible();
  await sent.getByRole('button', { name: /^To bob’s agent/ }).click();
  const card = page.getByRole('region', { name: /^Task: To bob’s agent/ });
  await card.getByRole('button', { name: 'Show bob’s reply' }).click();
  await expect(card).toContainText('27 tests');
  await page.getByRole('tab', { name: /^Received/ }).click();
  await expect(page.getByRole('list', { name: 'Received requests' })).toBeVisible();
});

test('turning the network off again', async ({ page }) => {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'People & access' }).click();
  const on = page.getByRole('switch', { name: 'Talk with friends directly' });
  if ((await on.getAttribute('aria-checked')) === 'true') await on.click();
  await expect(on).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
  await page.keyboard.press('Escape');
});
