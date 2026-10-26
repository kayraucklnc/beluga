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
  // The demo's run going now is the recorded one: nothing caught up, nothing failed.
  await expect(main(page).getByRole('row', { name: /^Watch the web/ })).toContainText('Running');
  await expect(main(page).getByRole('row', { name: /^Watch the web/ })).not.toContainText('Failed');
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
  // A week of runs, as seeded (the demo's start catches nothing up).
  await expect(history.locator('[data-run]')).toHaveCount(7);
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
  await expect(decide).toHaveCount(0);
  await shoot(page, 'merge-done');
});

test('phase 2’s steps on a page: a service with its preset, and a merge that asks before it stops asking', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^Watch the web/ }).click();
  const steps = main(page).getByRole('region', { name: 'Steps' });
  await expect(steps.locator('[data-step="http"]')).toContainText('Groqbot: POST api.groqbot.example');
  await steps.locator('[data-step="http"]').getByRole('button', { name: 'Show its fields' }).click();
  await expect(steps.getByRole('textbox', { name: 'URL' })).toHaveValue('https://api.groqbot.example/search');
  await expect(steps.getByRole('textbox', { name: 'Header 1’s value' })).toHaveValue('Bearer $GROQBOT_KEY');
  await expect(steps).toContainText('$VAR from Settings › Environment; headers never show in reports');
  await shoot(page, 'http-step');

  await openList(page);
  await main(page).getByRole('row', { name: /^Fix what broke/ }).click();
  await expect(main(page).getByRole('complementary', { name: 'Properties' })).toContainText('merge when the checks pass and you’ve approved');
  const merge = main(page).getByRole('region', { name: 'Steps' }).locator('[data-step="merge"]');
  await merge.getByRole('button', { name: 'Show its fields' }).click();
  await merge.getByRole('checkbox', { name: /Ask me before merging/ }).click();
  const alert = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: 'Merge without asking?' }));
  await expect(alert).toContainText('Merge without asking?');
  await alert.getByRole('button', { name: 'Merge Without Asking' }).click();
  await expect(merge).toContainText('Merges by itself when the checks pass');
  await expect(main(page).getByRole('complementary', { name: 'Properties' })).toContainText('merge by itself when the checks pass');
});

test('Describe it: Claude writes the sentinel, the page shows it working, then its answer', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('button', { name: 'New Sentinel' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'New Sentinel' });
  await expect(sheet.getByRole('tab', { name: /Describe it/ })).toHaveAttribute('aria-selected', 'true');
  await sheet.getByRole('combobox', { name: 'Where it works' }).click();
  await page.getByRole('option', { name: 'bob-api' }).click();
  await sheet.getByRole('textbox', { name: 'What should it do?' }).fill('Every weekday at 8, read yesterday’s commits and open issues, write me a brief, and make tasks for anything urgent');
  await sheet.getByRole('button', { name: 'Write It' }).click();
  await expect(main(page).locator('[data-sentinel-page]')).toBeVisible();
  const box = main(page).getByTestId('sentinel-ask');
  await expect(box).toContainText('Claude is writing…');
  await expect(box).toContainText('Set it up: every weekday at 8:00', { timeout: 30_000 });
  await expect(main(page).getByTestId('sentinel-sentence')).toHaveText('Every weekday at 8:00');
  await expect(main(page).getByRole('region', { name: 'Steps' }).getByRole('textbox', { name: 'Step 1’s name' })).toHaveValue('Read what changed');
  await expect(main(page).getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Read yesterday’s commits');
  // It starts paused: Turn On is the main button.
  await expect(main(page).getByRole('button', { name: 'Turn On' }).first()).toBeVisible();
  await expect(box.getByRole('button', { name: 'Open Chat' })).toBeVisible();
  await shoot(page, 'page-ask');
});
