import { expect, test, type Page } from '@playwright/test';

/** Plans (docs/tasks-and-plans.md): the demo's plan as a graph and an outline, a new plan drafted with Claude and approved onto the board, and the composer's Plan with Tasks. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');

async function openPlans(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: /^Plans/ }).click();
  const project = page.getByRole('button', { name: /^Project: / });
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await project.click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await expect(page.getByRole('button', { name: 'Project: bob-api' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('the demo’s plan: milestones as a living graph, a task’s details, the outline', async ({ page }) => {
  await openPlans(page);
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue('Card checkout for launch');
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  // The first milestone passed; the second runs; a task waits on another.
  await expect(main(page).locator('.react-flow__node').filter({ hasText: 'Test-mode foundations' })).toContainText('Passed');
  const receipts = main(page).locator('.react-flow__node').filter({ hasText: 'Receipt emails sent once' });
  await expect(receipts).toContainText('Waiting');
  await receipts.click();
  const details = page.getByRole('complementary', { name: 'Details' });
  await expect(details).toContainText('Waits on');
  await expect(details).toContainText('Idempotent webhook retries');
  await details.getByRole('button', { name: 'Close' }).click();
  // The outline: the same plan, milestone by milestone.
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'Outline' }).click();
  await expect(page.getByRole('region', { name: 'Safe payments' })).toContainText('Add auth to the payment routes');
  await expect(page.getByRole('region', { name: 'Refunds and launch' })).toContainText('Launch checklist');
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'Graph' }).click();
  // The conversation with the plan's Claude is beside it.
  await expect(page.getByRole('complementary', { name: 'Conversation' })).toBeVisible();
});

test('New Plan with no project known (⌘K) asks which project, and the title follows it', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+K');
  await page.getByPlaceholder('Go to, do, or start anything…').fill('New Plan');
  await page.getByRole('option', { name: /^New Plan/ }).first().click();
  const sheet = page.getByRole('dialog', { name: /^Plan in / });
  const picker = sheet.getByRole('combobox', { name: 'Project' });
  await expect(picker).toBeVisible();
  await expect(sheet.getByRole('heading', { name: `Plan in ${(await picker.textContent())!.trim()}` })).toBeVisible();
  await expect(sheet.getByLabel('Goal')).toBeFocused();
  await expect(sheet.getByRole('button', { name: 'Plan with Claude' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('a new plan: Claude drafts it in its own conversation, nothing is on the board until it’s approved', async ({ page }) => {
  await openPlans(page);
  await page.getByRole('button', { name: 'New Plan', exact: true }).click();
  // Opened from a project: it's in the title, and there's no picker.
  const sheet = page.getByRole('dialog', { name: /^Plan in / });
  await expect(sheet.getByRole('combobox', { name: 'Project' })).toHaveCount(0);
  // How it runs: three cards you read without hovering; Check-ins to start with.
  const runs = sheet.getByRole('radiogroup', { name: 'How it runs' });
  await expect(runs.getByRole('radio')).toHaveCount(3);
  await expect(runs.getByRole('radio', { name: /Check-ins/ })).toHaveAttribute('aria-checked', 'true');
  await expect(runs).toContainText('Runs, then waits for you at each milestone');
  // The goal box starts six lines tall and grows with the text.
  const goal = sheet.getByLabel('Goal');
  const start = (await goal.boundingBox())!.height;
  expect(start).toBeGreaterThanOrEqual(100);
  await goal.fill(Array.from({ length: 14 }, (_, i) => `Line ${i + 1}`).join('\n'));
  expect((await goal.boundingBox())!.height).toBeGreaterThan(start + 40);
  await goal.fill('Export orders as CSV for accounting');
  await runs.getByRole('radio', { name: /Step by Step/ }).click();
  await expect(runs.getByRole('radio', { name: /Step by Step/ })).toHaveAttribute('aria-checked', 'true');
  await sheet.getByRole('button', { name: 'Plan with Claude' }).click();
  // Its page, then Claude's draft.
  const approve = page.getByRole('button', { name: 'Approve Plan' }).first();
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('a draft, not on the board yet')).toBeVisible();
  await expect(main(page).locator('.react-flow__node').filter({ hasText: 'Data model and migration' })).toBeVisible({ timeout: 20_000 });
  // Talk it through: Claude changes the draft.
  const chat = page.getByRole('complementary', { name: 'Conversation' });
  await chat.getByRole('textbox', { name: 'Message Claude about the plan' }).fill('rate limits on the export endpoint');
  await chat.getByRole('textbox', { name: 'Message Claude about the plan' }).press('Enter');
  await expect(main(page).locator('.react-flow__node').filter({ hasText: /Rate limits on the export endpoint/i })).toBeVisible({ timeout: 20_000 });
  // Not on the board yet.
  await sidebar(page).getByRole('button', { name: /^Tasks/ }).click();
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  await expect(page.getByRole('grid', { name: 'Tasks' })).not.toContainText('Data model and migration');
  await sidebar(page).getByRole('button', { name: /^Plans/ }).click();
  await main(page).getByRole('button', { name: /^Export orders as CSV for accounting,/ }).click();
  await page.getByRole('button', { name: 'Approve Plan' }).first().click();
  await expect(page.getByRole('button', { name: 'Approve Plan' })).toHaveCount(0);
  // On the board now, each with its plan.
  await sidebar(page).getByRole('button', { name: /^Tasks/ }).click();
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  await expect(page.getByRole('grid', { name: 'Tasks' })).toContainText('Data model and migration');
});

test('the composer: Plan with Tasks makes the conversation a plan', async ({ page }) => {
  await page.goto('/');
  // The demo's chat in bob-api (unfold the project when it's folded).
  const chat = sidebar(page).getByRole('button', { name: 'How do deploys work?' });
  if (!(await chat.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await chat.click();
  await page.getByRole('button', { name: /^Mode: / }).click();
  await page.getByRole('menuitem', { name: /Plan with Tasks/ }).click();
  await expect(page.getByRole('button', { name: 'Mode: Plan with Tasks' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'nothing reaches the board until you approve' })).toBeVisible();
  // Back to acting: the empty plan goes.
  await page.getByRole('button', { name: /^Mode: / }).click();
  await page.getByRole('menuitem', { name: /^Act/ }).click();
  await expect(page.getByRole('button', { name: 'Mode: Act' })).toBeVisible();
});
