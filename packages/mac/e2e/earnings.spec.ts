import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Earnings from Stripe, against the demo's pretend Stripe (src/core/stripe-demo.ts; no real key,
 * nothing leaves the computer): bob-api starts connected, landing gets connected here.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });

async function paste(field: Locator, text: string): Promise<void> {
  await field.focus();
  await field.evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData('text', value);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

async function openConnectSheet(page: Page): Promise<Locator> {
  await page.keyboard.press('Meta+K');
  await page.keyboard.type('Connect Stripe');
  await page.keyboard.press('Enter');
  return page.getByRole('dialog', { name: /Connect Stripe to/ });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('the Overview shows what connected projects earned', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'Overview' }).first().click();
  const card = page.getByRole('region', { name: 'Earnings' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: /bob-api/ })).toContainText(/\$\d/);
  await expect(page.locator('[data-earnings-pill]').first()).toBeVisible();
});

test('connecting Stripe checks the key, then the project shows its earnings; disconnecting forgets them', async ({ page }) => {
  const sheet = await openConnectSheet(page);
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('Project').selectOption({ label: 'landing' });
  await expect(sheet.getByRole('heading', { name: 'Connect Stripe to landing' })).toBeVisible();
  const key = sheet.getByLabel('Restricted key');
  const connect = sheet.getByRole('button', { name: 'Connect', exact: true });

  // Checked as you paste, before anything is sent.
  await paste(key, 'pk_live_51abcdefghijklmnopqrstu');
  await expect(sheet.getByText(/publishable key/)).toBeVisible();
  await expect(connect).toBeDisabled();

  // Stripe refuses it, or it can't read charges: said in the sheet, which stays open.
  await key.fill(['rk', 'test', 'revokedKey000000000000'].join('_'));
  await connect.click();
  await expect(sheet.getByRole('alert')).toContainText('Stripe doesn’t know this key');
  await key.fill(['rk', 'test', 'nochargesKey0000000000'].join('_'));
  await connect.click();
  await expect(sheet.getByRole('alert')).toContainText('set Charges to Read');

  // A good one: test mode said right away, then the account and the total.
  await key.fill('');
  await paste(key, ['rk', 'test', 'landingShop00000000000'].join('_'));
  await expect(sheet.getByText('Test', { exact: true })).toBeVisible();
  await expect(sheet.getByText('Pasted. Connect checks it with Stripe.')).toBeVisible();
  await connect.click();
  const done = page.getByRole('dialog', { name: 'landing earnings' });
  await expect(done).toBeVisible();
  await expect(done.getByText('Demo Shop (test)')).toBeVisible();
  await expect(done.getByText(/\$[\d,]+\.\d\d/).first()).toBeVisible();
  await done.getByRole('button', { name: 'Done' }).last().click();
  await expect(done).toBeHidden();

  // It shows in the Overview (and beside the project in the sidebar).
  await sidebar(page).getByRole('button', { name: 'Overview' }).first().click();
  const card = page.getByRole('region', { name: 'Earnings' });
  await expect(card.getByRole('button', { name: /landing/ })).toContainText(/\$\d/);
  const pills = page.locator('[data-earnings-pill]');
  await expect(pills).toHaveCount(2);

  // Disconnect, after an alert.
  await card.getByRole('button', { name: /landing/ }).click();
  await page.getByRole('dialog', { name: 'landing earnings' }).getByRole('button', { name: 'Disconnect…' }).click();
  const alert = page.getByRole('alertdialog', { name: 'Disconnect Stripe from landing?' });
  await alert.getByRole('button', { name: 'Disconnect' }).click();
  await expect(alert).toBeHidden();
  await expect(card.getByRole('button', { name: /landing/ })).toBeHidden();
  await expect(pills).toHaveCount(1);
});

test('Connect Stripe… is in every project’s right-click menu, and the pill opens its earnings', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: /^landing New worktree/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect Stripe…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Connect Stripe to landing' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Create a restricted key in Stripe/ })).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();

  await sidebar(page).locator('[data-earnings-pill]').first().click();
  await expect(page.getByRole('dialog', { name: 'bob-api earnings' })).toContainText('Bob API, Inc.');
});
