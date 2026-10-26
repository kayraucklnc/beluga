import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

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
  // Screenshots only: let animations settle so the picture is still.
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
  await expect(log).toContainText('Sounds good, see you there.', { timeout: 15_000 });
  await expect(log.locator('[data-claude="true"]')).toHaveCount(0);

  // With others here: Ask: your Claude is yours; the chevron picks everyone's or one person's.
  await page.getByRole('button', { name: 'Ask Someone Else’s Claude' }).click();
  await expect(page.getByRole('menuitem', { name: /^bob’s Claude/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^mia’s Claude/ })).toBeVisible();
  await shot(page, 'chat-ask-menu');
  await page.getByRole('menuitem', { name: /^Everyone’s Claude/ }).click();
  await expect(page.getByText('Asking everyone’s Claude')).toBeVisible();
  await box.fill('Are we ready to ship on Friday?');
  await page.getByRole('button', { name: 'Send and asking everyone’s claude' }).click();
  await expect(log).toContainText('Asked everyone’s Claude');
  await expect(log.getByText('bob’s Claude', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(log.getByText('mia’s Claude', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(log.getByText('Your Claude', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(log.locator('[data-claude="true"]')).toHaveCount(3);

  // No words needed: your Claude reads the conversation and answers.
  await page.getByRole('button', { name: 'Ask: your Claude', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ask: your Claude', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Send and asking your claude' }).click();
  await expect(log.locator('[data-claude="true"]')).toHaveCount(4, { timeout: 20_000 });
  await shot(page, 'chat-claudes');
});

test('@claude in the words asks your Claude; the mention shows as a pill', async ({ page }) => {
  await channel(page, 'launch').click();
  const log = page.getByRole('log', { name: 'Channel launch' });
  const box = page.getByRole('textbox', { name: 'Message launch' });
  await expect(log).toContainText('Checklist for Friday', { timeout: 20_000 });
  const before = await log.locator('[data-claude="true"]').count();
  await box.fill('');
  await box.pressSequentially('@cl');
  const list = page.getByRole('listbox', { name: 'Suggestions' });
  await expect(list.getByRole('option', { name: /^Claude \(yours\)/ })).toBeVisible();
  await expect(list.getByRole('option', { name: /^bob’s Claude/ })).toBeVisible();
  await expect(list.getByRole('option', { name: /^Everyone’s Claude/ })).toBeVisible();
  await shot(page, 'chat-mention-menu');
  await list.getByRole('option', { name: /^Claude \(yours\)/ }).click();
  await expect(box).toHaveValue('@claude ');
  await box.pressSequentially('what’s left before Friday?');
  await box.press('Enter');
  // The post carries ask [you]: it says so under it, and your Claude answers.
  const mine = log.locator('[data-message]').filter({ hasText: 'what’s left before Friday?' }).last();
  await expect(mine).toContainText('Asked your Claude');
  await expect(mine.getByRole('button', { name: 'Claude claude' })).toBeVisible();
  await expect(log.locator('[data-claude="true"]')).toHaveCount(before + 1, { timeout: 20_000 });

  // Plain @bob is the person: no Claude.
  await box.pressSequentially('@bo');
  await expect(list.getByRole('option', { name: /^bob.*the person/ })).toBeVisible();
  await box.press('Escape');
  await box.fill('');

  // / at the start: the channel's commands.
  await box.pressSequentially('/');
  await expect(list.getByRole('option', { name: /^\/claude\s*Your Claude answers/ })).toBeVisible();
  await expect(list.getByRole('option', { name: /^\/files/ })).toBeVisible();
  await shot(page, 'chat-commands');
  await list.getByRole('option', { name: /^\/claudes/ }).click();
  await expect(page.getByText('Asking everyone’s Claude')).toBeVisible();
  await expect(box).toHaveValue('');
  await page.getByRole('button', { name: 'Don’t ask Claude' }).click();
});

test('alone in a channel: Ask: your Claude is one toggle, no menu', async ({ page }) => {
  await channel(page, 'launch').click();
  await tabs(page).getByRole('button', { name: 'New chat' }).click();
  await page.getByRole('menuitem', { name: 'New Channel…' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Channel' });
  await sheet.getByLabel('Name').fill('solo');
  await sheet.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('textbox', { name: 'Message solo' })).toBeVisible({ timeout: 15_000 });
  const add = page.getByRole('button', { name: 'Ask: your Claude', exact: true });
  await expect(add).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Ask Someone Else’s Claude' })).toHaveCount(0);
  await add.click();
  await expect(page.getByText('Asking your Claude')).toBeVisible();
  await shot(page, 'chat-alone');
  await add.click();
  await expect(page.getByText('Asking your Claude')).toHaveCount(0);
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

test('pasted paths of files on this Mac go as the files; other words stay words', async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga paste-'));
  writeFileSync(path.join(dir, 'plan notes.txt'), 'Pasted by its path.');
  // A 2×2 red PNG.
  writeFileSync(path.join(dir, 'shot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==', 'base64'));
  await channel(page, 'launch').click();
  const box = page.locator('main textarea').last();
  const paste = (text: string) =>
    box.evaluate((el, t) => {
      const data = new DataTransfer();
      data.setData('text/plain', t);
      if (el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))) document.execCommand('insertText', false, t);
    }, text);
  await box.fill('');
  await paste(`${dir}/plan\\ notes.txt\n'${dir}/shot.png'`);
  const tray = page.getByRole('list', { name: 'Files to send' });
  await expect(tray).toContainText('plan notes.txt');
  await expect(tray).toContainText('shot.png');
  await expect(tray.locator('img')).toHaveCount(1);
  await expect(box).toHaveValue('');
  // A folder is words.
  await paste(dir);
  await expect(box).toHaveValue(dir);
  await box.fill('');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(tray).toHaveCount(0);
  const log = page.getByRole('log', { name: 'Channel launch' });
  await expect(log.getByRole('group', { name: /^plan notes\.txt, TXT · / }).last()).toBeVisible({ timeout: 10_000 });
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
