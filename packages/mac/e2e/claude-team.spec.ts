import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Claude Code agents messaging each other (SendMessage): a pretend session whose two named
 * agents are a team. Activity groups them under a Team header with their messages; a message
 * to an agent shows in its transcript as a row of its own; the lead's transcript says whom it
 * messaged. Written where the demo daemon looks (BELUGA_CLAUDE_HOME), in the "landing" project.
 */

const SID = '9a2b3c4d-1111-4c3e-9a8b-0123456789cd';
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const iso = (ms: number): string => new Date(ms).toISOString();
const line = (o: unknown): string => `${JSON.stringify(o)}\n`;

test('a team of agents shows its members, its messages, and messages in transcripts', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const project = sidebar(page).locator('[title$="/landing"]').first();
  await expect(project).toBeVisible();
  const cwd = (await project.getAttribute('title'))!;
  const folder = path.join(process.env.BELUGA_CLAUDE_HOME!, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const agents = path.join(folder, SID, 'subagents');
  mkdirSync(agents, { recursive: true });
  const t = Date.now() - 20_000;
  const entry = (o: Record<string, unknown>, at: number) => line({ timestamp: iso(at), sessionId: SID, cwd, ...o });
  const user = (content: unknown, at: number, extra: Record<string, unknown> = {}) => entry({ type: 'user', message: { role: 'user', content }, ...extra }, at);
  const assistant = (content: unknown[], at: number, stop: string | null = 'tool_use') => entry({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop } }, at);
  const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
  const main = path.join(folder, `${SID}.jsonl`);
  writeFileSync(
    main,
    line({ type: 'ai-title', aiTitle: 'Ship the pricing page', sessionId: SID }) +
      user('Build the pricing page with a reviewer', t) +
      assistant([tool('toolu_W', 'Agent', { description: 'Write the pricing page', prompt: 'write', name: 'writer', run_in_background: true }), tool('toolu_R', 'Agent', { description: 'Review the pricing page', prompt: 'review', name: 'critic', run_in_background: true })], t + 1000) +
      assistant([tool('m1', 'SendMessage', { to: 'critic', summary: 'Check the copy for jargon', message: 'Please **check the copy** for jargon before the layout.' })], t + 5000),
  );
  for (const [id, toolUseId, description] of [
    ['w1team', 'toolu_W', 'Write the pricing page'],
    ['r1team', 'toolu_R', 'Review the pricing page'],
  ] as const) writeFileSync(path.join(agents, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description, toolUseId, requestShape: 'background' }));
  writeFileSync(path.join(agents, 'agent-w1team.jsonl'), user('write', t + 2000) + assistant([tool('w-1', 'Edit', { file_path: `${cwd}/index.html`, old_string: 'a', new_string: 'b' })], t + 3000));
  writeFileSync(
    path.join(agents, 'agent-r1team.jsonl'),
    user('review', t + 2000) +
      user('The coordinator sent a message while you were working:\nPlease **check the copy** for jargon before the layout.', t + 5200, { isMeta: true, origin: { kind: 'coordinator' } }) +
      assistant([tool('r-1', 'SendMessage', { to: 'writer', summary: '"Synergy" in the hero is jargon', message: 'Replace "synergy" in the hero.' })], t + 6000),
  );
  appendFileSync(path.join(agents, 'agent-w1team.jsonl'), entry({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<agent-message from="r1team">\nReplace "synergy" in the hero.\n</agent-message>' } }, t + 6100));

  await sidebar(page).getByRole('button', { name: /^Activity/ }).click();
  const session = page.getByRole('region', { name: 'Claude Code session Ship the pricing page' });
  const team = session.getByRole('region', { name: 'Team' });
  await expect(team).toContainText('2 members', { timeout: 20_000 });
  await expect(team.getByRole('button', { name: /^Review the pricing page/ })).toContainText('@critic');
  const timeline = team.getByRole('list', { name: 'Messages in the team' });
  await expect(timeline).toContainText('Lead session→criticCheck the copy for jargon');
  await expect(timeline).toContainText('critic→writer"Synergy" in the hero is jargon');

  // The critic's transcript: the lead's message is a row of its own, opening to the whole message.
  await team.getByRole('button', { name: /^Review the pricing page/ }).click();
  const log = page.getByRole('log', { name: 'Agent Review the pricing page' });
  const message = log.locator('[data-received-message]');
  await expect(message).toContainText('Message from the lead session');
  await message.getByRole('button').click();
  await expect(message.locator('strong', { hasText: 'check the copy' })).toBeVisible();
  await expect(log).toContainText('→ sent to writer: "Synergy" in the hero is jargon');

  // The writer heard from the critic (each agent opens its own page, back in Activity's team).
  await sidebar(page).getByRole('button', { name: /^Activity/ }).click();
  await team.getByRole('button', { name: /^Write the pricing page/ }).click();
  await expect(page.getByRole('log', { name: 'Sub-agent Write the pricing page' }).locator('[data-received-message]')).toContainText('Message from critic');

  // The lead's transcript says whom it messaged, by name: the session opens its folder's chat, whose strip opens it.
  await sidebar(page).getByRole('button', { name: /^Activity/ }).click();
  await session.getByRole('button', { name: /^Ship the pricing page.*Open Chat/ }).click();
  const strip = page.getByRole('region', { name: 'Claude Code in this folder' });
  await strip.getByRole('button', { name: /Ship the pricing page/ }).click();
  await expect(page.getByRole('log', { name: 'Claude Code session Ship the pricing page' })).toContainText('→ sent to critic: Check the copy for jargon');

  // Done: both answer, so they stop counting as running for the specs after this one.
  const end = Date.now();
  appendFileSync(path.join(agents, 'agent-w1team.jsonl'), assistant([{ type: 'text', text: 'Done.' }], end, 'end_turn'));
  appendFileSync(path.join(agents, 'agent-r1team.jsonl'), assistant([{ type: 'text', text: 'Done.' }], end, 'end_turn'));
  appendFileSync(main, assistant([{ type: 'text', text: 'Shipped.' }], end, 'end_turn'));
});
