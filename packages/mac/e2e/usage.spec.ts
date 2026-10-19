import { expect, test, type Locator, type Page } from '@playwright/test';

/** The Usage view against the demo: plan meters, this week, disk by project, sorting, and putting things away. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const breakdown = (page: Page) => page.getByRole('table', { name: 'Disk and Claude usage by workspace' });

/** "661k" / "1.0M" / "950" → a number, to check an order. */
const count = (text: string): number => {
  const m = /([\d.]+)\s*([kM]?)/.exec(text);
  if (!m) return 0;
  return Number(m[1]) * (m[2] === 'M' ? 1_000_000 : m[2] === 'k' ? 1000 : 1);
};
/** "28 KB" / "1.2 GB" → bytes. */
const bytes = (text: string): number => {
  const m = /([\d.]+)\s*(B|KB|MB|GB|TB)/.exec(text);
  if (!m) return 0;
  return Number(m[1]) * 1024 ** ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(m[2]!);
};
const descending = (xs: readonly number[]): boolean => xs.every((x, i) => i === 0 || xs[i - 1]! >= x);

/** The Claude cell (third) of each worktree row in a project's group, as token counts. */
async function tokensIn(group: Locator): Promise<number[]> {
  const rows = group.locator('[role=row][aria-label]');
  const cells = await rows.evaluateAll((els) => els.map((el) => el.children[2]?.textContent ?? ''));
  return cells.map(count);
}

async function openUsage(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Usage', exact: true }).click();
  await expect(page.getByText('in worktrees')).toBeVisible();
}

test('shows your plan, this week, and disk space by project', async ({ page }) => {
  await openUsage(page);
  await expect(page.getByRole('meter', { name: /5-hour: \d+% used/ })).toBeVisible();
  await expect(page.getByRole('meter', { name: /Weekly: \d+% used/ })).toBeVisible();
  // Friends' windows, compact.
  await expect(page.getByRole('list', { name: 'Friends’ Claude usage' }).getByRole('meter', { name: /^bob: 5-hour/ })).toBeVisible();
  // A bar a day, this week's tokens and cost on top.
  await expect(page.getByRole('list', { name: 'Claude tokens per day' }).getByRole('listitem')).toHaveCount(14);
  // Disk by project: a segment per project, and its legend jumps to the project's rows.
  const stack = page.getByRole('group', { name: 'Disk space by project' });
  await expect(stack.getByRole('button', { name: /^bob-api: / })).toBeVisible();
  await expect(breakdown(page).getByRole('rowheader', { name: /bob-api/ })).toBeVisible();
});

test('sorts the breakdown by size, tokens or recent, and remembers it', async ({ page }) => {
  await openUsage(page);
  const sort = page.getByRole('tablist', { name: 'Sort by' });
  await expect(sort.getByRole('tab', { name: 'Size' })).toHaveAttribute('aria-selected', 'true');
  // Projects: biggest on disk first.
  const heads = breakdown(page).getByRole('rowheader');
  await expect(heads.first()).toBeVisible();
  const disks = await breakdown(page).getByRole('rowgroup').evaluateAll((groups) => groups.map((g) => g.querySelector('[role=row]')?.children[1]?.textContent ?? ''));
  expect(descending(disks.map(bytes))).toBe(true);

  await sort.getByRole('tab', { name: 'Tokens' }).click();
  await expect(sort.getByRole('tab', { name: 'Tokens' })).toHaveAttribute('aria-selected', 'true');
  const api = breakdown(page).getByRole('rowgroup').filter({ has: page.getByRole('rowheader', { name: /bob-api/ }) });
  // The main folder stays first; the worktrees and chats follow, most tokens first.
  const tokens = (await tokensIn(api)).slice(1);
  expect(tokens.length).toBeGreaterThan(1);
  expect(descending(tokens)).toBe(true);

  await page.reload();
  await sidebar(page).getByRole('button', { name: 'Usage', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Sort by' }).getByRole('tab', { name: 'Tokens' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tablist', { name: 'Sort by' }).getByRole('tab', { name: 'Recent' }).click();
  await expect(page.getByRole('tablist', { name: 'Sort by' }).getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tablist', { name: 'Sort by' }).getByRole('tab', { name: 'Size' }).click();
});

test('Archive on a row asks first, and Cancel keeps the worktree', async ({ page }) => {
  await openUsage(page);
  const row = breakdown(page).getByRole('row', { name: 'add-auth', exact: true });
  await row.hover();
  await row.getByRole('button', { name: 'Archive add-auth…' }).click();
  const alert = page.getByRole('alertdialog', { name: /Archive “add-auth”\?/ });
  await expect(alert).toBeVisible();
  await expect(alert.getByText(/branch .* and the conversation are kept/)).toBeVisible();
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(alert).toBeHidden();
  await expect(row).toBeVisible();
});

test('Free up space lists what is safe to put away, and cleans it up after asking', async ({ page }) => {
  await openUsage(page);
  const card = page.getByRole('region', { name: 'Free up space' });
  await expect(card.getByRole('heading', { name: /^Free up / })).toBeVisible();
  await card.getByRole('button', { name: 'Clean Up…' }).click();
  const alert = page.getByRole('alertdialog');
  await expect(alert.getByRole('cell', { name: /sub-agent worktrees/ })).toBeVisible();
  // Cancel first: nothing happens.
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Clean Up…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^(Remove|Clean Up|Archive)$/ }).click();
  await expect(page.getByText(/Removed \d+ finished agent worktree/)).toBeVisible();
  await expect(card).toBeHidden({ timeout: 15_000 });
});
