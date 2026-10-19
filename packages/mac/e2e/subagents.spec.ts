import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Sub-agents are Claude's helpers, not your worktrees: a pretend Claude Code session in the demo's
 * bob-api project starts a sub-agent in its own worktree (one the demo made under
 * .claude/worktrees). The sidebar shows it under what started it, with a robot, not as a
 * worktree; its page follows it live with its model and effort; a sub-agent worktree nobody
 * started from here waits in a folded "Sub-agents" row.
 */

test.describe.configure({ mode: 'serial' });

const SID = '5a0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';
const AGENT = 'a3f9c1e07b2d';
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const iso = (ms: number): string => new Date(ms).toISOString();
const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

let root = '';
let agentFile = '';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a sub-agent shows under what started it, as a robot, not as a worktree', async ({ page }) => {
  // The demo's projects sit side by side; a project row's tooltip is its folder (until it has news, so take either).
  const row = sidebar(page).locator('[title$="/bob-api"], [title$="/landing"]').first();
  await expect(row).toBeVisible();
  root = path.join(path.dirname((await row.getAttribute('title'))!), 'bob-api');
  const worktree = path.join(root, '.claude', 'worktrees', `agent-${AGENT}`);
  const folder = path.join(process.env.KLAUD_CLAUDE_HOME!, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  const agents = path.join(folder, SID, 'subagents');
  mkdirSync(agents, { recursive: true });
  const now = Date.now();
  writeFileSync(
    path.join(folder, `${SID}.jsonl`),
    line({ type: 'user', timestamp: iso(now - 4000), sessionId: SID, cwd: root, message: { role: 'user', content: 'Add tests for the webhook retries' } }) +
      line({ type: 'assistant', timestamp: iso(now - 3000), sessionId: SID, cwd: root, message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_W', name: 'Agent', input: { description: 'Write the webhook tests', subagent_type: 'typescript-reviewer', run_in_background: true, isolation: 'worktree' } }] } }),
  );
  writeFileSync(path.join(agents, `agent-${AGENT}.meta.json`), JSON.stringify({ agentType: 'typescript-reviewer', description: 'Write the webhook tests', toolUseId: 'toolu_W', requestShape: 'background', model: 'sonnet', worktreePath: worktree, worktreeBranch: `agent-${AGENT}`, spawnedWithWorktree: true }));
  agentFile = path.join(agents, `agent-${AGENT}.jsonl`);
  const said = (content: unknown[], at: number) => line({ type: 'assistant', timestamp: iso(at), sessionId: SID, agentId: AGENT, isSidechain: true, cwd: worktree, effort: 'high', message: { role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', content, usage: { input_tokens: 10, cache_read_input_tokens: 9000, output_tokens: 50 } } });
  writeFileSync(
    agentFile,
    line({ type: 'user', timestamp: iso(now - 2500), sessionId: SID, agentId: AGENT, isSidechain: true, cwd: worktree, message: { role: 'user', content: 'Write tests for the webhook retries' } }) +
      said([{ type: 'thinking', thinking: 'The retry logic lives in src/webhooks.ts; start by reading it.' }, { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: `${worktree}/src/webhooks.ts` } }], now - 2000),
  );

  // Under bob-api, as a sub-agent (robot, running), not among the worktrees.
  const agent = sidebar(page).getByRole('button', { name: /^Sub-agent Write the webhook tests, Running/ });
  await expect(agent).toBeVisible({ timeout: 20_000 });
  await expect(sidebar(page).getByRole('button', { name: new RegExp(`^agent-${AGENT}`) })).toHaveCount(0);
  // The other agent worktree the demo has: tucked into one folded row.
  const loose = sidebar(page).getByRole('group', { name: 'Sub-agent worktrees in bob-api' });
  await expect(loose.getByRole('button', { name: /Sub-agents\s*1/ })).toHaveAttribute('aria-expanded', 'false');
  await shot(page, 'subagents-sidebar');
});

test('its page follows it live: who started it, model, effort, thinking and tools', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: /^Sub-agent Write the webhook tests/ }).click();
  const monitor = page.locator(`[data-agent-monitor="${AGENT}"]`);
  await expect(monitor).toBeVisible({ timeout: 15_000 });
  await expect(monitor).toContainText('a Claude Code session outside Klaud in bob-api');
  await expect(monitor).toContainText('Write the webhook tests');
  await expect(monitor).toContainText('Sonnet 5.5');
  await expect(monitor).toContainText('High effort');
  await expect(monitor).toContainText('Its own worktree');
  const log = page.getByRole('log', { name: 'Sub-agent Write the webhook tests' });
  await expect(log).toContainText('Write tests for the webhook retries');
  await expect(log).toContainText('webhooks.ts');
  // New lines show as they're written.
  appendFileSync(agentFile, line({ type: 'assistant', timestamp: iso(Date.now()), sessionId: SID, agentId: AGENT, isSidechain: true, cwd: path.join(root, '.claude', 'worktrees', `agent-${AGENT}`), effort: 'high', message: { role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r2', name: 'Bash', input: { command: 'npm test -- webhooks' } }] } }));
  await expect(log).toContainText('npm test', { timeout: 15_000 });
  // Started outside Klaud: you can watch, not steer from here.
  await expect(monitor).toContainText('started outside Klaud');
  // Never a place to start a conversation of your own.
  await expect(page.getByRole('button', { name: 'Start a Conversation Here' })).toHaveCount(0);
  await shot(page, 'subagent-monitor');
});
