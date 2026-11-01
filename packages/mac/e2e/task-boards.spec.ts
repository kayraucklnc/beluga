import { expect, test, type Page } from './fixtures.js';

/** Boards and repos, many to many (BLG-500): a board covering two repos, a task in each, the repo filter, and moving a task's repo. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const SHOTS = process.env.TASK_BOARDS_SHOTS;

async function openTasks(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: 'Tasks' }).click();
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('a board for two repos: tasks in each, a filter by repo, and a task moved between them', async ({ page }) => {
  await openTasks(page);
  // New Board, from the board switcher.
  await page.getByRole('button', { name: /^Board: / }).click();
  await page.getByRole('menuitem', { name: 'New Board…' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Board' });
  await sheet.getByLabel('Name').fill('Launch');
  await sheet.getByRole('checkbox', { name: /landing/ }).click();
  await expect(sheet.getByRole('checkbox', { name: /bob-api/ })).toHaveAttribute('aria-checked', 'true');
  await shot(page, '01-new-board');
  await sheet.getByRole('button', { name: 'Create Board' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: 'Board: Launch' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Repos: All repos' })).toBeVisible();

  // A task in each repo: New Task asks which one.
  for (const [title, repo] of [['Pricing page', 'landing'], ['Plans endpoint', 'bob-api']] as const) {
    await page.getByRole('button', { name: 'New Task', exact: true }).first().click();
    const make = page.getByRole('dialog', { name: 'New Task' });
    await make.getByRole('button', { name: 'Write title and goal myself' }).click();
    await make.getByLabel('Title').fill(title);
    await make.getByRole('combobox', { name: 'Repo' }).click();
    await page.getByRole('option', { name: repo, exact: true }).click();
    if (repo === 'landing') await shot(page, '02-new-task-repo');
    await make.getByRole('button', { name: 'Create Task' }).click();
    await expect(make).toBeHidden();
  }
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'Board' }).click();
  const board = page.getByRole('list', { name: 'Board' });
  await expect(board.getByRole('listitem', { name: /^Ready/ })).toContainText('Pricing page');
  await expect(board.getByTitle('Runs in landing')).toBeVisible();
  await shot(page, '03-board-two-repos');

  // Only landing's tasks.
  await page.getByRole('button', { name: 'Repos: All repos' }).click();
  await page.getByRole('menuitem', { name: /^landing/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Repos: landing' })).toBeVisible();
  await expect(board).toContainText('Pricing page');
  await expect(board).not.toContainText('Plans endpoint');
  await shot(page, '04-filter-landing');
  await page.getByRole('button', { name: 'Repos: landing' }).click();
  await page.getByRole('menuitem', { name: 'Show All Repos' }).click();

  // A task's page: its repo, changed; it keeps its key.
  await board.getByText('Plans endpoint').click();
  const repo = page.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: 'bob-api' });
  await expect(repo).toBeVisible();
  await repo.click();
  await page.getByRole('menuitem', { name: /^landing/ }).click();
  await expect(page.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: 'landing' })).toBeVisible();
  await shot(page, '05-task-repo');
});

test('a repo’s board shows what runs in it from a board of several, saying which board, a click away (BLG-559)', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('button', { name: /^Board: / }).click();
  await page.getByRole('menuitem', { name: 'New Board…' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Board' });
  await sheet.getByLabel('Name').fill('Copy Week');
  await sheet.getByRole('checkbox', { name: /landing/ }).click();
  await sheet.getByRole('button', { name: 'Create Board' }).click();
  await expect(page.getByRole('button', { name: 'Board: Copy Week' })).toBeVisible();
  await page.getByRole('button', { name: 'New Task', exact: true }).first().click();
  const make = page.getByRole('dialog', { name: 'New Task' });
  await make.getByRole('button', { name: 'Write title and goal myself' }).click();
  await make.getByLabel('Title').fill('Hero copy');
  await make.getByRole('combobox', { name: 'Repo' }).click();
  await page.getByRole('option', { name: 'landing', exact: true }).click();
  await make.getByRole('button', { name: 'Create Task' }).click();
  await expect(make).toBeHidden();
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'Board' }).click();

  // landing's own board: Hero copy is there, saying it's on Copy Week.
  await page.getByRole('button', { name: 'Board: Copy Week' }).click();
  await page.getByRole('menuitem', { name: /^landing/ }).click();
  await expect(page.getByRole('button', { name: 'Board: landing' })).toBeVisible();
  const board = page.getByRole('list', { name: 'Board' });
  await expect(board).toContainText('Hero copy');
  const card = board.getByRole('button', { name: /Hero copy$/ });
  const chip = card.getByRole('button', { name: 'On the Copy Week board' });
  await expect(chip).toBeVisible();
  await shot(page, '06-visiting-on-repo-board');
  // The chip opens Copy Week, where it's at home (no chip).
  await chip.click();
  await expect(page.getByRole('button', { name: 'Board: Copy Week' })).toBeVisible();
  await expect(board).toContainText('Hero copy');
  await expect(card.getByRole('button', { name: 'On the Copy Week board' })).toHaveCount(0);
});

test('an epic across repos says so before Start, and after it works in each repo’s worktree (BLG-561)', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('button', { name: /^Board: / }).click();
  await page.getByRole('menuitem', { name: 'New Board…' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Board' });
  await sheet.getByLabel('Name').fill('Fees Week');
  await sheet.getByRole('checkbox', { name: /landing/ }).click();
  await sheet.getByRole('button', { name: 'Create Board' }).click();
  await expect(page.getByRole('button', { name: 'Board: Fees Week' })).toBeVisible();
  await page.getByRole('button', { name: 'New Task', exact: true }).first().click();
  const make = page.getByRole('dialog', { name: 'New Task' });
  await make.getByRole('button', { name: 'Write title and goal myself' }).click();
  await make.getByLabel('Title').fill('Fees everywhere');
  await make.getByRole('combobox', { name: 'Repo' }).click();
  await page.getByRole('option', { name: 'bob-api', exact: true }).click();
  await make.getByRole('button', { name: 'Create Task' }).click();
  await expect(make).toBeHidden();
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'List' }).click();
  await page.getByRole('row', { name: /Fees everywhere/ }).click();

  // A sub-task, moved to run in landing.
  await page.getByLabel('New sub-task').fill('Fee page');
  await page.getByLabel('New sub-task').press('Enter');
  await page.getByText('Fee page', { exact: true }).click();
  await page.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: 'bob-api' }).click();
  await page.getByRole('menuitem', { name: /^landing/ }).click();
  await expect(page.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: 'landing' })).toBeVisible();

  // Back on the epic: Start says it works across both repos.
  await openTasks(page);
  await page.getByRole('row', { name: /Fees everywhere/ }).click();
  await expect(page.getByText('A worktree in bob-api and landing from the latest origin')).toBeVisible();
  await shot(page, '07-epic-across-repos');

  // Started: a worktree in each repo, and the epic's page says it works in landing's too.
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(sidebar(page).getByText(/fees-everywhere/).first()).toBeVisible();
  await openTasks(page);
  await page.getByRole('row', { name: /Fees everywhere/ }).click();
  await expect(page.getByText('also in landing')).toBeVisible();
  await shot(page, '08-epic-started-across-repos');
});
