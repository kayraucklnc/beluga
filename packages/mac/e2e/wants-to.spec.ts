import { expect, test, type Page } from './fixtures.js';

/**
 * The request pop-up (a friend’s Claude “wants to…”) against the demo with the network on: mention a screenshot to mia and her
 * Claude asks yours for one. The pop-up (popup.html, which hears the window over a
 * BroadcastChannel in a browser; a floating window of its own in the app) shows the few words,
 * See more shows everything, and Allow / Decline answer it. Runs after requests and rules (which expect nothing received yet) and turns the network off at the end.
 */

test.describe.configure({ mode: 'serial' });

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const cards = (popup: Page) => popup.getByTestId('request-popup-card');

async function open(page: Page): Promise<Page> {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const card = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  if (await card.isVisible().catch(() => false)) await card.getByRole('button', { name: 'Turn On' }).click();
  await expect(sidebar(page).getByRole('button', { name: /^mia, / })).toBeVisible({ timeout: 30_000 });
  const popup = await page.context().newPage();
  await popup.goto('/popup.html');
  return popup;
}

async function askMia(page: Page, text: string): Promise<void> {
  await page.bringToFront();
  await sidebar(page).getByRole('button', { name: /^mia, / }).click();
  const box = page.getByRole('textbox', { name: 'Message mia' });
  await box.fill(text);
  await box.press('Enter');
  await expect(box).toHaveValue('');
}

test('a friend’s request pops up with a few words; See more shows it all; Allow answers it', async ({ page }) => {
  const popup = await open(page);
  await askMia(page, 'can your Claude grab a screenshot from me?');
  const card = cards(popup).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('mia’s agent wants to');
  await expect(card).toContainText('take a screenshot of your desktop and send it to me');
  await expect(card).toContainText('See the screen');
  await expect(card.getByTestId('request-popup-detail')).toHaveCount(0);
  await card.getByRole('button', { name: 'See more' }).click();
  await expect(card.getByTestId('request-popup-detail')).toContainText('new dock and menu bar layout');
  await expect(card.getByTestId('request-popup-detail')).toContainText('Sends backFiles');
  await card.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(cards(popup)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('Approved').first()).toBeVisible();
});

test('Decline answers it too, and × only hides the card', async ({ page }) => {
  const popup = await open(page);
  await askMia(page, 'Claude, can you help me with something?');
  await expect(cards(popup)).toHaveCount(1, { timeout: 20_000 });
  await expect(cards(popup).first()).toContainText('tell me what auth returns for an expired session');
  await popup.getByRole('button', { name: 'Hide (they still wait in Beluga)' }).click({ force: true });
  await expect(cards(popup)).toHaveCount(0);
  // Still waiting in Beluga.
  await sidebar(page).getByRole('button', { name: /^Requests/ }).click();
  await page.getByRole('radio', { name: /^Received/ }).or(page.getByRole('tab', { name: /^Received/ })).first().click();
  const row = page.getByRole('list', { name: 'Received requests' }).getByRole('button', { name: /^From mia’s agent: .*Waiting for you to approve$/ }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  // A new page hears it again (closing only hid it there); Decline answers it.
  const again = await page.context().newPage();
  await again.goto('/popup.html');
  await expect(cards(again)).toHaveCount(1, { timeout: 10_000 });
  await cards(again).first().getByRole('button', { name: 'Decline' }).click();
  await expect(cards(again)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('Declined').first()).toBeVisible();
});

test('turning the network off again', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'People & access' }).click();
  const on = page.getByRole('switch', { name: 'Talk with friends directly' });
  if ((await on.getAttribute('aria-checked')) === 'true') await on.click();
  await expect(on).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
  await page.keyboard.press('Escape');
});
