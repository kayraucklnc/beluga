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
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'List' }).click();
  await expect(page.getByRole('region', { name: 'Safe payments' })).toContainText('Add auth to the payment routes');
  await expect(page.getByRole('region', { name: 'Refunds and launch' })).toContainText('Launch checklist');
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'Canvas' }).click();
  // The conversation with the plan's Claude is beside it.
  await expect(page.getByRole('complementary', { name: 'Conversation' })).toBeVisible();
});

test('the plan stays sharp zoomed in, and its name never clips (KLD-25)', async ({ page }, info) => {
  await openPlans(page);
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  const name = page.getByRole('textbox', { name: 'Plan name' });
  const fits = () => name.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  // Descenders show whole: the box is as tall as its line.
  await name.fill('Typography query');
  await name.press('Enter');
  await expect(name).not.toBeFocused();
  await expect(name).toHaveValue('Typography query');
  const one = await fits();
  expect(one.scroll).toBeLessThanOrEqual(one.client);
  expect(one.client).toBeGreaterThanOrEqual(Math.ceil(19 * 1.3));
  // A long name wraps onto a second line instead of being cut, and Enter still saves it.
  const long = 'Typography query for every plan page, pill, outline heading, and the sidebar groups that hold them all';
  await name.fill(long);
  await name.press('Enter');
  await expect(name).toHaveValue(long);
  const two = await fits();
  expect(two.scroll).toBeLessThanOrEqual(two.client);
  expect(two.client).toBeGreaterThan(one.client * 1.5);
  await name.fill('Card checkout for launch');
  await name.press('Enter');
  await expect(name).toHaveValue('Card checkout for launch');

  // Zoomed in, the view is redrawn once it settles, with nothing blurred inside it.
  const viewport = main(page).locator('.react-flow__viewport');
  const scale = async () => Number(/scale\(([\d.]+)\)/.exec((await viewport.getAttribute('style')) ?? '')?.[1] ?? 0);
  for (let i = 0; i < 12 && (await scale()) < 1.5; i++) {
    await main(page).getByRole('button', { name: 'Zoom In' }).click();
    await page.waitForTimeout(260);
  }
  expect(await scale()).toBeGreaterThanOrEqual(1.5);
  // What matters once the zoom settles: the view was redrawn at its scale, and it's left a plain 2D
  // transform (no 3D layer kept around), whatever frames the zoom's own animation took (KLD-36).
  const settled = async () => {
    const style = (await viewport.getAttribute('style')) ?? '';
    return { sharpened: /^\d+$/.test((await viewport.getAttribute('data-sharpened')) ?? ''), nudged: style.includes('translateZ'), zoomed: (await scale()) >= 1.5 };
  };
  await expect.poll(settled, { timeout: 5_000 }).toEqual({ sharpened: true, nudged: false, zoomed: true });
  const blurred = await viewport.evaluate((root) =>
    [root, ...root.querySelectorAll('*')].filter((el) => {
      const css = getComputedStyle(el);
      return css.filter !== 'none' || (css.backdropFilter ?? 'none') !== 'none' || css.willChange !== 'auto';
    }).length,
  );
  expect(blurred).toBe(0);
  const shot = info.outputPath('zoomed-canvas.png');
  await main(page).locator('.react-flow').screenshot({ path: shot });
  await info.attach('zoomed canvas', { path: shot, contentType: 'image/png' });
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
  // A short name written for it, not the goal's first words (KLD-36).
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue('Export orders accounting');
  // Written, the canvas lays it out: never left on "Laying out…" (KLD-36).
  await expect(main(page).locator('[data-ready]')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
  await expect(main(page).getByText('Laying out…')).toHaveCount(0);
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
  await main(page).getByRole('button', { name: /^Export orders accounting,/ }).click();
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

test('a running plan sits under Plans in the sidebar: progress, what it waits for, one click to it', async ({ page }) => {
  await page.goto('/');
  const row = sidebar(page).getByRole('button', { name: 'Card checkout for launch', exact: true });
  await expect(row).toBeVisible();
  // How far it got, and why it needs you, in the tooltip.
  await expect(row).toHaveAttribute('title', /^Card checkout for launch: .+ · \d+ of \d+ tasks done$/);
  await expect(row.locator('svg circle')).toHaveCount(2);
  await row.click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue('Card checkout for launch');
  await expect(row).toHaveClass(/selected/);
});

test('Plans opens on the project you’re in, and says so when it has none', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByText('landing', { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'landing' })).toBeVisible();
  await sidebar(page).getByRole('button', { name: /^Plans/ }).first().click();
  const project = page.getByRole('button', { name: 'Project: landing' });
  await expect(project).toBeVisible();
  await expect(project).toHaveAttribute('title', 'Switch Project');
  await expect(main(page).getByText('No plans in landing yet')).toBeVisible();
  await main(page).getByRole('button', { name: 'Plan in landing' }).click();
  await expect(page.getByRole('dialog', { name: /Plan/ })).toBeVisible();
  await page.keyboard.press('Escape');
  // Switching shows that project's plans.
  await project.click();
  await page.getByRole('menuitem', { name: /bob-api/ }).click();
  await expect(main(page).getByRole('button', { name: /^Card checkout for launch,/ })).toBeVisible();
});
