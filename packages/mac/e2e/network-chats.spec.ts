import { expect, test, type Page } from '@playwright/test';

/**
 * Chats against the demo: the main channel and chat tabs, files shared Mac to Mac, and
 * Claudes that answer only when asked (bob's and mia's are simulated on their pretend Macs,
 * yours by the demo backend). Turns the network on first and off at the end, so the other
 * specs see the sidebar as before.
 */

test.describe.configure({ mode: 'serial' });

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const channel = (page: Page, name: string) => sidebar(page).getByRole('button', { name: new RegExp(`^Channel ${name}\\b`) });
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Chats' });
/** SHOTS=<folder>: save screenshots there (menus get a moment to finish fading in). */
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('the main channel is one click away and has all your friends', async ({ page }) => {
  const card = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  if (await card.isVisible()) await card.getByRole('button', { name: 'Turn On' }).click();
  await expect(channel(page, 'launch')).toBeVisible({ timeout: 30_000 });
  await channel(page, 'All Friends').click();
  const log = page.getByRole('log', { name: 'Channel All Friends' });
  await expect(log).toContainText('Your main channel', { timeout: 15_000 });
  await expect(log).toContainText(/bob, mia and you|mia, bob and you/);
  await expect(tabs(page).getByRole('tab', { name: 'All Friends' })).toHaveAttribute('aria-selected', 'true');
  // Your own main channel can't be closed.
  await expect(tabs(page).getByRole('button', { name: 'Close All Friends' })).toHaveCount(0);
});

test('a friend’s files come straight from their Mac; pictures show in the chat', async ({ page }) => {
  await channel(page, 'launch').click();
  await expect(tabs(page).getByRole('tab', { name: 'launch' })).toHaveAttribute('aria-selected', 'true');
  const log = page.getByRole('log', { name: 'Channel launch' });
  await expect(log).toContainText('Checklist for Friday', { timeout: 20_000 });
  const checklist = log.getByRole('group', { name: /^release-checklist\.md, MD · / });
  await expect(checklist).toBeVisible({ timeout: 20_000 });
  await expect(log.getByRole('button', { name: 'Open checkout.png' })).toBeVisible({ timeout: 20_000 });
  await shot(page, 'chat-files');
});

test('Claude answers only when asked: everyone’s Claude answers from their own Mac', async ({ page }) => {
  await channel(page, 'launch').click();
  const log = page.getByRole('log', { name: 'Channel launch' });
  const box = page.getByRole('textbox', { name: 'Message launch' });
  // A plain message: no Claude says anything.
  await box.fill('Coffee first?');
  await box.press('Enter');
  await expect(log).toContainText('Sounds good 👍', { timeout: 15_000 });
  await expect(log.locator('[data-claude="true"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Ask Claude' }).click();
  await expect(page.getByRole('menuitem', { name: /Ask bob’s Claude/ })).toBeVisible();
  await shot(page, 'chat-ask-menu');
  await page.getByRole('menuitem', { name: /Ask Everyone’s Claude/ }).click();
  await expect(page.getByText('Asking everyone’s Claude')).toBeVisible();
  await box.fill('Are we ready to ship on Friday?');
  await page.getByRole('button', { name: 'Send and asking everyone’s claude' }).click();
  await expect(log).toContainText('Asked everyone’s Claude');
  await expect(log.getByText('bob’s Claude', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(log.getByText('mia’s Claude', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(log.getByText('Your Claude', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(log.locator('[data-claude="true"]')).toHaveCount(3);

  // No words needed: your Claude reads the conversation and answers.
  await page.getByRole('button', { name: 'Ask Claude' }).click();
  await page.getByRole('menuitem', { name: /Ask Your Claude/ }).click();
  await page.getByRole('button', { name: 'Send and asking your claude' }).click();
  await expect(log.locator('[data-claude="true"]')).toHaveCount(4, { timeout: 20_000 });
  await shot(page, 'chat-claudes');
});

test('files you add wait in the box, then go with the message', async ({ page }) => {
  await channel(page, 'launch').click();
  await page.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Ship it on Friday.') });
  const tray = page.getByRole('list', { name: 'Files to send' });
  await expect(tray).toContainText('notes.txt');
  await expect(tray).toContainText(/bytes/);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(tray).toHaveCount(0);
  const log = page.getByRole('log', { name: 'Channel launch' });
  await expect(log.getByRole('group', { name: /^notes\.txt, TXT · / }).last()).toBeVisible({ timeout: 10_000 });
});

test('chats open as tabs; closing one keeps the conversation in the sidebar', async ({ page }) => {
  await channel(page, 'launch').click();
  await sidebar(page).getByRole('button', { name: /^bob, / }).click();
  await expect(tabs(page).getByRole('tab', { name: 'bob' })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs(page).getByRole('tab', { name: 'launch' })).toBeVisible();
  await tabs(page).getByRole('button', { name: 'Close bob' }).click();
  await expect(tabs(page).getByRole('tab', { name: 'bob' })).toHaveCount(0);
  await expect(tabs(page).getByRole('tab', { name: 'launch' })).toHaveAttribute('aria-selected', 'true');
  await expect(sidebar(page).getByRole('button', { name: /^bob, / })).toBeVisible();
  // + starts a new channel.
  await tabs(page).getByRole('button', { name: 'New chat' }).click();
  await page.getByRole('menuitem', { name: 'New Channel…' }).click();
  await expect(page.getByRole('dialog', { name: 'New Channel' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Settings has who may ask your Claude; turning the network off brings the Friends card back', async ({ page }) => {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'People & access' }).click();
  await expect(page.getByText('Who can ask your Claude in chats')).toBeVisible();
  const on = page.getByRole('switch', { name: 'Talk with friends directly' });
  await on.click();
  await expect(on).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(sidebar(page).getByRole('group', { name: 'Talk with friends' })).toBeVisible();
});
