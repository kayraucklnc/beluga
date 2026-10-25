import { expect, test, type Locator, type Page } from './fixtures.js';
import { expectPicked, pick, popup } from './helpers.js';

/**
 * Earnings from Stripe, against the demo's pretend Stripe (src/core/stripe-demo.ts; no real key,
 * nothing leaves the computer): bob-api starts connected (dollars and euros), landing gets
 * connected here (with a "Lira" key: Turkish lira and rupees).
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

test('the Usage view shows connected projects’ earnings, and a project opens its sheet', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'Usage', exact: true }).click();
  const card = page.getByRole('region', { name: 'Earnings' });
  await expect(card).toBeVisible();
  await expect(card.getByText('all time')).toBeVisible();
  const rows = card.getByRole('list', { name: 'Earnings by project' });
  await expect(rows.getByRole('button', { name: /^bob-api: \$[\d,]+\.\d\d/ })).toBeVisible();
  await rows.getByRole('button', { name: /^bob-api/ }).click();
  await expect(page.getByRole('dialog', { name: 'bob-api earnings' })).toContainText('Bob API, Inc.');
  await page.keyboard.press('Escape');
  await card.getByRole('button', { name: 'Connect Stripe to Another Project…' }).click();
  await expect(page.getByRole('dialog', { name: /Connect Stripe to/ })).toBeVisible();
});

test('connecting Stripe checks the key, then the project shows its earnings; disconnecting forgets them', async ({ page }) => {
  const sheet = await openConnectSheet(page);
  await expect(sheet).toBeVisible();
  await pick(sheet, 'Project', 'landing');
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

test('Connect Stripe… is in every project’s right-click menu, and the amount opens its earnings', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'landing', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect Stripe…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Connect Stripe to landing' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Create a restricted key in Stripe/ })).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();

  // The sidebar's amount steps aside for the row's tools on hover: the project home's opens it.
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  await page.getByRole('main').locator('[data-earnings-pill]').first().click();
  await expect(page.getByRole('dialog', { name: 'bob-api earnings' })).toContainText('Bob API, Inc.');
});

test('a project’s home shows how it’s doing lately: a range, its figures, each day, the latest payments', async ({ page }) => {
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  const section = page.getByRole('main').getByRole('region', { name: 'Earnings' });
  await expect(section).toBeVisible();
  await expect(section.getByText('Bob API, Inc.')).toBeVisible();

  // 30 days at first; each figure against the 30 days before.
  const range = section.getByRole('tablist', { name: 'Range' });
  await expect(range.getByRole('tab', { name: '30 days' })).toHaveAttribute('aria-selected', 'true');
  const figures = section.getByRole('group', { name: 'The last 30 days' });
  await expect(figures.getByRole('group', { name: /^Earned: (≈ )?\$[\d,.]+K?$/ })).toBeVisible();
  await expect(figures.getByRole('group', { name: /^Payments: \d+$/ })).toBeVisible();
  await expect(figures.getByRole('group', { name: /^Paying customers: \d+$/ })).toBeVisible();
  await expect(figures.locator('[data-change]').first()).toBeVisible();
  await expect(section.getByRole('img', { name: 'Earned each day, the last 30 days' }).locator(':scope > *')).toHaveCount(30);

  // Another range: every figure and the chart follow (and it's kept).
  await range.getByRole('tab', { name: '7 days' }).click();
  await expect(section.getByRole('group', { name: 'The last 7 days' })).toBeVisible();
  await expect(section.getByRole('img', { name: 'Earned each day, the last 7 days' }).locator(':scope > *')).toHaveCount(7);

  // The latest payments: a first name and an initial, never more; a few, then all of them.
  const rows = section.getByRole('list', { name: 'Latest payments' }).getByRole('listitem');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText(/^[A-Z]\w+ [A-Z]\./);
  await section.getByRole('button', { name: /^Show All \d+$/ }).click();
  await expect(rows).toHaveCount(25);
  const refunds = section.getByRole('radio', { name: /^Refunds/ });
  if (await refunds.count()) {
    await refunds.click();
    await expect(rows.first()).toHaveAttribute('data-payment', /refunded/);
  }

  // ••• opens the Stripe sheet, which says the last 30 days too.
  await section.getByRole('button', { name: 'Stripe Earnings…' }).click();
  const sheet = page.getByRole('dialog', { name: 'bob-api earnings' });
  await expect(sheet.locator('[data-last-30]')).toHaveText(/^Last 30 days: (≈ )?\$[\d,]+\.\d\d from \d+ payments by \d+ customers$/);
  await page.keyboard.press('Escape');
  await range.getByRole('tab', { name: '30 days' }).click();
});

test('every total shows in one currency you choose, in Settings or the Stripe sheet', async ({ page }) => {
  // landing sells in lira and rupees, bob-api in dollars and euros.
  const sheet = await openConnectSheet(page);
  await pick(sheet, 'Project', 'landing');
  await paste(sheet.getByLabel('Restricted key'), ['rk', 'live', 'landingLiraShop000000'].join('_'));
  await sheet.getByRole('button', { name: 'Connect', exact: true }).click();
  const done = page.getByRole('dialog', { name: 'landing earnings' });
  await expect(done.getByText(/^≈ \$[\d,]+\.\d\d$/)).toBeVisible();
  await expect(done.getByText('In Stripe')).toBeVisible();
  await done.getByRole('button', { name: 'Done' }).last().click();

  // The Usage card: one total, no pile of currencies.
  await sidebar(page).getByRole('button', { name: 'Usage', exact: true }).click();
  const card = page.getByRole('region', { name: 'Earnings' });
  const total = card.locator('[data-earnings-total]');
  await expect(total).toHaveAttribute('data-earnings-total', 'usd');
  await expect(total).toHaveText(/^\$[\d.,]+[KM]?$/);
  await expect(card.getByText(/All time · 2 projects · ECB rates, updated today/)).toBeVisible();
  await expect(card.getByText('+', { exact: false })).toHaveCount(0);
  const rows = card.getByRole('list', { name: 'Earnings by project' });
  await expect(rows.getByRole('button', { name: /^landing: \$[\d,]+\.\d\d, \d+% of the total$/ })).toBeVisible();

  // Settings › General › Show earnings in: euros, everywhere at once.
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expectPicked(popup(settings, 'Show earnings in'), '');
  await expect(popup(settings, 'Show earnings in')).toHaveText(/Automatic \(USD\)/);
  await pick(settings, 'Show earnings in', /^EUR/);
  await expectPicked(popup(settings, 'Show earnings in'), 'eur');
  await page.keyboard.press('Escape');
  await expect(total).toHaveAttribute('data-earnings-total', 'eur');
  await expect(total).toHaveText(/^€[\d.,]+[KM]?$/);
  await expect(rows.getByRole('button', { name: /^bob-api: €[\d,]+\.\d\d/ })).toBeVisible();
  await expect(rows.getByRole('button', { name: /^landing: €[\d,]+\.\d\d/ })).toBeVisible();
  await expect(page.locator('[data-earnings-pill]').first()).toHaveText(/€/);

  // The Stripe sheet has the same choice: lira.
  await rows.getByRole('button', { name: /^landing/ }).click();
  const landing = page.getByRole('dialog', { name: 'landing earnings' });
  await pick(landing, 'Show earnings in', /^TRY/);
  await expect(landing.getByText(/^≈ ₺[\d,]+\.\d\d$/)).toBeVisible();
  await landing.getByRole('button', { name: 'Done' }).last().click();
  await expect(total).toHaveText(/^₺[\d.,]+[KM]?$/);

  // Back to automatic, and landing disconnected (the daemon is shared by every test).
  await page.keyboard.press('Meta+,');
  await pick(settings, 'Show earnings in', /^Automatic/);
  await page.keyboard.press('Escape');
  await expect(total).toHaveAttribute('data-earnings-total', 'usd');
  await rows.getByRole('button', { name: /^landing/ }).click();
  await page.getByRole('dialog', { name: 'landing earnings' }).getByRole('button', { name: 'Disconnect…' }).click();
  await page.getByRole('alertdialog', { name: 'Disconnect Stripe from landing?' }).getByRole('button', { name: 'Disconnect' }).click();
  await expect(rows.getByRole('button', { name: /^landing/ })).toBeHidden();
});
