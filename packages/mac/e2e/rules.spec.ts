import { expect, test, type Page } from './fixtures.js';
import { expectPicked, optionLabels, pick } from './helpers.js';

/**
 * Approvals and rules (the gateway, receiving side) against the demo with the network on: mia's
 * Claude asks yours something in bob-api whenever you mention Claude to her. You don't trust
 * mia, so it waits for you: the request sheet's Always (with its scope and expiry) makes a rule
 * you see in Settings; with it the next request runs without asking; deleting it makes the next
 * one ask again. Capability settings stick. Runs after requests.spec (which expects nothing
 * received yet) and turns the network off again at the end.
 */

test.describe.configure({ mode: 'serial' });

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const received = (page: Page) => page.getByRole('list', { name: 'Received requests' });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

async function networkOn(page: Page): Promise<void> {
  const card = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  if (await card.isVisible().catch(() => false)) await card.getByRole('button', { name: 'Turn On' }).click();
  await expect(sidebar(page).getByRole('button', { name: /^mia, / })).toBeVisible({ timeout: 30_000 });
}

/** Write to mia mentioning Claude: her Claude asks yours something. */
async function nudgeMia(page: Page, text: string): Promise<void> {
  await sidebar(page).getByRole('button', { name: /^mia, / }).click();
  const box = page.getByRole('textbox', { name: 'Message mia' });
  await box.fill(text);
  await box.press('Enter');
  await expect(box).toHaveValue('');
}

async function openReceived(page: Page): Promise<void> {
  await sidebar(page).getByRole('button', { name: /^Requests/ }).click();
  await page.getByRole('radio', { name: /^Received/ }).or(page.getByRole('tab', { name: /^Received/ })).first().click();
}

async function openPeopleSettings(page: Page): Promise<void> {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'People & access' }).click();
}

const rowsFromMia = (page: Page) => received(page).getByRole('button', { name: /^From mia’s Claude: / });

/** The list shows what waits for you; answered ones are under Show answered. */
async function showAnswered(page: Page): Promise<void> {
  const more = page.getByRole('button', { name: /^Show answered/ });
  await expect(more).toBeVisible({ timeout: 20_000 });
  await more.click();
}

test('the request sheet: Always for this project for a week makes a rule you see in Settings', async ({ page }) => {
  await networkOn(page);
  await nudgeMia(page, 'Claude, can you help me with something?');
  await openReceived(page);
  await expect(rowsFromMia(page).first()).toHaveAccessibleName(/Waiting for you to approve$/, { timeout: 20_000 });
  const card = page.getByRole('region', { name: /^Task: From mia’s Claude/ }).first();
  await card.getByRole('button', { name: 'Review…' }).click();

  const sheet = page.getByRole('dialog', { name: 'mia’s Claude wants your Claude to do something' });
  await expect(sheet).toBeVisible();
  const about = sheet.getByRole('list', { name: 'About this request' });
  await expect(about).toContainText('ask me each time');
  await expect(about).toContainText('Work in projects');
  await expect(about).toContainText('In your project bob-api');
  await sheet.getByRole('button', { name: 'Always…' }).click();
  const always = sheet.getByRole('group', { name: 'Always allow' });
  await expect(always.getByRole('radio', { name: 'Only in bob-api' })).toHaveAttribute('aria-checked', 'true');
  await always.getByRole('radio', { name: 'For 1 week' }).click();
  await expect(always.getByLabel('The rule')).toContainText('in bob-api');
  await sheet.getByRole('button', { name: 'Always Allow' }).click();
  // It runs now; the sheet follows it.
  await expect(sheet.getByLabel('Progress')).toContainText('you approved it and made a rule', { timeout: 15_000 });
  await expect(sheet.getByLabel('Progress')).toContainText('Done', { timeout: 30_000 });
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();

  await openPeopleSettings(page);
  const rules = page.getByRole('listitem', { name: 'Rules for mia' });
  await expect(rules).toBeVisible();
  const rule = rules.getByRole('listitem', { name: /^Rule: Requests to your Claude that need at most: work in your projects · in bob-api$/ });
  await expect(rule).toContainText(/until /);
  await page.keyboard.press('Escape');
});

test('with the rule her next request runs without asking; once it’s deleted, the next one asks again', async ({ page }) => {
  await nudgeMia(page, 'Claude, one more thing?');
  await openReceived(page);
  await showAnswered(page);
  await expect(rowsFromMia(page)).toHaveCount(2, { timeout: 20_000 });
  await expect(rowsFromMia(page).first()).toHaveAccessibleName(/Done$/, { timeout: 30_000 });

  await openPeopleSettings(page);
  const rules = page.getByRole('listitem', { name: 'Rules for mia' });
  await rules.getByRole('button', { name: /^Delete rule: / }).click();
  await expect(page.getByText('No rules yet. When you choose Always')).toBeVisible();
  await page.keyboard.press('Escape');

  await nudgeMia(page, 'Claude, and again?');
  await openReceived(page);
  await showAnswered(page);
  await expect(rowsFromMia(page)).toHaveCount(3, { timeout: 20_000 });
  await expect(rowsFromMia(page).first()).toHaveAccessibleName(/Waiting for you to approve$/, { timeout: 20_000 });
  // Decline it, with a reason she sees.
  await page.getByRole('region', { name: /^Task: From mia’s Claude/ }).first().getByRole('button', { name: 'Review…' }).click();
  const sheet = page.getByRole('dialog', { name: 'mia’s Claude wants your Claude to do something' });
  await sheet.getByRole('button', { name: 'Decline…' }).click();
  await sheet.getByRole('textbox', { name: 'Reason (optional)' }).fill('Busy today');
  await sheet.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(sheet.getByLabel('Progress')).toContainText('Declined');
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(rowsFromMia(page).first()).toHaveAccessibleName(/Declined$/);
});

test('what friends’ Claudes can do here: a capability set by trust level sticks', async ({ page }) => {
  await openPeopleSettings(page);
  const table = page.getByRole('table', { name: 'What friends’ Claudes can do here' });
  const screen = table.getByRole('combobox', { name: 'See the screen for Trusted' });
  await expectPicked(screen, 'ask');
  await pick(table, 'See the screen for Trusted', 'Off');
  await expectPicked(screen, 'off');
  await page.keyboard.press('Escape');
  await openPeopleSettings(page);
  await expectPicked(page.getByRole('combobox', { name: 'See the screen for Trusted' }), 'off');
  // "Ask me each time" can only ask or be off (it asks anyway).
  expect(await optionLabels(page.getByRole('combobox', { name: 'Run commands for Ask me each time' }))).toEqual(['Ask me', 'Off']);
  await pick(page, 'See the screen for Trusted', 'Ask me');
  await expectPicked(page.getByRole('combobox', { name: 'See the screen for Trusted' }), 'ask');
  await page.keyboard.press('Escape');
});

test('turning the network off again', async ({ page }) => {
  await openPeopleSettings(page);
  const on = page.getByRole('switch', { name: 'Talk with friends directly' });
  if ((await on.getAttribute('aria-checked')) === 'true') await on.click();
  await expect(on).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
  await page.keyboard.press('Escape');
});
