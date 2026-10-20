import { expect, test, type Page } from '@playwright/test';
import { pick } from './helpers.js';

/** The Mac app's web view against a real klaud (the demo): what you click does what it says. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

async function openWorkspace(page: Page, name = 'add-auth'): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
}

/** The full-page terminal (no sidebar row of its own: ⌥6, the Go menu, ⌘K). */
async function openTerminalPage(page: Page): Promise<void> {
  await expect(sidebar(page)).toBeVisible();
  // (Right after a reload the window may not be listening yet: try again.)
  await expect(async () => {
    await page.keyboard.press('Alt+Digit6');
    await expect(page.locator('header').first()).toContainText('Terminal', { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('shows the room, its people and projects', async ({ page }) => {
  await expect(sidebar(page).getByRole('button', { name: 'bob', exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('bob-api')).toBeVisible();
  await expect(page.getByText('hey! just pushed my API notes')).toBeVisible();
});

test("talks to Claude in a workspace and shows its run", async ({ page }) => {
  await openWorkspace(page);
  // The center is always the conversation (its changes, files and terminal are in the right panel).
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await composer(page).fill('Add a health check endpoint');
  await composer(page).press('Enter');
  await expect(page.getByText('Add a health check endpoint').last()).toBeVisible();
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 20_000 });
});

test('shows what changed, file by file: in the panel, then in full', async ({ page }) => {
  await openWorkspace(page);
  const panel = page.getByRole('complementary', { name: 'Panel' });
  await panel.getByRole('tab', { name: 'Changes' }).click();
  await panel.getByRole('option', { name: /auth\.ts/ }).click();
  await expect(panel.getByRole('region', { name: 'Changes in auth.ts' }).getByText('requireUser').first()).toBeVisible();
  await panel.getByRole('button', { name: 'Open in full' }).click();
  await page.getByRole('main').getByRole('tab', { name: 'Split' }).click();
  await expect(page.getByRole('main').getByText('requireUser').first()).toBeVisible();
  await page.getByRole('button', { name: 'Back to Chat' }).click();
  await expect(composer(page)).toBeVisible();
});

test('the palette goes anywhere', async ({ page }) => {
  await page.keyboard.press('Meta+K');
  await page.keyboard.type('usage');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 }).or(page.getByText('in worktrees'))).toBeVisible();
});

test('switches to dark from Settings', async ({ page }) => {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Appearance' }).click();
  await pick(page, 'Appearance', 'Dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await pick(page, 'Appearance', 'Light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('⌘J shows the terminal in the right panel and runs a command in it', async ({ page }) => {
  await openWorkspace(page);
  // Each place has its own panel tab: wait until the workspace is the one showing.
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await page.keyboard.press('Meta+J');
  const term = page.getByRole('complementary', { name: 'Panel' }).getByRole('region', { name: 'Terminal' });
  await expect(term).toBeVisible();
  await term.locator('.xterm').click();
  await page.keyboard.type('echo dock-$((6*7))\n');
  await expect(term.getByText('dock-42').last()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Meta+J');
  await expect(term).toBeHidden();
});

test('picks a model and how hard Claude thinks', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Model and effort' }).click();
  await page.getByRole('radio', { name: /Opus/ }).click();
  await page.getByRole('radio', { name: 'High', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Model and effort' })).toHaveText(/Opus · High/);
  await page.getByRole('radio', { name: 'Auto' }).click();
});

test("opens a person's card beside their row", async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'bob', exact: true }).click();
  const card = page.getByRole('dialog', { name: 'bob' });
  await expect(card.getByRole('radiogroup', { name: 'Trust bob' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
});

test('opens and closes shells without them coming back', async ({ page }) => {
  await openTerminalPage(page);
  const shells = page.getByRole('tab', { name: /^Shell \d+/ });
  await expect(shells.first()).toBeVisible();
  await page.getByRole('button', { name: 'New shell' }).click();
  await expect(shells).toHaveCount(2);
  await page.locator('.xterm').click();
  await page.keyboard.type('echo second-$((6*7))\n');
  await expect(page.getByText('second-42')).toBeVisible({ timeout: 15_000 });
  // Closing the one shown moves to the other, and it stays closed.
  await shells.nth(1).getByRole('button', { name: /^Close/ }).click();
  await expect(shells).toHaveCount(1);
  await page.waitForTimeout(1500);
  await expect(shells).toHaveCount(1);
  await shells.first().getByRole('button', { name: /^Close/ }).click();
  await expect(page.getByText('No shells open')).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(shells).toHaveCount(0);
  await page.getByRole('button', { name: 'New shell' }).last().click();
  await expect(shells).toHaveCount(1);
});

test('renames a shell, for every screen, and Escape cancels', async ({ page }) => {
  await openTerminalPage(page);
  const first = page.getByRole('tab', { name: /^Shell \d+/ }).first();
  await expect(first).toBeVisible();
  await page.waitForTimeout(800); // it has started
  await first.dblclick();
  await page.getByLabel('Terminal name').fill('build logs');
  await page.keyboard.press('Enter');
  const named = page.getByRole('tab', { name: /^build logs/ });
  await expect(named).toBeVisible();
  // Escape keeps the name it had.
  await named.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByLabel('Terminal name').fill('nope');
  await page.keyboard.press('Escape');
  await expect(named).toBeVisible();
  // It's shared state: a fresh window sees it too.
  await page.reload();
  await openTerminalPage(page);
  await expect(page.getByRole('tab', { name: /^build logs/ })).toBeVisible();
  // Empty goes back to its number.
  await page.getByRole('tab', { name: /^build logs/ }).dblclick();
  await page.getByLabel('Terminal name').fill('');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /^Shell \d+/ }).first()).toBeVisible();
});

test('sets an environment variable that new shells get', async ({ page }) => {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Environment', exact: true }).click();
  await page.getByRole('button', { name: 'Add variable' }).click();
  await page.getByLabel('Name', { exact: true }).last().fill('bad-name');
  await page.getByLabel(/^Value of/).last().click();
  await expect(page.getByText('Use letters, digits and _ only')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).last().fill('KLAUD_E2E_TOKEN');
  await page.getByLabel(/^Value of/).last().fill('tok-$((6*7))-secret');
  await page.getByLabel('Name', { exact: true }).last().click();
  await expect(page.getByRole('status').getByText('Saved')).toBeVisible();
  // Values are masked until you ask to see them.
  await expect(page.getByLabel('Value of KLAUD_E2E_TOKEN')).toHaveClass(/masked/);
  await page.getByRole('button', { name: 'Show KLAUD_E2E_TOKEN' }).click();
  await expect(page.getByLabel('Value of KLAUD_E2E_TOKEN')).not.toHaveClass(/masked/);
  await page.keyboard.press('Escape');
  await openTerminalPage(page);
  await page.getByRole('button', { name: 'New shell' }).first().click();
  await page.waitForTimeout(800);
  await page.locator('.xterm').click();
  await page.keyboard.type('echo "got-$KLAUD_E2E_TOKEN"\n');
  await expect(page.getByText('got-tok-$((6*7))-secret')).toBeVisible({ timeout: 15_000 });
});

test('picks how the shell starts and how terminals look', async ({ page }) => {
  await openTerminalPage(page);
  await expect(page.locator('.xterm')).toBeVisible();
  await page.keyboard.press('Meta+,');
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal', exact: true }).click();
  const login = page.getByRole('switch', { name: 'Login shell' });
  await login.click();
  await expect(login).toHaveAttribute('aria-checked', 'false');
  await page.getByLabel('Extra arguments').fill('-i');
  await page.getByLabel('Extra arguments').press('Enter');
  await expect(page.getByText(/Started as: \S+ -i$/)).toBeVisible();
  await page.getByLabel('Terminal font size').fill('16');
  await page.getByRole('tab', { name: 'Bar' }).click();
  await expect(page.getByText('16 pt')).toBeVisible();
  // The open terminal follows right away.
  await expect(page.locator('.xterm .xterm-rows')).toHaveCSS('font-size', '16px');
  // The shell settings are klaud's (shared); they're still there after a reload.
  await page.reload();
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+,');
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Login shell' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('switch', { name: 'Login shell' }).click();
  await page.getByLabel('Extra arguments').fill('');
  await page.getByLabel('Extra arguments').press('Enter');
  await expect(page.getByText(/Started as: \S+ -l$/)).toBeVisible();
});

test('adds a project from the Add Projects sheet, with its own icon', async ({ page }) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const repo = path.join(mkdtempSync(path.join(os.tmpdir(), 'klaud-e2e-repo-')), 'pixel-app');
  mkdirSync(path.join(repo, 'public'), { recursive: true });
  writeFileSync(path.join(repo, 'public/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="red"/></svg>');
  execFileSync('git', ['init', '-q', repo]);
  await sidebar(page).getByRole('button', { name: /Add a project/ }).first().click();
  await page.getByRole('menuitem', { name: 'Add Projects…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add projects' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('textbox', { name: 'Folder path' }).fill(repo);
  await sheet.getByRole('button', { name: 'Add', exact: true }).last().click();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
  const row = sidebar(page).getByRole('button', { name: /^pixel-app/ }).first();
  await expect(row).toBeVisible();
  await expect(row.locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml/);
  // Nothing in it yet: no fold arrow (a project with worktrees keeps its own).
  await expect(sidebar(page).getByRole('button', { name: /^(Fold|Show what's in) pixel-app/ })).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: /^(Fold|Show what's in) bob-api/ })).toHaveCount(1);
  if (process.env.SHOTS) await sidebar(page).screenshot({ path: `${process.env.SHOTS}/sidebar-empty-project.png` });
});

// ---- images in the chat, and the queue

/** A 1×1 PNG, pasted into the box the way ⌘V hands an image to the web view. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
async function pasteImage(page: Page): Promise<void> {
  await composer(page).evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG);
}

test("shows a friend's screenshot in the chat and opens it full size", async ({ page }) => {
  const thumb = page.getByRole('button', { name: /^Open image 1/ }).first();
  await expect(thumb).toBeVisible({ timeout: 15_000 });
  // Fetched from bob's computer through klaud, and drawn.
  await expect.poll(() => thumb.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
  await thumb.click();
  const box = page.getByRole('dialog', { name: /image 1/ });
  await expect(box.getByRole('img')).toBeVisible();
  await expect(box.getByRole('button', { name: 'Copy' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
});

test('shows pasted images before sending, and in the message after', async ({ page }) => {
  await composer(page).click();
  await pasteImage(page);
  const pending = page.getByLabel('Images to send');
  await expect(pending.getByRole('img')).toHaveCount(1);
  // The image waits above the box as a thumbnail; the text stays yours (no "[image 1]" in it).
  await expect(composer(page)).toHaveValue('');
  await pending.getByRole('button', { name: /^Remove image/ }).click();
  await expect(pending).toBeHidden();
  await pasteImage(page);
  await expect(pending.getByRole('img')).toHaveCount(1);
  await expect(composer(page)).toHaveValue('');
  const words = `pixel check ${Date.now()}`;
  await composer(page).pressSequentially(words);
  await composer(page).press('Enter');
  await expect(page.getByText(words)).toBeVisible();
  const sent = page.locator('[data-index]').filter({ hasText: words }).getByRole('button', { name: /^Open image \d+ \(png/ });
  await expect.poll(() => sent.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
});

test('queues messages while Claude works, reorders them, and sends one now', async ({ page }) => {
  await openWorkspace(page, 'webhook-retries');
  await expect(composer(page)).toHaveAttribute('placeholder', /webhook-retries/);
  await composer(page).fill('Take a deep dive into the codebase');
  await composer(page).press('Enter');
  // While Claude works, the send button splits into Queue and Send now.
  const split = page.getByRole('group', { name: 'Claude is working' });
  await expect(split).toBeVisible();
  for (const text of ['first in line', 'second in line', 'third in line']) {
    await composer(page).fill(text);
    await split.getByRole('button', { name: 'Queue' }).click();
  }
  const tray = page.getByRole('region', { name: 'Queued messages' });
  const rows = tray.getByRole('listitem');
  await expect(rows).toHaveText([/first in line/, /second in line/, /third in line/]);
  await rows.nth(2).hover();
  await rows.nth(2).getByRole('button', { name: 'Move up' }).click();
  await expect(rows).toHaveText([/first in line/, /third in line/, /second in line/]);
  await rows.nth(0).hover();
  await rows.nth(0).getByRole('button', { name: 'Remove from the queue' }).click();
  await expect(rows).toHaveCount(2);
  // Edit pulls it out of the queue and back into the box.
  await rows.nth(1).hover();
  await rows.nth(1).getByRole('button', { name: /^Edit/ }).click();
  await expect(composer(page)).toHaveValue('second in line');
  await expect(rows).toHaveCount(1);
  await composer(page).fill('');
  await rows.nth(0).hover();
  await rows.nth(0).getByRole('button', { name: 'Send now' }).click();
  await expect(tray).toBeHidden();
  await expect(page.getByText('Interrupted by a newer message').last()).toBeVisible();
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 20_000 });
});

// ---- the notification centre (the bell in the toolbar)

const bell = (page: Page) => page.getByRole('button', { name: /^Notifications/ }).first();
const centre = (page: Page) => page.getByRole('dialog', { name: 'Notifications' });

/** Open the centre and empty it, so each test starts from nothing. */
async function emptyCentre(page: Page): Promise<void> {
  await bell(page).click();
  const clear = centre(page).getByRole('button', { name: 'Clear all' });
  if (await clear.isEnabled()) await clear.click();
  await expect(centre(page).getByText('You’re all caught up')).toBeVisible();
  await page.keyboard.press('Escape');
}

async function sendTestNotification(page: Page): Promise<void> {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.getByRole('button', { name: 'Send Test Notification' }).click();
  await expect(page.getByRole('status', { name: 'Test result' })).toContainText('Sent');
  await page.keyboard.press('Escape');
}

test('the bell opens the notification centre, with filters', async ({ page }) => {
  await emptyCentre(page);
  await sendTestNotification(page);
  await expect(bell(page)).toHaveAccessibleName(/1 new/);
  await bell(page).click();
  await expect(centre(page).getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(centre(page).getByText('Notifications work')).toBeVisible();
  await centre(page).getByRole('tab', { name: 'Mentions' }).click();
  await expect(centre(page).getByText('No mentions')).toBeVisible();
  await centre(page).getByRole('tab', { name: 'All' }).click();
  await expect(centre(page).getByText('Notifications work')).toBeVisible();
});

test('marks everything read, one unread again, and clears', async ({ page }) => {
  await emptyCentre(page);
  await sendTestNotification(page);
  await sendTestNotification(page);
  await bell(page).click();
  await expect(centre(page).getByRole('listitem')).toHaveCount(2);
  await centre(page).getByRole('button', { name: 'Mark all read' }).click();
  await expect(bell(page)).not.toHaveAccessibleName(/new/);
  await centre(page).getByRole('tab', { name: /Unread/ }).click();
  await expect(centre(page).getByText('Nothing unread')).toBeVisible();
  await centre(page).getByRole('tab', { name: 'All' }).click();
  // Hover a notification for read/unread and ×.
  const first = centre(page).getByRole('listitem').first();
  await first.hover();
  await first.getByRole('button', { name: 'Mark as unread' }).click();
  await expect(bell(page)).toHaveAccessibleName(/1 new/);
  await first.hover();
  await first.getByRole('button', { name: 'Clear' }).click();
  await expect(centre(page).getByRole('listitem')).toHaveCount(1);
  await centre(page).getByRole('button', { name: 'Clear all' }).click();
  await expect(centre(page).getByText('You’re all caught up')).toBeVisible();
});

test('clicking a notification goes where it happened', async ({ page }) => {
  await emptyCentre(page);
  await openWorkspace(page);
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await composer(page).fill('Add a readiness probe');
  await composer(page).press('Enter');
  await expect(page.getByText('Add a readiness probe').last()).toBeVisible();
  // Somewhere else while Claude works: its finishing is news.
  await sidebar(page).getByRole('button', { name: 'Overview' }).click();
  await bell(page).click();
  const finished = centre(page).getByRole('button', { name: /Claude finished in add-auth/ });
  await expect(finished).toBeVisible({ timeout: 30_000 });
  await finished.click();
  await expect(centre(page)).toBeHidden();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await expect(page.getByText('Add a readiness probe').last()).toBeVisible();
});

test('effort goes back to Auto, and Shift-Tab switches plan mode on and off', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Model and effort' }).click();
  await page.getByRole('radio', { name: 'Max', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Model and effort' })).toHaveText(/Max/);
  await page.getByRole('radio', { name: 'Auto' }).click();
  await expect(page.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Model and effort' })).not.toHaveText(/Max/);
  await page.keyboard.press('Escape');
  await composer(page).click();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('status').filter({ hasText: 'Plan mode' }).filter({ hasText: 'to act' })).toBeVisible();
  await expect(composer(page)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('status').filter({ hasText: 'Plan mode' }).filter({ hasText: 'to act' })).toHaveCount(0);
});
