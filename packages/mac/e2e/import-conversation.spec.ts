import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Bring In a Claude Code Conversation… (BLG-321): conversations had with Claude Code outside
 * Beluga, written where the demo daemon looks (BELUGA_CLAUDE_HOME), in the demo's "landing"
 * project and a folder inside it. The project's ••• opens the sheet; one goes on in a new worktree.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shots = process.env.E2E_SHOTS;

/** A short transcript, filed the way Claude Code files it, last active `ago` ms back. */
function writeSession(cwd: string, id: string, title: string, turns: Array<[string, string]>, ago: number): void {
  const folder = path.join(process.env.BELUGA_CLAUDE_HOME!, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  const t0 = Date.now() - ago;
  const lines = turns.flatMap(([ask, answer], i) => [
    { type: 'user', timestamp: new Date(t0 + i * 2000).toISOString(), sessionId: id, cwd, uuid: `${id}-u${i}`, parentUuid: i ? `${id}-a${i - 1}` : null, message: { role: 'user', content: ask } },
    { type: 'assistant', timestamp: new Date(t0 + i * 2000 + 1000).toISOString(), sessionId: id, cwd, uuid: `${id}-a${i}`, parentUuid: `${id}-u${i}`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: answer }] } },
  ]);
  const file = path.join(folder, `${id}.jsonl`);
  writeFileSync(file, [...lines, { type: 'ai-title', aiTitle: title, sessionId: id }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  utimesSync(file, new Date(t0), new Date(t0));
}

test('a conversation from outside Beluga goes on in a new worktree', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const row = sidebar(page).locator('[title$="/landing"]').first();
  await expect(row).toBeVisible();
  const root = (await row.getAttribute('title'))!;
  writeSession(root, '11111111-1111-4111-8111-111111111111', 'Hero section feels cramped on mobile', [['The hero feels cramped on phones. Why?', 'The headline has a fixed 64px size and the padding never shrinks below 48px.'], ['What would you change?', 'A clamp() for the headline and padding that follows the viewport. Want me to do it?']], 2 * 3600_000);
  writeSession(path.join(root, 'styles'), '22222222-2222-4222-8222-222222222222', 'Dark mode colors for the pricing table', [['Pick dark mode colors for the pricing table', 'Here are three pastel options that keep contrast above 4.5:1.']], 26 * 3600_000);
  writeSession(root, '33333333-3333-4333-8333-333333333333', 'Why does the signup form submit twice?', [['Signup submits twice', 'The button is type=submit and also calls submit() on click.']], 4 * 86_400_000);

  await row.hover();
  await page.getByRole('button', { name: 'More for landing' }).click();
  await page.getByRole('menuitem', { name: 'Bring In a Claude Code Conversation…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Bring In a Claude Code Conversation' });
  const list = sheet.getByRole('radiogroup', { name: 'Claude Code conversations' });
  await expect(list.getByRole('radio')).toHaveCount(3);
  await expect(list.getByRole('radio').nth(0)).toContainText('Hero section feels cramped on mobile');
  await expect(list.getByRole('radio').nth(1)).toContainText('styles');
  await expect(sheet.getByLabel('Name')).toHaveValue('Hero section feels cramped on mobile');
  if (shots) await sheet.screenshot({ path: path.join(shots, '01-import-sheet.png') });

  await sheet.getByRole('button', { name: 'Continue in a Worktree' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText('The hero feels cramped on phones. Why?')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('A clamp() for the headline and padding that follows the viewport. Want me to do it?')).toBeVisible();
  await expect(page.getByText(/^On a new branch from where landing is/)).toBeVisible();
  if (shots) await page.screenshot({ path: path.join(shots, '02-imported-worktree.png') });

  // Opened again: it's marked, and the button opens its worktree.
  await row.hover();
  await page.getByRole('button', { name: 'More for landing' }).click();
  await page.getByRole('menuitem', { name: 'Bring In a Claude Code Conversation…' }).click();
  await expect(list.getByRole('radio').nth(0)).toContainText('Brought in already');
  await list.getByRole('radio').nth(0).click();
  await expect(sheet.getByRole('button', { name: 'Open Its Worktree' })).toBeVisible();
  if (shots) await sheet.screenshot({ path: path.join(shots, '03-already-brought-in.png') });
});
