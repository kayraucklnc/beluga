import { expect, test, type Page } from './fixtures.js';

/** Work that starts Claude or changes git asks first: the toolbar's Review (a popover), the same from the keyboard and the palette, and a right-click menu (an alert). */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const toolbar = (page: Page) => page.locator('main header').first();
const REVIEW_SENT = /Review everything done in this workspace/;

/** Open a workspace from the sidebar (unfolding its project if another test folded it). */
async function openWorkspace(page: Page, project: string, name: string): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  const unfold = sidebar(page).getByRole('button', { name: `Show what's in ${project}` }).first();
  if (!(await row.isVisible()) && (await unfold.isVisible())) await unfold.click();
  await row.click();
  await expect(toolbar(page)).toContainText(name);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test("Review (under ⋯) says what it does and starts only when you say so", async ({ page }) => {
  // Other specs archive, fold or busy bob-api's worktrees: landing's new-hero is left as it was.
  await openWorkspace(page, 'landing', 'new-hero');
  const sent = await page.getByText(REVIEW_SENT).count();
  // It's under ⋯ (the toolbar keeps only what's next); its question opens from there.
  const more = toolbar(page).getByRole('button', { name: 'More for this workspace' });
  const review = async (): Promise<void> => {
    await more.click();
    await page.getByRole('menuitem', { name: /Ask Your Agent to Review…/ }).click();
  };
  await review();
  const pop = page.getByRole('dialog', { name: 'Ask your agent to review this worktree?' });
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('correctness, security, tests and quality');
  await expect(pop.getByRole('button', { name: 'Start Review' })).toBeFocused();
  // Cancel: nothing happens.
  await pop.getByRole('button', { name: 'Cancel' }).click();
  await expect(pop).toBeHidden();
  // A fixed wait, on purpose: it shows nothing was sent.
  await page.waitForTimeout(300);
  await expect(page.getByText(REVIEW_SENT)).toHaveCount(sent);
  // ⇧⌘R (the menu bar's item) asks the same way.
  await page.keyboard.press('Meta+Shift+R');
  await expect(pop).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(page.getByText(REVIEW_SENT)).toHaveCount(sent);
  // Start Review (the default: Return) starts it.
  await review();
  await expect(pop).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(pop).toBeHidden();
  await expect(page.getByText(REVIEW_SENT).first()).toBeVisible();
});

test('the palette asks too, and a right-click on another workspace asks with an alert', async ({ page }) => {
  await openWorkspace(page, 'landing', 'new-hero');
  await page.keyboard.press('Meta+K');
  const search = page.getByPlaceholder('Go to, do, or start anything…');
  await search.fill('Review');
  await page.getByRole('option', { name: /^Review…/ }).first().click();
  await expect(search).toBeHidden();
  const pop = page.getByRole('dialog', { name: 'Ask your agent to review this worktree?' });
  await expect(pop).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();

  // Another workspace than the one on screen: no toolbar button to hang from, so an alert.
  const other = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await other.isVisible())) await sidebar(page).getByRole('button', { name: "Show what's in bob-api" }).first().click();
  await other.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Ask Your Agent to Review…/ }).click();
  const alert = page.getByRole('alertdialog', { name: 'Ask your agent to review this worktree?' });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Start Review' })).toBeVisible();
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(alert).toBeHidden();
});
