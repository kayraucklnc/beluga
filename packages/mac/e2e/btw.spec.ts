import { expect, test, type Page } from './fixtures.js';

/**
 * /btw: a side question while Claude works. "/btw " turns the box into one (a peach "By the way"
 * banner); ↩ asks; the answer streams into a card above the box and never joins the chat. esc or
 * ✕ closes it. The demo's Claude answers a moment later, word by word (src/agent/mock.ts).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const card = (page: Page) => page.getByRole('region', { name: 'Side question' });
const shot = (name: string): string => `../../.beluga/scratch/${name}`;

async function open(page: Page, name: string, project = 'bob-api'): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: project }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a side question is answered above the box, and never joins the chat', async ({ page }) => {
  await open(page, 'add-auth');
  const before = await page.locator('[data-chat-log] [data-agent], [data-item]').count();
  await composer(page).fill('/btw ');
  // The command became the mode: the box is empty again, with its banner.
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByRole('status').filter({ hasText: 'By the way' })).toBeVisible();
  await expect(composer(page)).toHaveAttribute('placeholder', /on the side/);
  await composer(page).pressSequentially('does this touch the phone app?');
  await page.screenshot({ path: shot('btw-01-asking.png') });
  await composer(page).press('Enter');
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText('does this touch the phone app?');
  await expect(page.getByRole('status').filter({ hasText: 'By the way' })).toBeHidden();
  await page.screenshot({ path: shot('btw-02-thinking.png') });
  await expect(card(page)).toContainText('Short answer: yes');
  await expect(card(page).getByRole('button', { name: 'Copy the answer' })).toBeVisible();
  await page.screenshot({ path: shot('btw-03-answered.png') });
  // Nothing new in the conversation itself.
  expect(await page.locator('[data-chat-log] [data-agent], [data-item]').count()).toBe(before);
  await composer(page).press('Escape');
  await expect(card(page)).toBeHidden();
});

test('backspace in an empty side question goes back to a message', async ({ page }) => {
  await open(page, 'add-auth');
  await composer(page).fill('/btw ');
  await expect(page.getByRole('status').filter({ hasText: 'By the way' })).toBeVisible();
  await composer(page).press('Backspace');
  await expect(page.getByRole('status').filter({ hasText: 'By the way' })).toBeHidden();
});
