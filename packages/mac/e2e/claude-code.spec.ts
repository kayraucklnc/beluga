import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Claude Code running outside Beluga, live and read-only: a pretend session with background agents
 * is written where the demo daemon looks (BELUGA_CLAUDE_HOME, see playwright.config.ts), in the
 * demo's "landing" project. Activity lists it with its agents; an agent opens its own page, which
 * follows new lines as they're written, and turns Finished when the session hears it's done; the
 * session, in the main folder (no conversation of its own, BLG-70), opens as its transcript.
 */

test.describe.configure({ mode: 'serial' });

const SID = '7e1d0c2a-5b4f-4c3e-9a8b-0123456789ab';
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const iso = (ms: number): string => new Date(ms).toISOString();
const line = (o: unknown): string => `${JSON.stringify(o)}\n`;

let cwd = '';
let folder = '';
const user = (text: string, at = Date.now()) => line({ type: 'user', timestamp: iso(at), sessionId: SID, cwd, message: { role: 'user', content: text } });
const assistant = (content: unknown[], stop: string | null = 'tool_use', at = Date.now()) => line({ type: 'assistant', timestamp: iso(at), sessionId: SID, cwd, message: { role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, usage: { input_tokens: 10, cache_read_input_tokens: 12000, output_tokens: 80 } } });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a Claude Code session and its agents show in Activity, live', async ({ page }) => {
  // The demo's landing project: its folder is the project row's tooltip.
  const row = sidebar(page).locator('[title$="/landing"]').first();
  await expect(row).toBeVisible();
  cwd = (await row.getAttribute('title'))!;
  const home = process.env.BELUGA_CLAUDE_HOME!;
  folder = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const agents = path.join(folder, SID, 'subagents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(folder, `${SID}.jsonl`),
    line({ type: 'ai-title', aiTitle: 'Polish the landing page', sessionId: SID }) +
      user('Polish the landing page, and review it') +
      assistant([tool('toolu_A', 'Agent', { description: 'Tighten the hero copy', subagent_type: 'general-purpose' }), tool('toolu_B', 'Agent', { description: 'Review the CSS', subagent_type: 'typescript-reviewer' })]),
  );
  for (const [id, toolUseId, description, type] of [
    ['a1e2e', 'toolu_A', 'Tighten the hero copy', 'general-purpose'],
    ['b2e2e', 'toolu_B', 'Review the CSS', 'typescript-reviewer'],
  ] as const) {
    writeFileSync(path.join(agents, `agent-${id}.meta.json`), JSON.stringify({ agentType: type, description, toolUseId, spawnDepth: 1, requestShape: 'background' }));
    writeFileSync(path.join(agents, `agent-${id}.jsonl`), user(`Task: ${description}`) + assistant([tool(`${id}-1`, 'Read', { file_path: `${cwd}/index.html` })]));
  }

  const activity = sidebar(page).getByRole('button', { name: /^Activity/ });
  await expect(activity).toContainText('2', { timeout: 20_000 });
  await activity.click();
  await expect(page.getByRole('heading', { name: '2 agents running' })).toBeVisible();
  const session = page.getByRole('region', { name: 'Claude Code session Polish the landing page' });
  await expect(session).toContainText('landing');
  const card = session.getByRole('button', { name: /^Tighten the hero copy, Running, Reading index.html/ });
  await expect(card).toBeVisible();
  await expect(session.getByRole('button', { name: /^Review the CSS, Running/ })).toContainText('TypeScript reviewer');

  // An agent opens its own page (it has no worktree of its own), following new lines.
  await expect(session).not.toContainText('Watch');
  await card.click();
  await expect(page.locator('[data-agent-monitor="a1e2e"]')).toBeVisible();
  const log = page.getByRole('log', { name: 'Sub-agent Tighten the hero copy' });
  await expect(log).toContainText('Task: Tighten the hero copy');
  await expect(log).toContainText('Reading index.html');
  appendFileSync(path.join(agents, 'agent-a1e2e.jsonl'), assistant([tool('a1e2e-2', 'Edit', { file_path: `${cwd}/index.html` })]));
  await expect(log).toContainText('Editing index.html', { timeout: 15_000 });

  // It answers and the session hears it finished.
  appendFileSync(path.join(agents, 'agent-a1e2e.jsonl'), assistant([{ type: 'text', text: 'The hero now says **one thing**.' }], 'end_turn'));
  appendFileSync(
    path.join(folder, `${SID}.jsonl`),
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(Date.now() + 500), sessionId: SID, content: '<task-notification>\n<task-id>a1e2e</task-id>\n<tool-use-id>toolu_A</tool-use-id>\n<status>completed</status>\n<summary>Agent "Tighten the hero copy" finished</summary>\n</task-notification>' }),
  );
  await expect(log).toContainText('The hero now says one thing.', { timeout: 15_000 });
  await expect(activity).toContainText('1', { timeout: 15_000 });
  await activity.click();
  await expect(session.getByRole('button', { name: /^Tighten the hero copy, Finished/ })).toBeVisible({ timeout: 15_000 });

  // It runs in the project's main folder, which has no conversation of its own (BLG-70): it opens as its transcript.
  await expect(session.getByRole('button', { name: /Open Chat/ })).toHaveCount(0);
  await session.getByRole('button', { name: /^Polish the landing page.*Open/ }).click();
  await expect(page.getByRole('log', { name: 'Claude Code session Polish the landing page' })).toContainText('Polish the landing page, and review it');
});

test('a main folder’s session opens its transcript, and Activity goes back to the list', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: /^Activity/ }).click();
  await page.getByRole('region', { name: 'Claude Code session Polish the landing page' }).getByRole('button', { name: /^Polish the landing page/ }).click();
  await expect(page.getByRole('log', { name: 'Claude Code session Polish the landing page' })).toBeVisible();
  await sidebar(page).getByRole('button', { name: /^Activity/ }).click();
  await expect(page.getByRole('heading', { name: /agent.* running|working|Nothing running/ })).toBeVisible();
});
