import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Sentinel as one page (BLG-300): what needs you, the board at a glance, every sentinel as a row
 * that leads with what it found; the project dropdown and Find; the Sentinel chat as a panel beside
 * the page (Ask Claude); a tile resized by its corner; and, with every sentinel gone, the first
 * visit's composer, how it works and its starting points. Screenshots in light and dark go to
 * .beluga/scratch/home-*.png.
 */

const shots = path.join(import.meta.dirname, '..', '..', '..', '.beluga', 'scratch');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');

async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout((await page.locator('.recharts-surface').count()) ? 1600 : 150);
    await page.screenshot({ path: path.join(shots, `home-${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function openSentinel(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: /^Sentinel/ }).click();
  await expect(main(page).locator('[data-sentinel]').first()).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });

test('one page: Needs you, At a glance and Watching, no tabs', async ({ page }) => {
  await openSentinel(page);
  await expect(main(page).getByRole('tablist', { name: 'Sentinel' })).toHaveCount(0);
  const needs = main(page).getByRole('region', { name: 'Needs you' });
  await expect(needs.locator('[data-kind="merge"]')).toContainText('Fix what broke');
  await expect(needs.locator('[data-kind="merge"]').getByRole('button', { name: 'Merge', exact: true })).toBeVisible();
  await expect(needs.locator('[data-kind="failing"]')).toContainText('Nightly tests');
  const glance = main(page).getByRole('region', { name: 'At a glance' });
  await expect(glance.locator('[data-tile]').first()).toBeVisible();
  await expect(glance.getByRole('button', { name: 'Board: Overview' })).toBeVisible();
  const watching = main(page).getByRole('region', { name: 'Watching' });
  await expect(watching.locator('[data-sentinel]')).toHaveCount(11);
  // The row leads with what it found.
  await expect(watching.getByRole('row', { name: /^Stripe revenue/ })).toContainText('$3,412');
  await shoot(page, 'page');
});

test('the project dropdown lists only projects with sentinels; Find filters', async ({ page }) => {
  await openSentinel(page);
  await main(page).getByRole('button', { name: /^Project: All projects/ }).click();
  const menu = page.getByRole('menu', { name: 'Project' });
  await expect(menu.getByRole('menuitemcheckbox').or(menu.getByRole('menuitem'))).toHaveCount(4);
  await menu.getByText('landing').click();
  const watching = main(page).getByRole('region', { name: 'Watching' });
  await expect(watching.locator('[data-sentinel]')).toHaveCount(3);
  await main(page).getByRole('button', { name: /^Project: landing/ }).click();
  await page.getByRole('menu', { name: 'Project' }).getByText('All projects').click();
  await main(page).getByRole('textbox', { name: 'Find a sentinel' }).fill('brief');
  await expect(watching.locator('[data-sentinel]')).toHaveCount(1);
  await expect(main(page).getByRole('region', { name: 'At a glance' })).toHaveCount(0);
});

test('Ask Claude opens the Sentinel chat beside the page; × closes it', async ({ page }) => {
  await openSentinel(page);
  await main(page).getByRole('button', { name: 'Ask Claude' }).click();
  const panel = main(page).getByRole('complementary', { name: 'Ask Sentinel' });
  await expect(panel.locator('[data-sentinel-chat]')).toContainText('What did my sentinels find this week?');
  // The page stays beside it.
  await expect(main(page).getByRole('region', { name: 'Watching' })).toBeVisible();
  await shoot(page, 'ask');
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  // ⌘K › Go to Sentinel Chat opens the panel too.
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('Go to Sentinel Chat');
  await page.keyboard.press('Enter');
  await expect(main(page).getByRole('complementary', { name: 'Ask Sentinel' })).toBeVisible();
});

test('asking about one sentinel opens the chat beside its page, naming it', async ({ page }) => {
  await openSentinel(page);
  await main(page).getByRole('row', { name: /^Morning brief/ }).click();
  await main(page).getByRole('textbox', { name: 'Ask Claude about this sentinel' }).fill('Make it weekly on Mondays');
  await main(page).getByRole('textbox', { name: 'Ask Claude about this sentinel' }).press('Enter');
  const panel = main(page).getByRole('complementary', { name: 'Ask Sentinel' });
  await expect(panel).toContainText('Make it weekly on Mondays');
  await expect(panel).toContainText('Morning brief');
  // The sentinel's page stays beside it.
  await expect(main(page).getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Morning brief');
  await shoot(page, 'page-ask');
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await expect(main(page).getByRole('complementary', { name: 'Properties' })).toBeVisible();
});

test('a tile is resized by dragging its corner', async ({ page }) => {
  await openSentinel(page);
  const glance = main(page).getByRole('region', { name: 'At a glance' });
  const tile = glance.locator('[data-tile][data-kind="number"]').first();
  await expect(tile).toHaveAttribute('data-w', '1');
  await tile.hover();
  const corner = tile.locator('[data-resize]');
  const box = (await corner.boundingBox())!;
  const tileBox = (await tile.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + tileBox.width * 1.1, box.y + 4, { steps: 6 });
  await expect(tile).toHaveAttribute('data-sizing', '');
  await page.mouse.up();
  await expect(tile).toHaveAttribute('data-w', '2');
  // Bigger still, a number shows how it got here.
  await tile.hover();
  const again = (await tile.locator('[data-resize]').boundingBox())!;
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(again.x + tileBox.width * 1.2, again.y + 4, { steps: 6 });
  await page.mouse.up();
  await expect(tile).toHaveAttribute('data-w', '3');
  // Wide, the number has its chart beside it; the sparkline steps aside.
  await expect(tile.locator('[data-look="chart"] .recharts-surface')).toBeVisible();
  await shoot(page, 'resized');
});

test('what came back: each sentinel’s latest run as a message; tiles say where they come from', async ({ page }) => {
  await openSentinel(page);
  const feed = main(page).getByRole('feed', { name: 'What came back' });
  await expect(feed.locator('article')).toHaveCount(6);
  await feed.getByRole('button', { name: /^Show \d+ more$/ }).click();
  await expect(feed.locator('article')).toHaveCount(11);
  await expect(feed.locator('article').filter({ hasText: 'Morning brief' })).toContainText('3 commits landed');
  // A board that mixes projects marks each tile with its project.
  const glance = main(page).getByRole('region', { name: 'At a glance' });
  await expect(glance.locator('[data-tile][data-kind="number"]').first().getByLabel(/^From /)).toBeVisible();
  // Each tile carries its project's colour; Tint in its ⋯ changes it for the project's tiles.
  const revenue = glance.locator('[data-tile][data-kind="number"]').filter({ hasText: 'Revenue' }).first();
  await expect(revenue).toHaveAttribute('data-tinted', '');
  await revenue.hover();
  await revenue.getByRole('button', { name: /^More for / }).click();
  await page.getByRole('menuitem', { name: /^Tint/ }).focus();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('menuitem', { name: 'None' }).focus();
  await page.keyboard.press('Enter');
  await expect(revenue).not.toHaveAttribute('data-tinted', '');
  await revenue.hover();
  await revenue.getByRole('button', { name: /^More for / }).click();
  await page.getByRole('menuitem', { name: /^Tint/ }).focus();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('menuitem', { name: 'From its icon' }).focus();
  await page.keyboard.press('Enter');
  await expect(revenue).toHaveAttribute('data-tinted', '');
  await shoot(page, 'tinted');
  await glance.getByRole('article').first().scrollIntoViewIfNeeded();
  await shoot(page, 'came-back');
  // Picking a project shows its tiles and its messages only.
  await main(page).getByRole('button', { name: /^Project: All projects/ }).click();
  await page.getByRole('menu', { name: 'Project' }).getByText('landing').click();
  await expect(feed.locator('article').filter({ hasText: 'Morning brief' })).toHaveCount(0);
  await expect(glance.locator('[data-tile]').filter({ hasText: 'Revenue' })).toHaveCount(0);
});

test('with nothing set up: what to ask, how it works, starting points', async ({ page }) => {
  await openSentinel(page);
  const rows = main(page).locator('[data-sentinel]');
  // Delete every sentinel, one by one, from its row's menu.
  for (let left = await rows.count(); left > 0; left = await rows.count()) {
    await rows.first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await page.getByRole('button', { name: 'Delete Sentinel' }).click();
    await expect(rows).toHaveCount(left - 1, { timeout: 10_000 });
  }
  const first = main(page).getByTestId('sentinel-first');
  await expect(first).toContainText('What should Beluga keep an eye on?');
  await expect(first.getByRole('region', { name: 'How a sentinel works' }).or(first.locator('[aria-label="How a sentinel works"]'))).toContainText('You get');
  await expect(first.getByRole('list', { name: 'Tell me' }).getByRole('listitem').first()).toBeVisible();
  await expect(first.getByRole('list', { name: 'Keep a number' })).toContainText('Stripe revenue');
  await shoot(page, 'first');
  // The composer asks Claude in the panel beside the page.
  await first.getByRole('textbox', { name: 'What should Beluga keep an eye on?' }).fill('Every morning, tell me what changed in bob-api');
  await first.getByRole('button', { name: 'Ask Claude' }).click();
  const panel = main(page).getByRole('complementary', { name: 'Ask Sentinel' });
  await expect(panel).toContainText('Every morning, tell me what changed in bob-api');
  // A starting point is made paused and opened.
  await panel.getByRole('button', { name: 'Close' }).click();
  await first.locator('[data-recipe="morning-brief"]').click();
  await expect(main(page).getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Morning brief');
});
