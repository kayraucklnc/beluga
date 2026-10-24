import { expect, test, type Page } from './fixtures.js';

/** Sync with Linear (BLG-74): connect a key and a team in the demo's pretend Linear, its issues come over, and the sheet says how it syncs. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const SHOTS = process.env.TASK_SYNC_SHOTS;
const KEY = `lin_api_${'d'.repeat(40)}`;

test('connects a project to Linear and brings its issues over', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: /^Tasks/ }).click();
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeVisible();
  await page.getByRole('button', { name: 'Tasks Options' }).click();
  await page.getByRole('menuitem', { name: 'Sync with Linear…' }).click();

  const sheet = page.getByRole('dialog', { name: /^Sync .+ with Linear$/ });
  await expect(sheet).toBeVisible();
  // A key of the wrong shape is caught before anything goes out.
  await sheet.getByLabel('API key').fill('lin_oauth_nope');
  await sheet.getByLabel('API key').blur();
  await expect(sheet.getByText('That’s an OAuth token')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Check Key' })).toBeDisabled();

  await sheet.getByLabel('API key').fill(KEY);
  if (SHOTS) await sheet.screenshot({ path: `${SHOTS}/01-sync-sheet-key.png` });
  await sheet.getByRole('button', { name: 'Check Key' }).click();
  await expect(sheet.getByText('Checked: Acme.')).toBeVisible();
  await expect(sheet.getByRole('checkbox', { name: /Autosync/ })).toBeChecked();
  if (SHOTS) await sheet.screenshot({ path: `${SHOTS}/02-sync-sheet-team.png` });
  await sheet.getByRole('button', { name: 'Connect' }).click();

  const connected = page.getByRole('dialog', { name: /syncs with Linear$/ });
  await expect(connected).toContainText('Engineering');
  await expect(connected).toContainText('2 tasks linked');
  await expect(connected).toContainText(/Synced just now/);
  if (SHOTS) await connected.screenshot({ path: `${SHOTS}/03-sync-sheet-connected.png` });
  await connected.getByRole('button', { name: 'Done' }).click();

  // Its issues are tasks now, and the bar says how it syncs.
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  const list = page.getByRole('grid', { name: 'Tasks' });
  await expect(list.getByRole('row', { name: /Rate-limit the public API/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Linear · / })).toBeVisible();
  if (SHOTS) {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${SHOTS}/04-tasks-with-linear.png` });
  }

  // A task's page links to its issue there.
  await list.getByRole('row', { name: /Rate-limit the public API/ }).click();
  const props = page.getByRole('complementary', { name: 'Properties' });
  await expect(props.getByRole('button', { name: /ENG-\d+/ })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/05-task-page-link.png` });
});
