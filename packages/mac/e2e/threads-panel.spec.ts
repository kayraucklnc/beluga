import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test, type Page } from './fixtures.js';

/**
 * Child threads in the Mac app (BLG-166 to BLG-168): the demo's agent starts real threads through
 * the real tools. Screenshots go to $BELUGA_SHOTS_DIR when it's set.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const shots = process.env.BELUGA_SHOTS_DIR;
/** A screenshot, and a beat on it so that the recording shows the same moment. */
async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}.png` });
  await page.waitForTimeout(1500);
}

/** The demo's project starts folded, with only the chat you're in. */
async function unfold(page: Page): Promise<void> {
  const show = sidebar(page).getByRole('button', { name: "Show what's in bob-api" }).first();
  if (await show.isVisible()) await show.click();
}

async function startParent(page: Page, name: string, threads: string): Promise<void> {
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  await page.getByLabel('Worktree name').fill(name);
  await composer(page).fill(`start threads: ${threads}`);
  await page.getByRole('button', { name: /Create Worktree/ }).click();
  await expect(sidebar(page).getByRole('button', { name, exact: true })).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });
test.use({ video: process.env.BELUGA_SHOTS_DIR ? { mode: 'on', size: { width: 1440, height: 900 } } : 'off' });

test('with threads off, no row has a mark', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  // A chat that is on the screen twice: in its project, and unread.
  await startParent(page, 'e2e-off', 'none=claude:finish now');
  await sidebar(page).getByRole('button', { name: 'Group chat', exact: true }).first().click();
  await unfold(page);
  await expect(sidebar(page).getByRole('button', { name: 'e2e-off', exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole('region', { name: 'Unread' }).getByRole('button', { name: /^e2e-off · / })).toBeVisible({ timeout: 40_000 });
  await expect(sidebar(page).locator('[data-harness]')).toHaveCount(0);
  await shot(page, 'flag-off');
});

test('a row shows its harness, and children fold under their parent', async ({ page, demo }) => {
  test.setTimeout(120_000);
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });
  await client.api.session.setPrefs({ agentThreads: true });
  client.close();
  await page.goto('/');
  await startParent(page, 'e2e-parent', 'one=codex:finish now; two=opencode:finish now; three=claude:finish now; four=claude:keep working; five=claude:keep working');

  await unfold(page);
  const group = sidebar(page).getByRole('group', { name: 'Threads of e2e-parent' });
  await expect(group.getByRole('button', { name: 'five', exact: true })).toBeVisible({ timeout: 40_000 });
  const parent = sidebar(page).getByRole('button', { name: 'e2e-parent', exact: true });
  await expect(parent.locator('[data-harness="claude"]')).toBeVisible();
  // The children have no row of their own at the top level.
  await expect(sidebar(page).getByRole('button', { name: 'five', exact: true })).toHaveCount(1);

  // Finished ones collapse behind "N earlier"; the two that work stay.
  await expect(group.getByRole('button', { name: /^2 earlier$/ })).toBeVisible({ timeout: 40_000 });
  await expect(group.getByRole('button', { name: 'four', exact: true })).toBeVisible();
  await expect(group.getByRole('button', { name: 'three', exact: true }).locator('[data-harness="claude"]')).toBeVisible();
  await shot(page, 'sidebar-fold');

  // Unread stays a flat list, each row with the same mark as in the project.
  const unread = sidebar(page).getByRole('region', { name: 'Unread' });
  await expect(unread.getByRole('button', { name: /^one · / }).locator('[data-harness="codex"]')).toBeVisible();
  await expect(unread.getByRole('button', { name: /^two · / }).locator('[data-harness="opencode"]')).toBeVisible();
  await expect(unread.getByRole('button', { name: /^three · / }).locator('[data-harness="claude"]')).toBeVisible();
  await expect(unread.locator('[role="group"]')).toHaveCount(0);
  await expect(unread.getByRole('button', { name: /^bob · / }).locator('[data-harness]')).toHaveCount(0);
  await shot(page, 'unread-marks');

  await group.getByRole('button', { name: /^2 earlier$/ }).click();
  await expect(group.getByRole('button', { name: 'one', exact: true }).locator('[data-harness="codex"]')).toBeVisible();
  await expect(group.getByRole('button', { name: 'two', exact: true }).locator('[data-harness="opencode"]')).toBeVisible();
  await shot(page, 'sidebar-marks');

  // Open a finished child: it stays visible once the rest fold.
  await group.getByRole('button', { name: 'one', exact: true }).click();
  await group.getByRole('button', { name: 'Show Fewer' }).click();
  await expect(group.getByRole('button', { name: 'one', exact: true })).toBeVisible();
  await expect(group.getByRole('button', { name: /^1 earlier$/ })).toBeVisible();

  // Fold the parent: only the open child stays under it.
  await sidebar(page).getByRole('button', { name: 'Fold the threads of e2e-parent' }).click();
  await expect(group.getByRole('button', { name: 'one', exact: true })).toBeVisible();
  await expect(group.getByRole('button', { name: 'four', exact: true })).toHaveCount(0);
  await shot(page, 'sidebar-folded');
});

test('the panel lists the children, Stop stops one, and Stop All the rest', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await unfold(page);
  await sidebar(page).getByRole('button', { name: 'e2e-parent', exact: true }).click();
  await page.getByRole('tab', { name: 'Info', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('heading', { name: 'Threads · 2 running' })).toBeVisible();
  const row = (title: string) => inspector.locator('[data-thread-row]').filter({ has: page.getByRole('button', { name: new RegExp(`^Open ${title},`) }) });
  await expect(row('four')).toHaveAttribute('data-state', 'running');
  await shot(page, 'panel-parent');

  // The keyboard reaches open, then Stop; Stop replaces the timer.
  await row('four').getByRole('button', { name: /^Open four/ }).focus();
  await page.keyboard.press('Tab');
  await expect(row('four').getByRole('button', { name: 'Stop four' })).toBeFocused();
  await expect(row('four').getByRole('button', { name: 'Stop four' })).toHaveCSS('opacity', '1');
  await shot(page, 'panel-stop-focus');

  // Stop one: its sibling and the parent's fold go on, and the parent hears of it.
  await page.keyboard.press('Enter');
  await expect(row('four')).toHaveAttribute('data-state', 'stopped', { timeout: 20_000 });
  await expect(row('five')).toHaveAttribute('data-state', 'running');
  await expect(inspector.getByRole('heading', { name: 'Threads · 1 running' })).toBeVisible();
  await expect(row('four').getByRole('button', { name: 'Stop four' })).toHaveCount(0);
  const report = page.getByText(/1 child thread reported: four \(stopped\)/);
  await expect(report).toBeVisible({ timeout: 20_000 });
  // Past the wake's 2 s batch: still one report, the sibling still works.
  await page.waitForTimeout(3000);
  await expect(report).toHaveCount(1);
  await expect(row('five')).toHaveAttribute('data-state', 'running');
  await shot(page, 'panel-one-stopped');

  // Stop All needs no second action.
  await inspector.getByRole('button', { name: 'Thread actions' }).click();
  await page.getByRole('menuitem', { name: 'Stop All Running' }).click();
  await expect(row('five')).toHaveAttribute('data-state', 'stopped', { timeout: 20_000 });
  await expect(inspector.getByRole('heading', { name: 'Threads', exact: true })).toBeVisible();

  // A child shows its parent, which opens it.
  await row('five').getByRole('button', { name: /^Open five/ }).click();
  await page.getByRole('tab', { name: 'Info', exact: true }).click();
  const up = inspector.getByRole('button', { name: 'Open the parent chat, e2e-parent' });
  await expect(up).toBeVisible();
  await expect(inspector.locator('[data-thread-row="parent"]')).toContainText('Idle');
  await shot(page, 'panel-child');
  await up.click();
  await page.getByRole('tab', { name: 'Info', exact: true }).click();
  await expect(inspector.getByRole('button', { name: /^Open five/ })).toBeVisible();
});

test('a child says who started it, and its first message is not yours', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await unfold(page);
  await sidebar(page).getByRole('button', { name: 'e2e-parent', exact: true }).click();
  // The parent's one line for each thread, with a way to it.
  const line = page.locator('[data-thread-start]').filter({ hasText: 'five' });
  await expect(line).toBeVisible();
  await shot(page, 'parent-line');
  await line.getByRole('button', { name: 'five' }).click();

  await expect(page.locator('[data-started-by]')).toContainText('Started by e2e-parent');
  await expect(page.locator('[data-sent-by]').first()).toHaveText('Sent by e2e-parent’s agent');
  await expect(page.locator('[data-mine="true"]')).toHaveCount(0);
  await shot(page, 'child-chat');

  // A person's message in a child runs here, as in any chat.
  await composer(page).fill('hello from a person');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-mine="true"]').filter({ hasText: 'hello from a person' })).toBeVisible();
  await shot(page, 'child-person');

  // The line opens the parent (tests/threads-delivery.test.ts: a person's turn does not wake it).
  await page.locator('[data-started-by]').getByRole('button', { name: 'e2e-parent' }).click();
  await expect(page.locator('[data-started-by]')).toHaveCount(0);
  await expect(page.locator('[data-thread-start]').filter({ hasText: 'five' })).toBeVisible();
});

test('a child whose parent was deleted stands on its own: Removed, with no way to open it', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await unfold(page);
  const parent = sidebar(page).getByRole('button', { name: 'e2e-parent', exact: true });
  await parent.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Delete…/ }).click();
  const ask = page.getByRole('alertdialog');
  // Delete's default keeps the threads.
  await expect(ask.getByRole('checkbox', { name: /Also delete its/ })).not.toBeChecked();
  await ask.getByRole('button', { name: /^Delete/ }).first().click();
  await expect(parent).toHaveCount(0, { timeout: 20_000 });
  await sidebar(page).getByRole('button', { name: 'five', exact: true }).click();
  await page.getByRole('tab', { name: 'Info', exact: true }).click();
  const up = page.getByRole('complementary', { name: 'Inspector' }).locator('[data-thread-row="parent"]');
  await expect(up).toContainText('Removed');
  await expect(up.getByRole('button')).toHaveCount(0);
});
