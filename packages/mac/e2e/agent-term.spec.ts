import { expect, test, type Page } from './fixtures.js';

/**
 * The terminal view (BLG-534, BLG-535, BLG-536): a conversation shown as its agent's own terminal
 * (the demo's stand-in for Claude Code), its graph and table as links that open beside it, its
 * turns back in the chat, shells split beside it, and Take over giving the conversation back.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const modes = (page: Page) => page.getByRole('tablist', { name: 'Show the conversation as' });

async function openWorkspace(page: Page, name: string): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

/** What a terminal shows, as text (its buffer, read through the dev build's hook). */
const screen = (page: Page, key: RegExp) =>
  page.evaluate((src) => {
    const terms = (window as unknown as { __belugaTerms?: Record<string, { buffer: { active: { length: number; getLine: (y: number) => { translateToString: (t: boolean) => string } | undefined } } }> }).__belugaTerms ?? {};
    const re = new RegExp(src);
    const entry = Object.entries(terms).find(([k]) => re.test(k));
    if (!entry) return '';
    const buf = entry[1].buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
    return lines.join('\n');
  }, key.source);

async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page.locator('[data-pane="agent"] .xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('a conversation as its agent’s terminal: links open visuals beside it, and the chat keeps up', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await openWorkspace(page, 'webhook-retries');
  await expect(page.getByRole('button', { name: 'Stop Claude' })).toHaveCount(0, { timeout: 90_000 });

  await modes(page).getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.locator('[data-pane="agent"] .xterm')).toBeVisible();
  await expect.poll(() => screen(page, /:agent$/), { timeout: 20_000 }).toContain('Claude Code');
  // It sits at the bottom, as a chat does: the screen is moved down while its lines don't fill it.
  await expect(page.locator('[data-pane="agent"] .xterm')).toHaveCSS('transform', /^matrix\(1, 0, 0, 1, 0, [1-9]/);

  // A graph: its link is drawn over the token, and opens the real graph beside the terminal.
  await typeInTerminal(page, 'map how a payment flows');
  const chip = page.locator('[data-visual]').filter({ hasText: 'How a payment goes through' });
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(chip).toContainText('Open');
  await chip.dispatchEvent('mousedown', { button: 0 });
  const panel = page.getByRole('region', { name: 'Visuals' });
  await expect(panel.getByRole('figure', { name: 'Graph: How a payment goes through' })).toBeVisible();
  await page.screenshot({ path: '../../.beluga/scratch/terminal-real/01-graph-beside.png' });

  // A table: ⌘↩ opens the newest visual, a tab of its own.
  await typeInTerminal(page, 'show the customers table');
  await expect(page.locator('[data-visual]').filter({ hasText: 'Customers by revenue' })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Meta+Enter');
  await expect(panel.getByRole('tab', { name: 'Customers by revenue' })).toHaveAttribute('aria-selected', 'true');
  // The live table, as the chat draws it: its controls work without the agent.
  await expect(panel.getByRole('figure', { name: 'Table: Customers by revenue' })).toBeVisible();
  await expect(panel.getByRole('cell', { name: 'Globex' })).toBeVisible();
  await panel.getByRole('radio', { name: 'Top 5' }).click();
  await expect(panel.getByRole('table').getByRole('row')).toHaveCount(6);
  await page.screenshot({ path: '../../.beluga/scratch/terminal-real/02-table-beside.png' });
  await panel.getByRole('button', { name: 'Close the Panel' }).click();
  await expect(panel).toHaveCount(0);

  // Both: the chat beside the terminal has the terminal's turns, drawn; the terminal drives.
  await modes(page).getByRole('tab', { name: 'Both' }).click();
  await expect(page.getByText('map how a payment flows').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('figure', { name: 'Graph: How a payment goes through' }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'terminal is driving this conversation' })).toBeVisible();
  await expect(composer(page)).toHaveCount(0);
  await page.screenshot({ path: '../../.beluga/scratch/terminal-real/03-both.png' });

  // Take over: the chat has the conversation again, and its message box.
  await page.getByRole('button', { name: 'Take Over' }).click();
  await expect(composer(page)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'terminal is driving' })).toHaveCount(0);
  await modes(page).getByRole('tab', { name: 'Chat' }).click();
  await expect(page.getByText('show the customers table').first()).toBeVisible();
});

test('shells split beside the agent’s terminal', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await openWorkspace(page, 'add-auth');
  await modes(page).getByRole('tab', { name: 'Terminal' }).click();
  await expect.poll(() => screen(page, /:agent$/), { timeout: 20_000 }).toContain('Claude Code');
  await page.locator('[data-pane="agent"] .xterm').click();
  await page.keyboard.press('Meta+d');
  await expect(page.locator('[data-pane="shell"] .xterm')).toBeVisible();
  await page.keyboard.press('Meta+Shift+d');
  await expect(page.locator('[data-pane="shell"]')).toHaveCount(2);
  await page.screenshot({ path: '../../.beluga/scratch/terminal-real/04-splits.png' });
  // A shell closes; the agent's terminal stays.
  await page.locator('[data-pane="shell"]').first().hover();
  await page.locator('[data-pane="shell"]').first().getByRole('button', { name: 'Close This Shell' }).click();
  await expect(page.locator('[data-pane="shell"]')).toHaveCount(1);
  await expect(page.locator('[data-pane="agent"]')).toHaveCount(1);
});

test('a preset theme (Dracula) is the agent’s terminal’s, links in its colours; tabs hold shells', async ({ page }) => {
  test.setTimeout(90_000);
  const dracula = { name: 'Dracula', from: 'Beluga', colors: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selection: '#44475a', ansi: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'] } };
  await page.addInitScript((theme) => {
    const prefs = JSON.parse(localStorage.getItem('beluga.prefs.v1') ?? '{}');
    localStorage.setItem('beluga.prefs.v1', JSON.stringify({ ...prefs, appearance: 'dark', inspector: false, termTheme: theme, termFontSize: 13 }));
  }, dracula);
  await page.goto('/');
  await openWorkspace(page, 'webhook-retries');
  await modes(page).getByRole('tab', { name: 'Terminal' }).click();
  await expect.poll(() => screen(page, /:agent$/), { timeout: 20_000 }).toContain('Claude Code');
  await typeInTerminal(page, 'map how a payment flows');
  const chip = page.locator('[data-visual]').filter({ hasText: 'How a payment goes through' }).last();
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-pane="agent"]')).toHaveCSS('--chip-accent', '#bd93f9');
  await typeInTerminal(page, 'show the customers table');
  await expect(page.locator('[data-visual]').filter({ hasText: 'Customers by revenue' }).last()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: '../../.beluga/scratch/terminal-real/05-dracula.png' });
  // The right panel in and out: the terminal is fitted once it settles, and nothing it said is lost.
  await page.keyboard.press('Alt+Meta+0');
  await page.waitForTimeout(450);
  await page.keyboard.press('Alt+Meta+0');
  await page.waitForTimeout(450);
  const after = await screen(page, /:agent$/);
  expect(after).toContain('Your top customers by revenue:');
  expect(after).toContain('Here is how a payment moves through the system:');
  await expect(page.locator('[data-visual]').filter({ hasText: 'Customers by revenue' }).last()).toBeVisible();
  await chip.dispatchEvent('mousedown', { button: 0 });
  await expect(page.getByRole('region', { name: 'Visuals' }).getByRole('figure', { name: 'Graph: How a payment goes through' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Visuals' }).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: '../../.beluga/scratch/terminal-real/06-dracula-graph.png' });

  // A new tab: a shell of its own; ⌘1 goes back to the agent's.
  await page.getByRole('button', { name: 'New Tab' }).click();
  const tabs = page.getByRole('tablist', { name: 'Terminal tabs' });
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await expect(tabs.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-tab-shown="true"] [data-pane="shell"] .xterm')).toBeVisible();
  await page.keyboard.press('Meta+1');
  await expect(tabs.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
});
