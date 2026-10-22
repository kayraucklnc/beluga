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
  await sheet.getByRole('button', { name: 'Write title and goal myself' }).click();
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

test('a column’s +: describe it, pick a priority, Create; the card lands there and Claude writes its title', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'Board' }).click();
  const column = page.getByRole('list', { name: 'Board' }).getByRole('listitem', { name: /^In Progress/ });
  await column.getByRole('button', { name: 'New Task in In Progress' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Task' });
  // One box, focused; where it goes is a quiet line, not fields.
  const box = sheet.getByRole('textbox', { name: 'Describe the task' });
  await expect(box).toBeFocused();
  await expect(sheet).toContainText('In Progress');
  await expect(sheet.getByText('Status', { exact: true })).toHaveCount(0);
  await expect(sheet.getByText('Project', { exact: true })).toHaveCount(0);
  // The box grows with what you write.
  const before = (await box.boundingBox())!.height;
  await box.fill('please make the login page remember me\nso people stay signed in for a week\n\nthey keep complaining\nabout typing passwords\nevery morning\nand on every device');
  await box.dispatchEvent('input');
  expect((await box.boundingBox())!.height).toBeGreaterThan(before);
  // Priority on a scale: a click, or 0 to 4 on it.
  const scale = sheet.getByRole('radiogroup', { name: 'Priority' });
  await scale.getByRole('radio', { name: /Low/ }).click();
  await page.keyboard.press('3');
  await expect(scale.getByRole('radio', { name: /High/ })).toHaveAttribute('aria-checked', 'true');
  // Labels: the board's own, as chips.
  const labels = sheet.getByRole('group', { name: 'Labels' });
  await expect(labels.getByRole('textbox')).toHaveCount(0);
  await labels.getByRole('button', { name: 'security' }).click();
  await expect(labels.getByRole('button', { name: 'security' })).toHaveAttribute('aria-pressed', 'true');
  await sheet.getByRole('button', { name: 'Create Task' }).click();
  await expect(sheet).toBeHidden();
  // At once: under its first line, Claude writing; then Claude's title.
  await expect(column.getByRole('button', { name: /please make the login page remember me/ })).toContainText('Claude is writing…');
  const card = column.getByRole('button', { name: /Make the login page remember me$/ });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).not.toContainText('Claude is writing…');
  await expect(card).toContainText('security');
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'List' }).click();
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

test('a file proof opens over the task page within 300 ms; ⌘-click and Show in Files go to the file', async ({ page }) => {
  const openTask = async (): Promise<void> => {
    const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
    if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
    await sidebar(page).getByRole('button', { name: 'new-hero', exact: true }).click();
    await page.getByRole('button', { name: /New hero for the launch/ }).first().click();
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('New hero for the launch');
  };
  await page.goto('/');
  await openTask();
  const title = page.getByRole('textbox', { name: 'Title' });
  const proof = page.getByRole('region', { name: 'Proof' }).getByRole('button', { name: 'Hero copy' });

  // A click: the file, read over the page, at once (timed in the page, from the click to the sheet); the task page stays under it.
  await page.evaluate(() => {
    const w = window as unknown as { proofShownIn?: Promise<number> };
    w.proofShownIn = new Promise<number>((resolve) => {
      document.addEventListener(
        'click',
        () => {
          const at = performance.now();
          const shown = (): boolean => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent?.includes('Hero copy'));
          if (shown()) return resolve(0);
          const watch = new MutationObserver(() => {
            if (!shown()) return;
            watch.disconnect();
            resolve(performance.now() - at);
          });
          watch.observe(document.body, { childList: true, subtree: true });
        },
        { capture: true, once: true },
      );
    });
  });
  await proof.click();
  const sheet = page.getByRole('dialog', { name: 'Hero copy' });
  await expect(sheet).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { proofShownIn: Promise<number> }).proofShownIn)).toBeLessThan(300);
  await expect(sheet.getByRole('heading', { name: 'Build together' })).toBeVisible();
  await expect(title).toHaveValue('New hero for the launch');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(title).toBeVisible();

  // ⌘-click: no sheet, the Files view on the file.
  await proof.click({ modifiers: ['Meta'] });
  await expect(page.getByRole('region', { name: 'hero.md' })).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await expect(title).toBeHidden();

  // Show in Files: the same, from the sheet.
  await openTask();
  await proof.click();
  await sheet.getByRole('button', { name: 'Show in Files' }).click();
  await expect(sheet).toBeHidden();
  await expect(title).toBeHidden();
  await expect(page.getByRole('region', { name: 'hero.md' })).toBeVisible();
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

test('the board: a card picked up lifts, the column makes room, and it lands where it was dropped', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'Board' }).click();
  const board = page.getByRole('list', { name: 'Board' });
  const card = board.getByRole('button', { name: /Rate-limit the login endpoint/ });
  const from = (await card.boundingBox())!;
  const review = board.getByRole('listitem', { name: /^In Review/ });
  const to = (await review.boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + 15);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 30, { steps: 4 });
  await page.mouse.move(to.x + 60, to.y + 70, { steps: 12 });
  // Lifted: a gap opens where it would land.
  await expect(review.locator('[data-gap]')).toBeVisible();
  await page.mouse.up();
  await expect(review).toContainText('Rate-limit the login endpoint');
  await expect(review.locator('[data-gap]')).toHaveCount(0);
  // Esc puts a lifted card back.
  const back = (await review.getByRole('button', { name: /Rate-limit the login endpoint/ }).boundingBox())!;
  await page.mouse.move(back.x + 30, back.y + 15);
  await page.mouse.down();
  await page.mouse.move(back.x - 300, back.y + 30, { steps: 10 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(review).toContainText('Rate-limit the login endpoint');
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'List' }).click();
});
