import { expect, test, type Locator, type Page } from '@playwright/test';

/** Settings › Notifications › Sound: pick a sound (▶ to hear it first), make your own, one per kind. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const picker = (page: Page) => settings(page).getByRole('radiogroup', { name: /sounds$/ });

async function openSoundSettings(page: Page): Promise<Locator> {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+,');
  await settings(page).getByRole('button', { name: 'Notifications', exact: true }).click();
  const group = settings(page).getByRole('heading', { name: 'Sound' });
  await expect(group).toBeVisible();
  return settings(page);
}

/** Back to one sound for all, the default (the daemon is shared by every test). */
async function reset(page: Page): Promise<void> {
  const s = settings(page);
  await s.getByRole('tab', { name: 'Same for all' }).click();
  await s.getByRole('tab', { name: 'Mac' }).click();
  await picker(page).getByRole('radio', { name: 'Glass' }).click();
  await expect(picker(page).getByRole('radio', { name: 'Glass' })).toHaveAttribute('aria-checked', 'true');
}

test('picks an 8-bit sound, with a ▶ preview for each, and keeps it', async ({ page }) => {
  const s = await openSoundSettings(page);
  await s.getByRole('tab', { name: '8-bit' }).click();
  for (const name of ['Blip', 'Coin', 'Chime', 'Power-up', 'Arpeggio up', 'Arpeggio down', 'Two-note ping', 'Done jingle']) {
    await expect(picker(page).getByRole('radio', { name })).toBeVisible();
    await expect(picker(page).getByRole('button', { name: `Play ${name}` })).toBeVisible();
  }
  await picker(page).getByRole('radio', { name: 'Coin' }).click();
  await expect(picker(page).getByRole('radio', { name: 'Coin' })).toHaveAttribute('aria-checked', 'true');
  await expect(s.getByText('8-bit · Coin', { exact: true })).toBeVisible();
  await expect(s.getByRole('button', { name: 'Play 8-bit · Coin' })).toBeVisible();

  // Saved with your settings: still chosen after a reload.
  await page.reload();
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+,');
  await settings(page).getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(settings(page).getByText('8-bit · Coin', { exact: true })).toBeVisible();
  await expect(settings(page).getByRole('slider', { name: 'Volume of Klaud’s sounds' })).toBeVisible();
  await reset(page);
});

test('lists the Mac’s own sounds and None', async ({ page }) => {
  const s = await openSoundSettings(page);
  await s.getByRole('tab', { name: 'Mac' }).click();
  for (const name of ['Glass', 'Ping', 'Pop', 'Purr', 'Tink', 'Hero', 'Funk', 'Submarine', 'Blow', 'Bottle', 'Frog', 'Morse', 'Sosumi', 'Basso']) {
    await expect(picker(page).getByRole('radio', { name })).toBeVisible();
  }
  await s.getByRole('tab', { name: 'None' }).click();
  await picker(page).getByRole('radio', { name: 'None' }).click();
  await expect(s.getByText('None', { exact: true }).first()).toBeVisible();
  await expect(s.getByRole('button', { name: /^Play None/ })).toHaveCount(0);
  await reset(page);
});

test('generates sounds: Shuffle makes a new one, Keep saves it', async ({ page }) => {
  const s = await openSoundSettings(page);
  await s.getByRole('tab', { name: 'Generated' }).click();
  const made = s.getByRole('group', { name: 'Make a new sound' });
  const name = made.locator('[data-seed]');
  const first = await name.getAttribute('data-seed');
  await made.getByRole('button', { name: 'Shuffle' }).click();
  await expect(name).not.toHaveAttribute('data-seed', first ?? '');
  const seed = Number(await name.getAttribute('data-seed'));
  const label = (await name.textContent()) ?? '';
  expect(Number.isInteger(seed)).toBe(true);
  await expect(made.getByRole('button', { name: `Play ${label}` })).toBeVisible();

  await made.getByRole('button', { name: 'Keep' }).click();
  await expect(picker(page).getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'true');
  await expect(s.getByText(`Generated · ${label}`, { exact: true })).toBeVisible();
  await reset(page);
  // Kept sounds stay in the list to pick again.
  await s.getByRole('tab', { name: 'Generated' }).click();
  await expect(picker(page).getByRole('radio', { name: label })).toBeVisible();
});

test('a different sound for each kind of notification', async ({ page }) => {
  const s = await openSoundSettings(page);
  await s.getByRole('tab', { name: 'Per kind' }).click();
  const kinds = s.getByRole('radiogroup', { name: 'Kind of notification' });
  for (const kind of ['Claude needs you', 'Claude finished', 'Messages and mentions', 'People come and go', 'Background tasks']) {
    await expect(kinds.getByRole('radio', { name: new RegExp(`^${kind}`) })).toBeVisible();
  }
  await kinds.getByRole('radio', { name: /^Claude needs you/ }).click();
  await s.getByRole('tab', { name: '8-bit' }).click();
  await picker(page).getByRole('radio', { name: 'Two-note ping' }).click();
  await expect(kinds.getByRole('radio', { name: /^Claude needs you/ })).toContainText('8-bit · Two-note ping');
  await expect(kinds.getByRole('radio', { name: /^Claude finished/ })).toContainText('Glass');
  await expect(kinds.getByRole('button', { name: 'Play Claude needs you: 8-bit · Two-note ping' })).toBeVisible();

  await kinds.getByRole('radio', { name: /^Background tasks/ }).click();
  await expect(kinds.getByRole('radio', { name: /^Background tasks/ })).toHaveAttribute('aria-checked', 'true');
  await s.getByRole('tab', { name: 'None' }).click();
  await picker(page).getByRole('radio', { name: 'None' }).click();
  await expect(kinds.getByRole('radio', { name: /^Background tasks/ })).toContainText('None');
  await expect(kinds.getByRole('radio', { name: /^Claude needs you/ })).toContainText('8-bit · Two-note ping');

  await s.getByRole('tab', { name: 'Same for all' }).click();
  await expect(kinds).toBeHidden();
  await reset(page);
});

/**
 * Whether notifications reach you. The browser has no app shell to ask macOS, so a test seeds
 * what macOS says in window.__KLAUD_NOTIFY_ACCESS__ and reads what the buttons asked the shell
 * for back from window.__KLAUD_NOTIFY_CALLS__ (lib/sounds/access.ts).
 */
const soundGroup = (page: Page) => settings(page).locator('section', { has: page.getByRole('heading', { name: 'Sound' }) });
const status = (page: Page) => settings(page).getByRole('status', { name: 'Notification status' });
const shellCalls = (page: Page) => page.evaluate(() => window.__KLAUD_NOTIFY_CALLS__ ?? []);

async function seedAccess(page: Page, access: object): Promise<void> {
  await page.addInitScript((a) => void (window.__KLAUD_NOTIFY_ACCESS__ = a as never), access);
}

test('Send Test Notification sits right under the sound, near the top', async ({ page }) => {
  const s = await openSoundSettings(page);
  const send = soundGroup(page).getByRole('button', { name: 'Send Test Notification' });
  await expect(send).toBeVisible();
  // Under "Notification sound", above the picker and long before "Tell me when".
  const y = async (l: Locator): Promise<number> => (await l.boundingBox())!.y;
  const sendY = await y(send);
  expect(sendY).toBeGreaterThan(await y(soundGroup(page).getByText('Notification sound', { exact: true })));
  expect(sendY).toBeLessThan(await y(soundGroup(page).getByRole('tablist', { name: 'Kind of sound' })));
  expect(sendY).toBeLessThan(await y(s.getByRole('heading', { name: 'Tell me when' })));
  await expect(s.getByRole('button', { name: 'Send a test' })).toHaveCount(0);

  // A browser can't read macOS's settings: the status line says so, without a scary warning.
  await expect(status(page)).toContainText('Can’t check macOS from here');
  await expect(status(page)).toHaveAttribute('data-tone', 'muted');

  // The test says what happened, under the button (not just a toast).
  await send.click();
  const result = soundGroup(page).getByRole('status', { name: 'Test result' });
  await expect(result).toContainText('Sent. Look for the banner at the top right of your screen.');
  await expect(result).toContainText('You heard “Glass” here.');
  await expect(result).toContainText('Focus');
  await result.getByRole('button', { name: 'Open Focus Settings' }).click();
  expect(await shellCalls(page)).toContain('open_focus_settings');
});

test('stays with the sound when it’s one per kind', async ({ page }) => {
  const s = await openSoundSettings(page);
  await s.getByRole('tab', { name: 'Per kind' }).click();
  const send = soundGroup(page).getByRole('button', { name: 'Send Test Notification' });
  const kinds = s.getByRole('radiogroup', { name: 'Kind of notification' });
  expect((await send.boundingBox())!.y).toBeGreaterThan((await kinds.boundingBox())!.y);
  await reset(page);
});

test('blocked by macOS: the status line says what to turn on and opens System Settings', async ({ page }) => {
  await seedAccess(page, { state: 'off', alerts: true, sound: true, focus: 'unknown' });
  await openSoundSettings(page);
  await expect(status(page)).toContainText('Blocked by macOS');
  await expect(status(page)).toContainText('Allow notifications');
  await expect(status(page)).toContainText('Banners');
  await expect(status(page)).toContainText('Play sound for notifications');
  await expect(status(page)).toHaveAttribute('data-tone', 'warn');
  await status(page).getByRole('button', { name: 'Open Notification Settings' }).click();
  expect(await shellCalls(page)).toContain('open_notification_settings');

  // A test doesn't pretend it showed.
  await soundGroup(page).getByRole('button', { name: 'Send Test Notification' }).click();
  const result = soundGroup(page).getByRole('status', { name: 'Test result' });
  await expect(result).toContainText('Sent, but macOS blocked it.');
  await expect(result.getByRole('button', { name: 'Open Notification Settings' })).toBeVisible();
});

test('a Focus holding banners is named, with a way to Focus settings', async ({ page }) => {
  await seedAccess(page, { state: 'allowed', alerts: true, sound: true, focus: 'on', focusName: 'Do Not Disturb' });
  await openSoundSettings(page);
  await expect(status(page)).toContainText('Do Not Disturb is on');
  await expect(status(page)).toContainText('Allowed Apps');
  await status(page).getByRole('button', { name: 'Open Focus Settings' }).click();
  expect(await shellCalls(page)).toContain('open_focus_settings');
});

test('not set up yet: Allow Notifications asks macOS', async ({ page }) => {
  await seedAccess(page, { state: 'notAsked', alerts: true, sound: true, focus: 'off' });
  await openSoundSettings(page);
  await expect(status(page)).toContainText('Not set up yet');
  await status(page).getByRole('button', { name: 'Allow Notifications…' }).click();
  expect(await shellCalls(page)).toContain('notification_request');
});

test('all clear: notifications are on', async ({ page }) => {
  await seedAccess(page, { state: 'allowed', alerts: true, sound: true, focus: 'off' });
  await openSoundSettings(page);
  await expect(status(page)).toContainText('Notifications are on');
  await expect(status(page)).toHaveAttribute('data-tone', 'ok');
  await expect(status(page).getByRole('button')).toHaveCount(0);
});
