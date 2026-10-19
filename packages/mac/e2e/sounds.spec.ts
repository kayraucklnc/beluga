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
