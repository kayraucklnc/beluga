import { expect, test, type Page } from './fixtures.js';

/**
 * A project's environment, from the project itself (BLG-369): its main folder's .env shows under its
 * own variables, typing over one sets it in Beluga, and a worktree that changed its .env is asked
 * about on the project's page (Copy to Main Folder, or Keep Here).
 */

/** A second connection to the demo daemon from the page (the app's own boot code), for driving it. */
async function daemon<T>(page: Page, fn: string, arg: unknown): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const w = window as unknown as { __envDaemon?: Promise<unknown> };
      w.__envDaemon ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      const c = await w.__envDaemon;
      return new Function('c', 'arg', `return (${fn})(c, arg)`)(c, arg);
    },
    { fn, arg },
  ) as Promise<T>;
}

test("a project's Environment… shows its .env, and typing over a value sets it in Beluga", async ({ page }) => {
  const { writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const root = await daemon<string>(page, `(c) => c.store.getState().projects.find((p) => p.name === 'bob-api').root`, null);
  writeFileSync(path.join(root, '.env'), 'API_URL=https://api.example.com\nSTRIPE_KEY=sk_test_123\n');

  await sidebar.getByRole('button', { name: 'bob-api', exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Environment…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Environment for bob-api' });
  await expect(sheet.getByText('Include the main folder’s .env')).toBeVisible();
  await expect(sheet.getByRole('switch', { name: "Use the main folder's .env" })).toHaveAttribute('aria-checked', 'true');
  const fromFile = sheet.getByLabel(/^Value of API_URL \(from \.env/);
  await expect(fromFile).toHaveValue('https://api.example.com');
  await expect(fromFile).toHaveClass(/masked/);
  if (process.env.SHOTS) await sheet.screenshot({ path: `${process.env.SHOTS}/env-sheet-from-dotenv.png` });

  // Typing over it: now Beluga's, and it wins over the file.
  await fromFile.focus();
  await fromFile.evaluate((el: HTMLInputElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.type('/v2');
  const own = sheet.getByLabel('Value of API_URL', { exact: true });
  await expect(own).toHaveValue('https://api.example.com/v2');
  await expect(own).toBeFocused();
  await sheet.getByRole('button', { name: 'Show values', exact: true }).click();
  await sheet.getByLabel('Name', { exact: true }).first().click();
  await expect(sheet.getByRole('status').getByText('Saved')).toBeVisible();
  await expect(sheet.getByText('Changed here. The .env file is left as it is.')).toBeVisible();
  // It stayed where it was: still the first row.
  await expect(sheet.getByLabel('Name', { exact: true }).first()).toHaveValue('API_URL');
  if (process.env.SHOTS) await sheet.screenshot({ path: `${process.env.SHOTS}/env-sheet-override.png` });

  // Keep a copy in Beluga: the rest comes in too.
  await sheet.getByRole('button', { name: 'Keep a Copy in Beluga' }).click();
  await expect(sheet.getByLabel('Value of STRIPE_KEY', { exact: true })).toHaveValue('sk_test_123');
  // Use .env takes the override back.
  await sheet.getByRole('button', { name: 'Use .env' }).first().click();
  await expect(sheet.getByLabel(/^Value of API_URL \(from \.env/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Done' }).click();
});

test('a worktree that changed its .env is asked about on the project page, and Keep Here stops asking', async ({ page }) => {
  const { writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const { root, projectId } = await daemon<{ root: string; projectId: string }>(page, `(c) => { const p = c.store.getState().projects.find((p) => p.name === 'bob-api'); return { root: p.root, projectId: p.id }; }`, null);
  writeFileSync(path.join(root, '.env'), 'API_URL=https://api.example.com\n');
  const ws = await daemon<{ id: string; path: string; name: string }>(page, `async (c, projectId) => {
    const id = await c.api.workspaces.newWorktree(projectId, 'env-ask');
    for (let i = 0; i < 100; i++) {
      const ws = c.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === id && w.path);
      if (ws) return { id: ws.id, path: ws.path, name: ws.name };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('no worktree');
  }`, projectId);
  writeFileSync(path.join(ws.path, '.env'), 'API_URL=https://staging.example.com\nNEW_FLAG=1\n');
  await daemon(page, `(c, id) => c.api.workspaces.checkEnv(id)`, projectId);

  await sidebar.getByRole('button', { name: 'bob-api', exact: true }).first().click();
  const ask = page.getByRole('status', { name: 'Env changes in this worktree' }).filter({ hasText: ws.name });
  await expect(ask).toBeVisible();
  await expect(ask.getByText('+NEW_FLAG')).toBeVisible();
  await expect(ask.getByText('~API_URL')).toBeVisible();
  if (process.env.SHOTS) await page.locator('header').filter({ has: ask }).screenshot({ path: `${process.env.SHOTS}/env-ask-project-page.png` });
  await ask.getByRole('button', { name: 'Keep Here' }).click();
  await expect(ask).toHaveCount(0);
});
