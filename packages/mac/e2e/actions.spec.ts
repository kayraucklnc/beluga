import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * GitHub Actions: the demo's pretend runs (acme/bob-api) on a project's home, live; a run's page
 * with its workflow as a graph and its jobs and steps; a failed job's log; and Actions'
 * Workflows, each file drawn as a graph.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');
/** Screenshots for the task's proof (BELUGA_SHOTS: a folder), skipped otherwise. */
const shot = async (page: Page, name: string): Promise<void> => {
  if (process.env.BELUGA_SHOTS) await page.screenshot({ path: path.join(process.env.BELUGA_SHOTS, name) });
};

async function openHome(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('a project’s home shows its latest runs, the running one first and live', async ({ page }) => {
  await openHome(page);
  const section = main(page).getByRole('region', { name: 'Actions' });
  await expect(section).toBeVisible();
  const first = section.locator('[data-run]').first();
  await expect(first).toContainText('Retry webhooks once after a timeout');
  await expect(first.getByRole('img', { name: /Running|Queued/ })).toBeVisible();
  await expect(section.getByText(/running · live/)).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await shot(page, '01-home-actions.png');
});

test('a run’s page: the workflow as a graph, its jobs and steps, and where a failed one failed', async ({ page }) => {
  await openHome(page);
  await main(page).locator('[data-run="9102"]').click();
  await expect(main(page).getByRole('heading', { name: 'Read-only API keys' })).toBeVisible();
  await expect(main(page).getByText('Failed').first()).toBeVisible();
  // The graph: what starts it and its jobs.
  await expect(main(page).getByRole('figure', { name: 'Graph: CI' })).toBeVisible();
  await expect(main(page).locator('.react-flow__node').first()).toBeVisible({ timeout: 20_000 });
  // The failed job is open, with its steps; the log is a click away.
  const failed = main(page).locator('[data-job="test (macos-latest, 20)"]');
  await expect(failed.getByText('Unit tests')).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Re-run Failed Jobs' })).toBeVisible();
  await page.mouse.move(5, 890);
  await shot(page, '02-run-failed.png');
  await failed.getByRole('button', { name: 'Show Where It Failed' }).click();
  await expect(failed.getByText('expected 201 to be 403')).toBeVisible();
  await failed.scrollIntoViewIfNeeded();
  await shot(page, '02b-run-log.png');
  // Re-running it starts it again, live.
  await main(page).getByRole('button', { name: 'Re-run Failed Jobs' }).click();
  await expect(main(page).getByRole('button', { name: 'Cancel Run' })).toBeVisible({ timeout: 15_000 });
  await page.mouse.move(5, 890);
  await expect(main(page).locator('.react-flow__node').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(5_000);
  await shot(page, '03-run-live.png');
});

test('Actions: every run, and each workflow drawn as a graph', async ({ page }) => {
  await openHome(page);
  await main(page).getByRole('button', { name: 'Show All Runs' }).click();
  await expect(page.getByRole('button', { name: 'Project: bob-api' })).toBeVisible();
  await expect(main(page).locator('[data-run]')).toHaveCount(5);
  await shot(page, '04-actions-runs.png');
  await page.getByRole('tab', { name: 'Workflows' }).click();
  await expect(main(page).getByRole('region', { name: 'CI' })).toBeVisible();
  await expect(main(page).getByRole('figure', { name: 'Graph: CI' })).toBeVisible();
  await expect(main(page).getByRole('figure', { name: 'Graph: Nightly' })).toBeVisible();
  await page.waitForTimeout(1_500);
  await shot(page, '05-actions-workflows.png');
});
