import { expect, test } from '@playwright/test';

/**
 * Folded, a project still says Claude is at work inside it (the dot matrix on its row), beside
 * whatever count or "needs you" mark it has, never hidden by them.
 */
test('a folded project shows Claude working inside it', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  // Projects start folded: show what's in bob-api first.
  const show = sidebar.getByRole('button', { name: /^Show what's in bob-api/ });
  if (await show.isVisible()) await show.click();
  await sidebar.getByRole('button', { name: 'webhook-retries', exact: true }).click();
  const box = page.locator('textarea:not(.xterm-helper-textarea)');
  await expect(box).toHaveAttribute('placeholder', /webhook-retries/);
  const fold = sidebar.getByRole('button', { name: /^Fold bob-api/ });
  await fold.click();
  await box.fill('run the tests please');
  await box.press('Enter');
  const row = sidebar.getByRole('button', { name: 'bob-api', exact: true });
  await expect(row.locator('[data-busy] [data-dot-matrix]')).toBeVisible({ timeout: 10_000 });
  // Unfold it again for the other tests.
  await sidebar.getByRole('button', { name: /^Show what's in bob-api/ }).click();
});

test('a folded project shows Claude Code working in one of its folders', async ({ page }) => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  const landing = sidebar.locator('[title$="/landing"]').first();
  await expect(landing).toBeVisible();
  const cwd = (await landing.getAttribute('title'))!;
  // Claude Code, running outside klaud in the project's folder (mid-turn: it just called a tool).
  const sid = '0b7e6c1d-2a3f-4e5d-8c9b-a1b2c3d4e5f6';
  const folder = path.join(process.env.KLAUD_CLAUDE_HOME!, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    path.join(folder, `${sid}.jsonl`),
    [
      { type: 'user', timestamp: now, sessionId: sid, cwd, message: { role: 'user', content: 'tidy the hero' } },
      { type: 'assistant', timestamp: now, sessionId: sid, cwd, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${cwd}/README.md` } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  const fold = sidebar.getByRole('button', { name: /^Fold landing/ });
  if (await fold.isVisible()) await fold.click();
  const row = sidebar.getByRole('button', { name: 'landing', exact: true }).first();
  await expect(row.locator('[data-busy] [data-dot-matrix]')).toBeVisible({ timeout: 20_000 });
  await sidebar.getByRole('button', { name: /^Show what's in landing/ }).click();
});
