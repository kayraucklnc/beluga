import { expect, test, type Page } from '@playwright/test';

/** The Mac app's web view against a real klaud (the demo): what you click does what it says. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

async function openWorkspace(page: Page, name = 'add-auth'): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click();
  await sidebar(page).getByRole('button', { name, exact: true }).click();
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
  await expect(page.getByRole('tab', { name: /Chat/ })).toHaveAttribute('aria-selected', 'true');
  await composer(page).fill('Add a health check endpoint');
  await composer(page).press('Enter');
  await expect(page.getByText('Add a health check endpoint').last()).toBeVisible();
  await expect(page.getByText(/Done in/).last()).toBeVisible({ timeout: 20_000 });
});

test('shows what changed, file by file', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('tab', { name: /Diff/ }).click();
  await expect(page.getByRole('option', { name: /auth\.ts/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Split' }).click();
  await expect(page.getByText('requireUser').first()).toBeVisible();
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
  await page.getByLabel('Appearance').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Appearance').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('docks a terminal beside the chat and runs a command in it', async ({ page }) => {
  await openWorkspace(page);
  await page.keyboard.press('Meta+J');
  const term = page.getByRole('region', { name: 'Terminal' });
  await expect(term).toBeVisible();
  await term.locator('.xterm').click();
  await page.keyboard.type('echo dock-$((6*7))\n');
  await expect(term.getByText('dock-42')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Meta+J');
  await expect(term).toBeHidden();
});

test('picks a model and how hard Claude thinks', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Model and effort' }).click();
  await page.getByRole('radio', { name: /Opus/ }).click();
  await page.getByRole('radio', { name: 'Thorough' }).click();
  await expect(page.getByRole('button', { name: 'Model and effort' })).toHaveText(/Opus · Thorough/);
  await page.getByRole('radio', { name: 'Auto' }).click();
});

test("opens a person's menu and the same choices as the terminal app", async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'bob', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'bob' });
  await expect(sheet.getByRole('option', { name: /Ask me each time/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('opens and closes shells without them coming back', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'Terminal', exact: true }).click();
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
