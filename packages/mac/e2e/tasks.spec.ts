import { expect, test, type Page } from '@playwright/test';

/** Tasks (docs/tasks-and-plans.md): the demo's board, a new task, a task's page, the board and the graph, and a worktree's task. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');

async function openTasks(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: /^Tasks/ }).click();
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('lists the demo’s tasks by status; scopes and the board', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  const list = page.getByRole('grid', { name: 'Tasks' });
  await expect(list.getByRole('region', { name: 'In Review' })).toBeVisible();
  await expect(list.getByRole('row', { name: /Add auth to the payment routes, In Review/ })).toBeVisible();
  await expect(list.getByRole('row', { name: /Refund endpoint/ })).toContainText('Blocked by');
  // The board: a column per status.
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'Board' }).click();
  const board = page.getByRole('list', { name: 'Board' });
  await expect(board.getByRole('listitem', { name: /^In Progress/ })).toContainText('Idempotent webhook retries');
  // What waits on what.
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'What Waits on What' }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  await expect(main(page).locator('.react-flow__node').filter({ hasText: 'Refund endpoint' })).toContainText('Blocked');
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'List' }).click();
});

test('makes a task, then works on its page', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('button', { name: 'New Task', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New Task' });
  await sheet.getByLabel('Title').fill('Cache the exchange rates');
  await sheet.getByLabel('Goal').fill('Fetch once an hour instead of on every request.');
  await sheet.getByRole('button', { name: 'Create Task' }).click();
  await expect(sheet).toBeHidden();
  const row = page.getByRole('row', { name: /Cache the exchange rates, Todo/ });
  await expect(row).toBeVisible();
  await row.click();

  // Its page: the goal from the sheet, its properties.
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Cache the exchange rates');
  await expect(page.getByRole('region', { name: 'Goal' })).toContainText('Fetch once an hour');
  const props = page.getByRole('complementary', { name: 'Properties' });

  // Status from its menu (2 = Todo, 3 = In Progress).
  await props.getByRole('button', { name: /^Todo$/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /In Progress/ }).click();
  await expect(props).toContainText('In Progress');

  // Rename in place.
  const title = page.getByRole('textbox', { name: 'Title' });
  await title.fill('Cache exchange rates for an hour');
  await title.press('Enter');
  await expect(page.getByRole('region', { name: 'Activity' })).toContainText('renamed this to “Cache exchange rates for an hour”');

  // Acceptance criteria: written, then ticked.
  await page.getByRole('button', { name: 'Acceptance criteria' }).click();
  const area = page.getByRole('textbox', { name: 'Acceptance criteria' });
  await area.fill('- [ ] Rates are at most an hour old\n- [ ] One request an hour');
  await area.press('Meta+Enter');
  const criteria = page.getByRole('region', { name: 'Acceptance criteria' });
  await criteria.getByRole('checkbox').first().click();
  await expect(criteria).toContainText('1 of 2');

  // A sub-task, and a comment.
  const subs = page.getByRole('region', { name: 'Sub-tasks' });
  await subs.getByLabel('New sub-task').fill('Pick a cache TTL');
  await subs.getByLabel('New sub-task').press('Enter');
  await expect(subs.getByRole('button', { name: /Pick a cache TTL/ })).toBeVisible();
  await page.getByLabel('Comment').fill('ECB updates once a day anyway.');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Activity' })).toContainText('ECB updates once a day anyway.');
});

test('a worktree shows the task it’s doing, and opens it', async ({ page }) => {
  await page.goto('/');
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name: 'new-hero', exact: true }).click();
  const strip = page.getByRole('button', { name: /New hero for the launch/ }).first();
  await expect(strip).toBeVisible();
  await strip.click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('New hero for the launch');
  await expect(page.getByRole('button', { name: 'Open Worktree' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Proof' })).toContainText('Hero, desktop');
});

test('a narrow window: the bar wraps and New Task stays in reach; a task’s properties go on top', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  await openTasks(page);
  await page.getByRole('button', { name: 'New Task', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New Task' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('row', { name: /Add auth to the payment routes/ }).first().click();
  const props = page.getByRole('complementary', { name: 'Properties' });
  const title = page.getByRole('textbox', { name: 'Title' });
  // Stacked: the properties above the title, both within the column.
  expect((await props.boundingBox())!.y).toBeLessThan((await title.boundingBox())!.y);
  await expect(props.getByRole('button', { name: /In Review/ })).toBeInViewport();
});

test('Tasks is one project at a time: the one you came from, and the switcher changes it', async ({ page }) => {
  await page.goto('/');
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name: 'new-hero', exact: true }).click();
  await sidebar(page).getByRole('button', { name: /^Tasks/ }).click();
  await expect(page.getByRole('button', { name: 'Project: landing' })).toBeVisible();
  const list = page.getByRole('grid', { name: 'Tasks' });
  await expect(list).toContainText('New hero for the launch');
  await expect(list).not.toContainText('Add auth to the payment routes');
  await page.getByRole('button', { name: 'Project: landing' }).click();
  await page.getByRole('menuitem', { name: /bob-api/ }).click();
  await expect(page.getByRole('button', { name: 'Project: bob-api' })).toBeVisible();
  await expect(list).toContainText('Add auth to the payment routes');
  await expect(list).not.toContainText('New hero for the launch');
});
