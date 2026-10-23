import { expect, test, type Page } from './fixtures.js';

/**
 * A plan is one row under its project (KLD-23): its task worktrees stay off the sidebar, the row
 * opens the plan with its conversation, it stays marked while you're in one of its tasks, and a
 * task's worktree offers its plan instead of a local Merge.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');
const toolbar = (page: Page) => page.locator('main header').first();
const PLAN = 'Card checkout for launch';
/** The demo plan's two tasks in progress work in these. */
const TASK_WORKTREES = ['checkout-auth', 'checkout-events'];

/** bob-api's rows: from its own row to the next project's (they're siblings in one block). */
const projectRow = (page: Page) => sidebar(page).locator('[data-drag^="project:"][aria-label="bob-api"]').first();
const block = (page: Page) => sidebar(page).locator('[data-slot^="project:"]').filter({ has: page.locator('[data-drag^="project:"][aria-label="bob-api"]') }).last();

const planRow = (page: Page) => block(page).locator('[data-plan-row]').and(page.getByRole('button', { name: PLAN, exact: true }));

async function unfold(page: Page): Promise<void> {
  await expect(projectRow(page)).toBeVisible();
  const show = sidebar(page).getByRole('button', { name: "Show what's in bob-api" });
  if (await show.isVisible()) await show.click();
}

test.use({ viewport: { width: 1440, height: 1400 } });

test('a running plan is one row under its project; its task worktrees stay off the sidebar; it opens the plan with its chat', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await unfold(page);
  // One row for the plan (other plans in the project have their own).
  const plan = planRow(page);
  await expect(plan).toHaveCount(1);
  // A flag, its name, and a small ring of how far it got.
  await expect(plan.locator('svg circle')).toHaveCount(2);
  await expect(plan).toHaveAttribute('title', new RegExp(`^${PLAN}: .+ · \\d+ of \\d+ tasks done`));
  for (const name of TASK_WORKTREES) await expect(sidebar(page).getByRole('button', { name, exact: true })).toHaveCount(0);
  // Worktrees that aren't part of a plan stay as they were.
  await expect(block(page).getByRole('button', { name: 'add-auth', exact: true })).toBeVisible();
  if (process.env.SHOTS) await sidebar(page).screenshot({ path: `${process.env.SHOTS}/sidebar-plan-row.png` });

  await plan.click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue(PLAN);
  await expect(page.getByRole('complementary', { name: 'Conversation' })).toBeVisible();
  await expect(plan).toHaveClass(/selected/);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/plan-with-chat.png` });
});

test('in a task’s worktree (from the plan) the plan row stays marked; it offers Open Plan, and Merge only under ⋯ with a warning', async ({ page }) => {
  await page.goto('/');
  await unfold(page);
  await planRow(page).click();
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'List' }).click();
  await page.getByRole('region', { name: 'Safe payments' }).getByText('Add auth to the payment routes', { exact: true }).first().click();
  await page.getByRole('complementary', { name: 'Details' }).getByRole('button', { name: 'Open Worktree' }).click();
  await expect(toolbar(page)).toContainText('checkout-auth');
  // The sidebar marks the plan, not a hidden row; the strip at the top leads back.
  await expect(planRow(page)).toHaveClass(/selected/);
  await expect(sidebar(page).getByRole('button', { name: 'checkout-auth', exact: true })).toHaveCount(0);
  // Its next step is the plan, never a local Merge.
  await expect(toolbar(page).getByRole('button', { name: /^Merge into/ })).toHaveCount(0);
  await expect(toolbar(page).getByRole('button', { name: 'Open Plan' })).toBeVisible();
  // Under ⋯: its plan and its task, and merging by hand, which says the plan merges it itself.
  await toolbar(page).getByRole('button', { name: 'More for this workspace' }).click();
  await expect(page.getByRole('menuitem', { name: /^Open Task/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Merge…/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: /^Merge Anyway/ }).click();
  const alert = page.getByRole('alertdialog', { name: /by hand\?/ });
  await expect(alert).toContainText('Beluga merges it into the plan');
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(alert).toBeHidden();
  // The strip at the top leads back to the plan.
  await main(page).getByRole('button', { name: new RegExp(`^${PLAN} Safe payments`) }).click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue(PLAN);
});

test('Project Home lists the plan as one row and leaves its worktrees out; the Worktrees page names their plan', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  const plans = page.getByRole('region', { name: 'Plans' });
  await expect(plans.getByRole('button', { name: new RegExp(`^${PLAN}: `) })).toBeVisible();
  const worktrees = page.getByRole('region', { name: 'Worktrees' });
  await expect(worktrees.getByRole('button', { name: /add-auth/ })).toBeVisible();
  for (const name of TASK_WORKTREES) await expect(worktrees.getByRole('button', { name: new RegExp(name) })).toHaveCount(0);
  await page.getByRole('region', { name: 'Plans' }).getByRole('button', { name: new RegExp(`^${PLAN}: `) }).click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue(PLAN);

  await projectRow(page).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Manage Worktrees…' }).click();
  const row = page.getByRole('row').filter({ hasText: 'checkout-auth' });
  await expect(row).toContainText(PLAN);
});
