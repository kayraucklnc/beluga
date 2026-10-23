import { expect, test, type Page } from './fixtures.js';

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
  // Claude Code, running outside Beluga in the project's folder (mid-turn: it just called a tool).
  const sid = '0b7e6c1d-2a3f-4e5d-8c9b-a1b2c3d4e5f6';
  const folder = path.join(process.env.BELUGA_CLAUDE_HOME!, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
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

/** A second connection to the demo daemon from the page (the app's own boot code), for driving it. */
async function daemon<T>(page: Page, fn: string, arg: unknown): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const w = window as unknown as { __busy?: Promise<unknown> };
      w.__busy ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      const c = await w.__busy;
      return new Function('c', 'arg', `return (${fn})(c, arg)`)(c, arg);
    },
    { fn, arg },
  ) as Promise<T>;
}

test('after a force-quit mid-run and a restart, the run left "started" in saved history shows as not running', async ({ page }) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  // A worktree this daemon hasn't loaded yet: what it reads is only what was saved, as after a restart.
  const { root, selfId } = await daemon<{ root: string; selfId: string }>(page, `(c) => ({ root: c.store.getState().projects.find((p) => p.name === 'bob-api').root, selfId: c.store.getState().selfId })`, null);
  const tree = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-e2e-quit-')), 'force-quit-left');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'force-quit-left', tree], { cwd: root, stdio: 'pipe' });
  try {
    const id = await daemon<string>(page, `async (c, tree) => {
      await c.api.workspaces.refresh();
      return c.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.path === tree || w.name === 'force-quit-left').id;
    }`, tree);
    // Its saved history, as a force-quit leaves it: the run started and nothing after (where the daemon says it keeps it).
    const home = (JSON.parse(readFileSync(path.join(process.env.BELUGA_HOME!, 'daemon.json'), 'utf8')) as { workspaces?: string }).workspaces;
    expect(home, 'daemon.json names its workspaces folder').toBeTruthy();
    const history = path.join(home!, 'history');
    mkdirSync(history, { recursive: true });
    const at = Date.now() - 60_000;
    const run = { id: 'quit-1', type: 'agent', channel: `ws:${id}`, requestId: 'quit-req', owner: selfId, ownerName: 'you', requesterName: 'you', requester: selfId, prompt: 'deep dive, take your time', status: 'started', text: '', steps: ['Read src/server.ts'], subagents: [], ts: at, lastAt: at };
    writeFileSync(path.join(history, `${id.replace(/[^\w.-]/g, '_')}.json`), JSON.stringify([run]));

    const show = sidebar.getByRole('button', { name: /^Show what's in bob-api/ });
    if (await show.isVisible()) await show.click();
    const row = sidebar.getByRole('button', { name: 'force-quit-left', exact: true });
    await row.click();
    // Loaded: the card says it was interrupted, and nothing says Claude is at work there.
    const card = page.locator('[data-turn]');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-turn', 'interrupted');
    await expect(row).not.toHaveAttribute('data-signal-row', 'working');
    await page.getByRole('button', { name: /^Fold bob-api/ }).first().click();
    await expect(sidebar.getByRole('button', { name: 'bob-api', exact: true }).locator('[data-busy]')).toHaveCount(0);
    expect(await daemon<number>(page, `(c, ch) => c.store.getState().log.filter((l) => l.channel === ch && ['started', 'text', 'tool', 'sub', 'queued', 'awaiting_approval'].includes(l.status)).length`, `ws:${id}`)).toBe(0);
    await sidebar.getByRole('button', { name: /^Show what's in bob-api/ }).click();
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', tree], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['branch', '-D', 'force-quit-left'], { cwd: root, stdio: 'pipe' });
    await daemon(page, `(c) => c.api.workspaces.refresh()`, null).catch(() => undefined);
  }
});
