import { expect, test, type Page } from './fixtures.js';

/**
 * Claude Code's sign-in ran out mid-run (BLG-589): the failed card says so in words and offers Sign
 * In with Claude Code's own /login choices, not only Continue. The demo's Claude fails this way
 * when told "sign-in expired" (src/agent/mock.ts).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)').first();
const SHOTS = process.env.BELUGA_SHOTS;

test('an expired sign-in offers a subscription, a Console account or a 3rd-party platform', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /new-hero/);

  await composer(page).fill('sign-in expired');
  await composer(page).press('Enter');
  await expect(page.getByText('Claude Code’s sign-in on this Mac expired')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /Claude account with subscription/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Anthropic Console account/ })).toBeVisible();
  await menu.getByRole('menuitem', { name: /3rd-party platform/ }).hover();
  await expect(page.getByRole('menuitem', { name: 'Amazon Bedrock' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Microsoft Foundry' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Google Vertex AI' })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sign-in-expired.png` });
});
