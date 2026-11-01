import { expect, test, type Page } from './fixtures.js';

/** A task's Agent row shows who works it, never changes it (BLG-569): what runs in its worktree, a click from its conversation; before it starts, who will. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const SHOTS = process.env.TASK_AGENT_SHOTS;

async function openTask(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: 'Tasks' }).click();
  const board = page.getByRole('button', { name: /^Board: / });
  if ((await board.getAttribute('aria-label')) !== 'Board: landing') {
    await board.click();
    await page.getByRole('menuitem', { name: /^landing/ }).click();
  }
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'List' }).click();
  await page.getByRole('row', { name: new RegExp(title) }).click();
}

test('a running task shows the agent in its worktree and opens its conversation; one not started says who will', async ({ page }) => {
  await openTask(page, 'New hero for the launch');
  const props = page.getByRole('complementary', { name: 'Properties' });
  const agent = props.getByRole('button', { name: /^Agent: Claude.*, in / });
  await expect(agent).toBeVisible();
  await expect(props.getByRole('combobox', { name: 'Agent and model that work this task' })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-agent-running.png` });
  await agent.click();
  await expect(page.getByRole('tablist', { name: 'Work' })).toBeHidden();

  await openTask(page, 'Pricing page copy');
  const ready = page.getByRole('complementary', { name: 'Properties' });
  await expect(ready.getByText(/^Your agent \(/)).toBeVisible();
  await expect(ready.getByRole('button', { name: /^Agent: / })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-agent-before-start.png` });
});
