import { expect, test } from './fixtures.js';

/**
 * Your Mac's chats as tabs (BLG-102): + starts a new chat, the tabs switch between them, and ×
 * deletes one for good after asking.
 */
test('Your Mac holds several chats as tabs, and deletes one for good', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await sidebar.getByText('Your Mac', { exact: true }).click();
  const strip = page.getByRole('tablist', { name: 'Your Mac’s chats' });
  await expect(strip).toBeVisible();
  const tabs = strip.getByRole('tab');
  await expect(tabs).toHaveCount(1);

  // Something in the first chat, so it's named by it.
  const box = page.locator('textarea:not(.xterm-helper-textarea)');
  await box.fill('What is using my CPU?');
  await box.press('Enter');
  await expect(tabs.first()).toContainText('What is using my CPU?');

  // A second chat: a new tab, open and empty.
  await page.getByRole('button', { name: 'New chat with Your Mac' }).click();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Ask your Mac', { exact: true })).toBeVisible();
  await box.fill('Take a screenshot');
  await box.press('Enter');
  await expect(tabs.nth(1)).toContainText('Take a screenshot');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/01-tabs.png` });

  // Back to the first: its conversation is still there.
  await tabs.first().click();
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('What is using my CPU?').last()).toBeVisible();

  // Delete the second, after saying yes.
  await tabs.nth(1).hover();
  await strip.getByRole('button', { name: 'Delete this chat' }).nth(1).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Delete “Take a screenshot”?');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/02-delete-confirm.png` });
  await ask.getByRole('button', { name: 'Delete Chat' }).click();
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toContainText('What is using my CPU?');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/03-after-delete.png` });
});

/**
 * Deleting the open chat opens the one beside it, and a worktree named in that one (`worktree:<id>`)
 * is a chip: its pick built a new object on every read, which React took for a store that never
 * settles and gave up on (#185, "This view ran into a problem").
 */
test('Your Mac deletes the open chat; the one beside it shows its worktree chip', async ({ page }) => {
  await page.goto('/');
  // A worktree the demo has, asked of the daemon over a second connection (the app's own boot code).
  const wt = await page.evaluate(async () => {
    const boot = await import('/src/lib/boot.ts');
    const c = await boot.connect(boot.capabilities(() => ({ ok: true, message: '' })));
    const w = c.store.getState().projects.flatMap((p) => p.workspaces).find((x) => x.kind === 'worktree' && !x.archived)!;
    return { id: w.id, name: w.name };
  });
  await page.getByRole('navigation', { name: 'Sidebar' }).getByText('Your Mac', { exact: true }).click();
  const strip = page.getByRole('tablist', { name: 'Your Mac’s chats' });
  const tabs = strip.getByRole('tab');
  const box = page.locator('textarea:not(.xterm-helper-textarea)');
  await box.fill(`How is \`worktree:${wt.id}\` doing?`);
  await box.press('Enter');
  const chip = page.getByRole('button', { name: new RegExp(`^Worktree ${wt.name} in `) }).first();
  await expect(chip).toBeVisible();

  const count = (await tabs.count()) + 1;
  await page.getByRole('button', { name: 'New chat with Your Mac' }).click();
  await expect(tabs).toHaveCount(count);
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  await box.fill('Take a screenshot');
  await box.press('Enter');
  await expect(tabs.last()).toContainText('Take a screenshot');
  await tabs.last().hover();
  await strip.getByRole('button', { name: 'Delete this chat' }).last().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Chat' }).click();
  await expect(tabs).toHaveCount(count - 1);
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  await expect(chip).toBeVisible();
  await expect(page.getByText('This view ran into a problem')).toHaveCount(0);
});
