import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';
import { openSharedWorkspace, pick } from './helpers.js';

/** Inviting, people and sharing, the Mac way: sheets, cards and real controls (against the demo). */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: /^bob, / })).toBeVisible({ timeout: 15_000 });
});

test('the Invite sheet copies a link, lists it, and revokes it', async ({ page }) => {
  // The room's card (its people, under Friends) has Invite People…; the sidebar's Invite adds a friend.
  await sidebar(page).getByRole('button', { name: /people in .* room: room details/ }).click();
  await page.getByRole('button', { name: 'Invite People…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Invite People' });
  await expect(sheet).toBeVisible();
  await pick(sheet, 'Invite to', 'bob-api');
  await sheet.getByRole('radio', { name: 'Watch' }).click();
  await expect(sheet.getByText('See the chat history and browse the files.')).toBeVisible();
  await sheet.getByRole('checkbox', { name: /One person only/ }).uncheck();
  const links = sheet.getByRole('list', { name: 'Active links' }).getByRole('listitem');
  const before = await links.count();
  // Return copies (the default button), and it says so.
  await page.keyboard.press('Enter');
  await expect(sheet.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect(page.getByText(/Link for bob-api copied \(can watch, knocks first\)/)).toBeVisible();
  await expect(links).toHaveCount(before + 1);
  const made = links.filter({ hasText: 'can watch' }).filter({ hasText: 'anyone' }).first();
  await expect(made).toContainText('bob-api');
  await made.getByRole('button', { name: /^Revoke/ }).click();
  await expect(links).toHaveCount(before);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test("a friend's card changes how much you trust them, and remembers it", async ({ page }) => {
  // Trust is set in one place: the friend's card, beside your chat with them (BLG-202).
  await sidebar(page).getByRole('button', { name: /^mia, / }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^mia’s Card/ }).click();
  const panel = page.getByRole('complementary', { name: 'Panel' });
  await pick(panel, 'Trust mia', 'Trusted');
  await expect(panel.getByText(/Requests run without asking/)).toBeVisible();
  // Away and back: still Trusted. Then back to asking.
  await sidebar(page).getByRole('button', { name: /^Overview/ }).click();
  await sidebar(page).getByRole('button', { name: /^mia, / }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^mia’s Card/ }).click();
  await expect(panel.getByText(/Requests run without asking/)).toBeVisible();
  await pick(panel, 'Trust mia', 'Ask me each time');
  await expect(panel.getByText(/You approve each request/)).toBeVisible();
});

test("Ask Claude addresses the message with a chip, not typed text", async ({ page }) => {
  // bob in the room (under Not friends yet: the demo's room bob isn't the friend bob): his row opens his room card.
  await sidebar(page).getByRole('button', { name: 'bob Add bob as a friend' }).click();
  await page.getByRole('dialog', { name: 'bob' }).getByRole('button', { name: 'Ask Claude' }).click();
  await expect(page.getByLabel('To bob’s Claude')).toBeVisible();
  await expect(composer(page)).toHaveValue('');
  await expect(composer(page)).toHaveAttribute('placeholder', 'Message bob’s Claude');
  await page.getByRole('button', { name: 'Don’t address it' }).click();
  await expect(page.getByLabel('To bob’s Claude')).toBeHidden();
});

test('Share a Folder: share with one person, see it listed, stop sharing', async ({ page }) => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-e2e-share-')), 'sketches');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'idea.md'), '# idea\n');
  await page.keyboard.press('Meta+K');
  await page.keyboard.type('Share a folder');
  await page.getByRole('option', { name: /^Share a folder/ }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Share a Folder' });
  await sheet.getByRole('textbox', { name: 'Folder path' }).fill(dir);
  await sheet.getByRole('radio', { name: 'Only…' }).click();
  await expect(sheet.getByRole('button', { name: 'Share', exact: true })).toBeDisabled();
  // bob is in the room and a friend too: either one is him.
  await sheet.getByRole('checkbox', { name: 'bob' }).first().check();
  await sheet.getByRole('button', { name: 'Share', exact: true }).click();
  const row = sheet.getByRole('list', { name: 'Shared folders' }).getByRole('listitem', { name: 'sketches' });
  await expect(row).toContainText('only bob');
  await row.getByRole('button', { name: 'Stop sharing sketches' }).click();
  await expect(row).toBeHidden();
});

test("a workspace shared with you: its conversation, and a search over its files (no shell tab)", async ({ page }) => {
  await openSharedWorkspace(page, 'bob-api', 'bob', 'payments');
  await expect(page.getByText(/retries keep double-charging, can you look at the webhook handler\?/)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Files' }).click();
  await page.getByLabel('Search the files').fill('TODO');
  await page.keyboard.press('Enter');
  const results = page.getByRole('list', { name: 'Search results' });
  await expect(results.getByRole('listitem').filter({ hasText: 'NOTES.md' })).toBeVisible({ timeout: 15_000 });
  await results.getByRole('listitem').filter({ hasText: 'NOTES.md' }).first().click();
  await expect(page.getByRole('region', { name: 'NOTES.md' })).toBeVisible();
});
