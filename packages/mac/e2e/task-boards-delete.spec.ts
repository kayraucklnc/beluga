import { expect, test } from './fixtures.js';

/** A board of several repos is a view over them: deleting it sends its tasks home to their repos' boards (BLG-556). */

test('a board with tasks on it can be deleted: its tasks go back to their repos’ boards', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: 'Tasks' }).click();
  await page.getByRole('button', { name: /^Board: / }).click();
  await page.getByRole('menuitem', { name: 'New Board…' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Board' });
  await sheet.getByLabel('Name').fill('Launch');
  await sheet.getByRole('checkbox', { name: /landing/ }).click();
  await sheet.getByRole('button', { name: 'Create Board' }).click();
  await expect(sheet).toBeHidden();
  for (const [title, repo] of [['Pricing page', 'landing'], ['Plans endpoint', 'bob-api']] as const) {
    await page.getByRole('button', { name: 'New Task', exact: true }).first().click();
    const make = page.getByRole('dialog', { name: 'New Task' });
    await make.getByRole('button', { name: 'Write title and goal myself' }).click();
    await make.getByLabel('Title').fill(title);
    await make.getByRole('combobox', { name: 'Repo' }).click();
    await page.getByRole('option', { name: repo, exact: true }).click();
    await make.getByRole('button', { name: 'Create Task' }).click();
    await expect(make).toBeHidden();
  }
  await page.getByRole('button', { name: 'Tasks Options' }).click();
  await page.getByRole('menuitem', { name: 'Delete Board…' }).click();
  const confirm = page.getByRole('alertdialog', { name: /Delete the Launch board/ });
  await expect(confirm).toContainText('2 tasks go back');
  await confirm.getByRole('button', { name: 'Delete Board' }).click();
  await expect(page.getByText(/its 2 tasks are back/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Board: Launch' })).toBeHidden();
  await page.getByRole('button', { name: /^Board: / }).click();
  await expect(page.getByRole('menuitem', { name: /Launch/ })).toHaveCount(0);
  // Pricing page is on landing's board now.
  await page.getByRole('menuitem', { name: /^landing/ }).click();
  await expect(page.getByText('Pricing page', { exact: true })).toBeVisible();
});
