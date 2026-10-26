import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Sentinel (docs/sentinel.md §3) on the demo's four sentinels: the list, Morning brief's page and
 * Run Now, a run's page with its report, and the merge waiting on Fix what broke. Screenshots in
 * light and dark go to .beluga/scratch/sentinel-*.png.
 */

const shots = path.join(import.meta.dirname, '..', '..', '..', '.beluga', 'scratch');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');

async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(shots, `sentinel-${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function openList(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: /^Sentinel/ }).click();
  await expect(main(page).locator('[data-sentinel]').first()).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });

test('the list shows the demo’s sentinels, grouped by project, with their last runs', async ({ page }) => {
  await openList(page);
  const rows = main(page).locator('[data-sentinel]');
  await expect(rows).toHaveCount(4);
  await expect(main(page).getByRole('row', { name: /^Morning brief, Every day at 7:00/ })).toContainText('Done');
  await expect(main(page).getByRole('row', { name: /^Nightly tests/ })).toContainText('Paused after 3 failures in a row');
  await expect(main(page).getByRole('row', { name: /^Fix what broke/ })).toContainText('Needs you');
  await page.getByRole('tab', { name: /Paused/ }).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole('tab', { name: /^All/ }).click();
  await expect(rows).toHaveCount(4);
  await shoot(page, 'list');
});

test('Morning brief’s page: When, Steps, Properties, History; Run Now starts a run', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^Morning brief/ }).click();
  await expect(main(page).getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Morning brief');
  await expect(main(page).getByTestId('sentinel-sentence')).toHaveText('Every day at 7:00');
  const steps = main(page).getByRole('region', { name: 'Steps' });
  await expect(steps.getByRole('textbox', { name: 'Step 1’s name' })).toHaveValue('Read what changed');
  // A step unfolds its fields: the presets over the prompt.
  await steps.getByRole('button', { name: 'Show its fields' }).first().click();
  await expect(steps.getByRole('button', { name: 'Write a brief of what changed' })).toBeVisible();
  await expect(main(page).getByRole('complementary', { name: 'Properties' })).toContainText('Claude can look and tell you');
  const history = main(page).getByRole('region', { name: 'History' });
  // A week of runs (and perhaps today's, caught up when the demo started).
  await expect.poll(() => history.locator('[data-run]').count()).toBeGreaterThanOrEqual(7);
  await shoot(page, 'page');
  const before = await history.locator('[data-run]').count();
  await main(page).getByRole('button', { name: 'Run Now' }).click();
  await expect(history.locator('[data-run]')).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(history.locator('[data-run]').first()).toContainText('you');
});

test('a run’s page: the line, the steps, the report', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^Morning brief/ }).click();
  await main(page).getByRole('region', { name: 'History' }).locator('[data-run]').filter({ hasText: 'schedule' }).filter({ hasText: 'Done' }).first().click();
  await expect(main(page).locator('[data-run-page]')).toBeVisible();
  await expect(main(page).getByText(/^Morning brief · ran by schedule · .+ · .+ s$/)).toBeVisible();
  await expect(main(page).getByRole('region', { name: 'Report' })).toBeVisible();
  await main(page).getByRole('button', { name: 'Show output' }).first().click();
  await shoot(page, 'run');
});

test('a run that waits for you: Merge', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^Fix what broke/ }).click();
  await main(page).getByRole('region', { name: 'History' }).locator('[data-run]').filter({ hasText: 'Needs you' }).first().click();
  const decide = main(page).getByTestId('sentinel-decide');
  await expect(decide).toContainText('Pull request #53 waits for you');
  await shoot(page, 'merge');
  await decide.getByRole('button', { name: 'Merge' }).click();
  await expect(main(page).getByRole('heading', { name: 'Merged #53' })).toBeVisible();
});
