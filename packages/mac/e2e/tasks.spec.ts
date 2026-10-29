import { expect, test, type Page } from './fixtures.js';

/** Tasks (docs/tasks-and-plans.md): the demo's board, a new task, a task's page, the board and the graph, a worktree's task, and the Archive. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');

async function openTasks(page: Page): Promise<void> {
  await page.goto('/');
  // Tasks lives under Work (BLG-197).
  await sidebar(page).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: 'Tasks' }).click();
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('lists the demo’s tasks by status; scopes and the board', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  const list = page.getByRole('grid', { name: 'Tasks' });
  // Sub-tasks start tucked under their epic: open them out.
  await page.getByRole('button', { name: 'Show All' }).click();
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
  const row = page.getByRole('row', { name: /Cache the exchange rates, Ready/ });
  await expect(row).toBeVisible();
  await row.click();

  // Its page: the goal from the sheet, its properties.
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Cache the exchange rates');
  await expect(page.getByRole('region', { name: 'Goal' })).toContainText('Fetch once an hour');
  const props = page.getByRole('complementary', { name: 'Properties' });

  // Status from its menu (2 = Ready, 3 = In Progress).
  await props.getByRole('button', { name: /^Ready$/ }).click();
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

test('a task merged into its plan looks finished: no Start, what happened instead; Reopen brings Start back', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('button', { name: 'New Task', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New Task' });
  await sheet.getByRole('button', { name: 'Write title and goal myself' }).click();
  await sheet.getByLabel('Title').fill('Merged already');
  await sheet.getByRole('button', { name: 'Create Task' }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('row', { name: /Merged already, Ready/ }).click();
  const start = page.getByRole('button', { name: 'Start', exact: true });
  await expect(start).toBeVisible();

  // Merged into the plan: its outcome, no Start on the page or in its ⋯ menu.
  const props = page.getByRole('complementary', { name: 'Properties' });
  await props.getByRole('button', { name: /^Ready$/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /Merged into Plan/ }).click();
  await expect(props).toContainText('Merged into Plan');
  await expect(page.getByTestId('task-outcome')).toContainText('Merged into the plan · ships with the plan’s pull request');
  await expect(start).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Where this task is' }).getByRole('button', { name: 'More' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /^Start/ })).toHaveCount(0);

  // ⋯ › Reopen the Task: back to Ready, and Start is back.
  await menu.getByRole('menuitem', { name: /Reopen the Task/ }).click();
  await expect(props).toContainText('Ready');
  await expect(start).toBeVisible();
  await expect(page.getByTestId('task-outcome')).toHaveCount(0);
});

test('Start on a task: a worktree named after it, Claude told it’s working on it, and you in its chat; back on the task, Open Worktree (BLG-55)', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('button', { name: 'New Task', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New Task' });
  await sheet.getByRole('button', { name: 'Write title and goal myself' }).click();
  await sheet.getByLabel('Title').fill('Receipt totals');
  await sheet.getByRole('button', { name: 'Create Task' }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('row', { name: /Receipt totals, Ready/ }).click();
  const key = (await page.getByRole('navigation', { name: 'Where this task is' }).locator('span').filter({ hasText: /^[A-Z]+-\d+$/ }).first().textContent())!;
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  // In the new worktree's chat, Claude asked to work on it.
  await expect(page.getByRole('navigation', { name: 'Where this task is' })).toHaveCount(0, { timeout: 15_000 });
  await expect(main(page)).toContainText(`You're working on ${key}`);
  await expect(sidebar(page)).toContainText(`${key.toLowerCase()}-receipt-totals`);
  // The task is In Progress with your Claude on it, and its page goes to the worktree now.
  await openTasks(page);
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  await page.getByRole('row', { name: /Receipt totals, In Progress/ }).click();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Worktree' })).toBeVisible();
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
  // No labels to pick: Claude picks them as it writes the task (BLG-31).
  await expect(sheet.getByRole('group', { name: 'Labels' })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Create Task' }).click();
  await expect(sheet).toBeHidden();
  // At once: under its first line, Claude writing; then Claude's title.
  await expect(column.getByRole('button', { name: /please make the login page remember me/ })).toContainText('Claude is writing…');
  const card = column.getByRole('button', { name: /Make the login page remember me$/ });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).not.toContainText('Claude is writing…');
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'List' }).click();
});

test('one New Task message asking for two tasks makes both on Create, no chat in between (BLG-319)', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'Board' }).click();
  const column = page.getByRole('list', { name: 'Board' }).getByRole('listitem', { name: /^Backlog/ });
  await column.getByRole('button', { name: 'New Task in Backlog' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Task' });
  await expect(sheet).toContainText('Ask for several tasks');
  await sheet.getByRole('textbox', { name: 'Describe the task' }).fill('Two things for the receipts:\n- add a total line to receipts\n- email receipts after checkout');
  if (process.env.BELUGA_SHOTS) await page.screenshot({ path: `${process.env.BELUGA_SHOTS}/new-task-several.png` });
  await sheet.getByRole('button', { name: 'Create Task' }).click();
  await expect(sheet).toBeHidden();
  await expect(column.getByRole('button', { name: /Add a total line to receipts$/ })).toBeVisible({ timeout: 15_000 });
  await expect(column.getByRole('button', { name: /Email receipts after checkout$/ })).toBeVisible();
  // Epics stand out on the board: a soft tint of the epic colour (BLG-320).
  if (process.env.BELUGA_SHOTS) await page.screenshot({ path: `${process.env.BELUGA_SHOTS}/board-epic-tint.png` });
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'List' }).click();
});

test('"@" in New Task offers your friends, puts the one you pick in, and Escape closes only the list (BLG-342)', async ({ page }) => {
  test.setTimeout(90_000);
  // The demo's friends (bob, mia…) come with the network on.
  await page.goto('/');
  const card = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  if (await card.isVisible().catch(() => false)) await card.getByRole('button', { name: 'Turn On' }).click();
  await expect(sidebar(page).getByRole('button', { name: /^bob, / })).toBeVisible({ timeout: 30_000 });
  await openTasks(page);
  await page.getByRole('button', { name: 'New Task', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New Task' });
  const box = sheet.getByRole('textbox', { name: 'Describe the task' });
  await box.pressSequentially('ask @');
  const list = sheet.getByRole('listbox', { name: 'Suggestions' });
  await expect(list.getByRole('option').first()).toBeVisible();
  // People only: no commands, no Claudes, no projects.
  await expect(list).not.toContainText('@claude');
  if (process.env.BELUGA_SHOTS) await page.screenshot({ path: `${process.env.BELUGA_SHOTS}/new-task-at-menu.png` });
  const first = (await list.getByRole('option').first().innerText()).split(/\s/)[0]!;
  await box.press('Enter');
  await expect(box).toHaveValue(`ask ${first} `);
  await expect(sheet.getByTestId('mention-highlighter').locator('mark')).toHaveText(first);
  await box.pressSequentially('for the copy');
  if (process.env.BELUGA_SHOTS) await page.screenshot({ path: `${process.env.BELUGA_SHOTS}/new-task-at-pill.png` });
  // Escape with the list open closes the list; the sheet stays.
  await box.pressSequentially(' @');
  await expect(list).toBeVisible();
  await box.press('Escape');
  await expect(list).toBeHidden();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
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

test('out of a task: Back stays at the top while scrolling; Esc, ⌘[ and a two-finger swipe right go back (BLG-5)', async ({ page }, info) => {
  await openTasks(page);
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  const list = page.getByRole('grid', { name: 'Tasks' });
  const row = list.getByRole('row', { name: /Add auth to the payment routes, In Review/ });
  const title = page.getByRole('textbox', { name: 'Title' });
  await row.click();
  await expect(title).toHaveValue('Add auth to the payment routes');
  // Scrolled to the bottom, Back is still right there at the top.
  const nav = page.getByRole('navigation', { name: 'Where this task is' });
  const before = await nav.boundingBox();
  await page.getByRole('region', { name: 'Activity' }).scrollIntoViewIfNeeded();
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 4000);
  const after = await nav.boundingBox();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath('task-scrolled.png') });
  await expect(nav.getByRole('button', { name: 'Back' })).toBeInViewport();
  // Esc: back to the list.
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press('Escape');
  await expect(list).toBeVisible();
  // ⌘[ too.
  await row.click();
  await expect(title).toBeVisible();
  await page.keyboard.press('Meta+BracketLeft');
  await expect(list).toBeVisible();
  // A two-finger swipe right (horizontal wheel, deltaX < 0): an arrow comes in, and letting go goes back.
  await row.click();
  await expect(title).toBeVisible();
  await page.mouse.move(500, 300);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(-20, 0);
  await page.screenshot({ path: info.outputPath('task-swipe.png') }).catch(() => undefined);
  await expect(list).toBeVisible();
  // Typing in the title keeps Esc for the title.
  await row.click();
  await title.click();
  await page.keyboard.press('Escape');
  await expect(title).toBeVisible();
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
  const proof = page.getByRole('region', { name: 'Proof' }).getByRole('button', { name: 'Hero copy', exact: true });

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
  // The sheet is modal, so the page under it is hidden from the accessibility tree, but still there.
  await expect(page.getByRole('textbox', { name: 'Title', includeHidden: true })).toHaveValue('New hero for the launch');
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

test('files added to a task show under Files, apart from proof, and open over the page', async ({ page }) => {
  await page.goto('/');
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name: 'new-hero', exact: true }).click();
  await page.getByRole('button', { name: /New hero for the launch/ }).first().click();
  const files = page.getByRole('region', { name: 'Files' });
  await expect(files.getByRole('button', { name: 'brand-brief.pdf', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Proof' })).not.toContainText('brand-brief.pdf');
  // The page takes Finder drops for its task.
  await expect(page.locator('[data-task-drop][data-task-key]').first()).toBeAttached();
  await files.getByRole('button', { name: 'brand-brief.pdf', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'brand-brief.pdf' })).toBeVisible();
  await page.keyboard.press('Escape');
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

for (const width of [1440, 2560]) {
  test(`a ${width}px window: the task page spans the middle area and prose keeps a readable line`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openTasks(page);
    await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
    await page.getByRole('row', { name: /Add auth to the payment routes/ }).first().click();
    const props = page.getByRole('complementary', { name: 'Properties' });
    const activity = page.getByRole('region', { name: 'Activity' });
    await expect(activity).toBeVisible();
    // Wide parts reach from the page's left edge to the properties, apart from padding.
    const mainBox = (await main(page).boundingBox())!;
    const propsBox = (await props.boundingBox())!;
    const activityBox = (await activity.boundingBox())!;
    expect(activityBox.x - mainBox.x).toBeLessThanOrEqual(40);
    expect(propsBox.x - (activityBox.x + activityBox.width)).toBeLessThanOrEqual(40);
    // Prose stays capped: the goal's paragraph is no wider than about 90 characters.
    const goal = page.getByRole('region', { name: 'Goal' }).locator('p').first();
    // The Goal paragraph must be there: a missing one fails here rather than skipping the check.
    await expect(goal).toBeVisible();
    const goalBox = await goal.boundingBox();
    expect(goalBox, 'the Goal paragraph has a box').not.toBeNull();
    expect(goalBox!.width).toBeLessThanOrEqual(900);
    await page.screenshot({ path: `../../.klaud/scratch/task-page-${width}.png` });
  });
}

test('Tasks is one project at a time: the one you came from, and the switcher changes it', async ({ page }) => {
  await page.goto('/');
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name: 'new-hero', exact: true }).click();
  await sidebar(page).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: 'Tasks' }).click();
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

test('Done’s one click puts every Done task in the Archive; an archived task reads as it was and comes back (BLG-27)', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'List' }).click();
  const list = page.getByRole('grid', { name: 'Tasks' });
  const done = list.getByRole('region', { name: 'Done' });
  await expect(done.getByRole('row', { name: /Stripe test-mode fixtures, Done/ })).toBeVisible();
  if (process.env.ARCHIVE_SHOT) await page.screenshot({ path: `${process.env.ARCHIVE_SHOT}-1-done.png` });
  await done.getByRole('button', { name: /^Archive \d+ Done Tasks?$/ }).click();
  await expect(list.getByRole('region', { name: 'Done' })).toHaveCount(0);

  // The Archive: a list of what was put away, emptied from its bar.
  const tabs = page.getByRole('tablist', { name: 'Show' });
  await tabs.getByRole('tab', { name: /^Archive/ }).click();
  await expect(page.getByRole('tablist', { name: 'Display' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Empty Archive' })).toBeVisible();
  const row = page.getByRole('grid', { name: 'Tasks' }).getByRole('row', { name: /Stripe test-mode fixtures, Done/ });
  await expect(row).toBeVisible();
  if (process.env.ARCHIVE_SHOT) await page.screenshot({ path: `${process.env.ARCHIVE_SHOT}-2-archive.png` });
  await row.click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Stripe test-mode fixtures');
  const banner = page.getByRole('status').filter({ hasText: 'Its words and history are kept' });
  await expect(banner).toBeVisible();
  if (process.env.ARCHIVE_SHOT) await page.screenshot({ path: `${process.env.ARCHIVE_SHOT}-3-archived-task.png` });
  await banner.getByRole('button', { name: 'Restore' }).click();
  await expect(banner).toHaveCount(0);
  await openTasks(page);
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  await expect(page.getByRole('grid', { name: 'Tasks' }).getByRole('row', { name: /Stripe test-mode fixtures, Done/ })).toBeVisible();
});
