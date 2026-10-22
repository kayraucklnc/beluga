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

test('the plan’s chat shows what was said there when the plan opens, after a reload too, without sending anything (KLD-53)', async ({ page }) => {
  // The demo saved how its plan began without loading it, as a restarted daemon has it: only on disk.
  await openPlans(page);
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  const chat = page.getByRole('complementary', { name: 'Conversation' });
  await expect(chat).toContainText('drafted the plan in three milestones', { timeout: 15_000 });
  await expect(chat).not.toContainText('Plan it together');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue('Card checkout for launch', { timeout: 20_000 });
  await expect(chat).toContainText('drafted the plan in three milestones', { timeout: 15_000 });
  await expect(chat.getByRole('textbox', { name: 'Message Claude about the plan' })).toHaveValue('');
});

test('a task’s panel keeps its head and Close in reach while its brief scrolls, and nothing runs off its edge (KLD-32)', async ({ page }, info) => {
  // Short enough that the brief has to scroll.
  await page.setViewportSize({ width: 1180, height: 560 });
  await openPlans(page);
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  // Only real lines: a gate leads to a milestone only when it waits on it, and no card is wired across milestones.
  const edge = (from: string, to: string) => main(page).getByRole('group', { name: `Edge from ${from} to ${to}`, exact: true });
  await expect(main(page).getByRole('group', { name: '“Safe payments” leads to “Refunds and launch”', exact: true })).toHaveCount(1);
  await expect(main(page).getByRole('group', { name: /^“Test-mode foundations” leads to/ })).toHaveCount(0);
  // Milestones that run side by side make the plan wide: room for it (the conversation folded away), all of it in view.
  await main(page).getByRole('button', { name: 'Hide the Chat' }).click();
  await main(page).getByRole('button', { name: 'Fit to View' }).click();
  await page.waitForTimeout(400);
  await main(page).locator('.react-flow__node').filter({ hasText: 'Refund endpoint' }).click();
  await expect(edge('t:retries', 't:refund-api')).toHaveCount(0);
  await expect(main(page).locator('.react-flow__node').filter({ hasText: 'Idempotent webhook retries' }).locator('[data-linked="true"]')).toHaveCount(1);
  // The panel covers part of the plan: closed before picking another card.
  await page.keyboard.press('Escape');
  await main(page).locator('.react-flow__node').filter({ hasText: 'Receipt emails sent once' }).click();
  const details = page.getByRole('complementary', { name: 'Details' });
  await expect(details).toContainText('Waits on');
  const body = details.locator('header + div');
  const close = details.getByRole('button', { name: 'Close' });
  const sizes = () => body.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, wide: el.scrollWidth, width: el.clientWidth }));
  expect((await sizes()).scroll).toBeGreaterThan((await sizes()).client);
  await expect(details.locator('header')).toHaveAttribute('data-scrolled', 'false');
  await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(details.locator('header')).toHaveAttribute('data-scrolled', 'true');
  // At the bottom: the key, the title, the state and Close are all still on screen.
  await expect(details.getByRole('heading', { name: 'Receipt emails sent once' })).toBeInViewport();
  await expect(close).toBeInViewport();
  await expect(details.getByText('src/webhooks/paid.ts').first()).toBeInViewport();
  // Nothing wider than the panel: paths and words wrap.
  const s = await sizes();
  expect(s.wide).toBeLessThanOrEqual(s.width);
  const shot = info.outputPath('panel-scrolled.png');
  await details.screenshot({ path: shot });
  await info.attach('panel scrolled to the bottom', { path: shot, contentType: 'image/png' });
  await close.click();
  await expect(details).toHaveCount(0);
  // Esc closes it too.
  await main(page).locator('.react-flow__node').filter({ hasText: 'Receipt emails sent once' }).click();
  await expect(details).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
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
  // A plan's own conversation has no modes to pick (KLD-54): the chip opens the plan, or throws the draft away.
  await page.getByRole('button', { name: /^Mode: / }).click();
  await expect(page.getByRole('menuitem', { name: /^Act/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Open the Plan' })).toBeVisible();
  // Discarding the empty draft: the conversation is an ordinary one again.
  await page.getByRole('menuitem', { name: 'Discard the Draft' }).click();
  await expect(page.getByRole('button', { name: 'Mode: Act' })).toBeVisible();
});

test('a running plan sits under Plans in the sidebar: progress, what it waits for, one click to it', async ({ page }) => {
  await page.goto('/');
  // The first row is the one under Plans (its project shows it again further down, KLD-23).
  const row = sidebar(page).getByRole('button', { name: 'Card checkout for launch', exact: true }).first();
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

test('the header says who the plan waits for; the run mode says what changes; the feed says what happened (KLD-22)', async ({ page }, info) => {
  await openPlans(page);
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  const head = main(page).locator('header').filter({ has: page.getByRole('textbox', { name: 'Plan name' }) });
  // Everything the header ever says from here on, to prove it never claimed to wait for you while Claude checked.
  await page.evaluate(() => {
    const w = window as unknown as { __said: string[] };
    w.__said = [];
    const read = () => {
      const text = [...document.querySelectorAll('main header')].find((h) => h.querySelector('[aria-label="Plan name"]'))?.textContent ?? '';
      if (w.__said.at(-1) !== text) w.__said.push(text);
    };
    read();
    new MutationObserver(read).observe(document.querySelector('main')!, { subtree: true, childList: true, characterData: true });
  });

  // The run mode is a button that says how it runs; Autopilot says in plain words what changes, then Cancel.
  await head.getByRole('button', { name: 'Runs on Step by Step' }).click();
  const sheet = page.getByRole('dialog', { name: 'How It Runs' });
  await sheet.getByRole('radio', { name: /Autopilot/ }).click();
  const changes = sheet.getByRole('status', { name: 'What changes' });
  await expect(changes).toContainText('From now on Claude passes milestones itself');
  await expect(changes).toContainText('It stops only if a check fails.');
  const shot = info.outputPath('mode-autopilot.png');
  await sheet.screenshot({ path: shot });
  await info.attach('switching to Autopilot', { path: shot, contentType: 'image/png' });
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(head.getByRole('button', { name: 'Runs on Step by Step' })).toBeVisible();
  // Check-ins, applied at once and in the feed.
  await head.getByRole('button', { name: 'Runs on Step by Step' }).click();
  await sheet.getByRole('radio', { name: /Check-ins/ }).click();
  await expect(changes).toContainText('each milestone waits for you to pass it');
  await sheet.getByRole('button', { name: 'Switch to Check-ins' }).click();
  await expect(head.getByRole('button', { name: 'Runs on Check-ins' })).toBeVisible();
  await main(page).getByRole('button', { name: 'What Happened', exact: true }).click();
  const feed = page.getByRole('complementary', { name: 'What happened' });
  await expect(feed.getByRole('list', { name: 'What happened' }).locator('li').first()).toContainText('switched the plan to Check-ins');

  await page.keyboard.press('Escape');
  await expect(feed).toHaveCount(0);

  // The gated check: every task of “Safe payments” finished (the other two move to the next milestone), Claude checks it.
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'List' }).click();
  const move = async (title: string, to: string) => {
    await main(page).getByRole('button', { name: new RegExp(`^${title},`) }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to' }).click();
    await page.getByRole('menuitem', { name: to }).click();
    await expect(page.getByRole('region', { name: to })).toContainText(title);
  };
  await move('Receipt emails sent once', 'Refunds and launch');
  await move('Idempotent webhook retries', 'Refunds and launch');
  // Claude checked: now (and only now) it's yours to pass. Once the demo has run a while, KLD-37's
  // watchdog may have found a demo task that stopped again: resuming it outranks passing (progress.ts nextStep).
  await expect(head).toContainText(/You: (pass “Safe payments” — Claude checked all 3 criteria|resume BOB-\d+: its Claude stopped again)/, { timeout: 20_000 });
  await head.getByRole('button', { name: /Show what happened$/ }).click();
  await expect(feed).toContainText('Claude is checking its pass criteria');
  await expect(feed).toContainText('checked “Safe payments”', { timeout: 20_000 });
  const said = await page.evaluate(() => (window as unknown as { __said: string[] }).__said);
  expect(said.filter((t) => t.includes('Waiting for you'))).toEqual([]);
  const shot2 = info.outputPath('header-pass.png');
  await main(page).screenshot({ path: shot2 });
  await info.attach('header after the check', { path: shot2, contentType: 'image/png' });

  // Put the demo back as it was: the tasks home again, step by step.
  await page.keyboard.press('Escape');
  await move('Idempotent webhook retries', 'Safe payments');
  await move('Receipt emails sent once', 'Safe payments');
  await head.getByRole('button', { name: 'Runs on Check-ins' }).click();
  await sheet.getByRole('radio', { name: /Step by Step/ }).click();
  await sheet.getByRole('button', { name: 'Switch to Step by Step' }).click();
  await expect(head.getByRole('button', { name: 'Runs on Step by Step' })).toBeVisible();
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'Canvas' }).click();
});
