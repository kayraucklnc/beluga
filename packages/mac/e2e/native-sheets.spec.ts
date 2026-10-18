import { expect, test, type Page } from '@playwright/test';

/**
 * The message box is only for messages: confirmations are alerts with Cancel, names and commands
 * are typed in sheets (or in place, like a new group), and nothing ever prefills a /command.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
/** The composer (sheets are portalled outside #root, so their text areas don't count). */
const composer = (page: Page) => page.locator('#root textarea:not(.xterm-helper-textarea)').first();

async function openWorkspace(page: Page, name = 'add-auth'): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click();
  await sidebar(page).getByRole('button', { name, exact: true }).click();
}

async function palette(page: Page, text: string, option: string | RegExp): Promise<void> {
  await page.keyboard.press('Meta+K');
  await page.getByPlaceholder('Go to, do, or start anything…').fill(text);
  await page.getByRole('option', { name: option }).first().click();
}

async function expectEmptyComposer(page: Page): Promise<void> {
  await expect(composer(page)).toHaveValue('');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('archiving asks in an alert, and Cancel (or Esc) does nothing', async ({ page }) => {
  await openWorkspace(page);
  await palette(page, 'Archive', /^Archive/);
  const alert = page.getByRole('alertdialog', { name: /Archive “add-auth”\?/ });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Archive' })).toBeFocused();
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(alert).toBeHidden();
  await palette(page, 'Archive', /^Archive/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toBeHidden();
  await expect(sidebar(page).getByRole('button', { name: 'add-auth', exact: true })).toBeVisible();
  await expectEmptyComposer(page);
});

test('a new group is named in place in the sidebar, then renamed and ungrouped', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Group' }).hover();
  await page.getByRole('menuitem', { name: 'New Group…' }).click();
  const name = sidebar(page).getByRole('textbox', { name: /new group for landing/ });
  await expect(name).toBeFocused();
  await name.fill('Side projects');
  await name.press('Enter');
  const group = sidebar(page).getByRole('button', { name: 'Group Side projects' });
  await expect(group).toBeVisible();
  await expectEmptyComposer(page);

  await group.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  const rename = sidebar(page).getByRole('textbox', { name: /New name for the group/ });
  await rename.fill('Weekend');
  await rename.press('Enter');
  const renamed = sidebar(page).getByRole('button', { name: 'Group Weekend' });
  await expect(renamed).toBeVisible();

  await renamed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Ungroup/ }).click();
  await expect(renamed).toBeHidden();
  await expect(sidebar(page).getByRole('button', { name: 'landing' }).first()).toBeVisible();
});

test("a project's Setup and Run commands are edited in a sheet and saved", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: /bob-api Settings/ });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('Run', { exact: true }).fill('npm run e2e-serve');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Run', { exact: true })).toHaveValue('npm run e2e-serve');
  await expect(page.getByRole('dialog').getByText('Your settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expectEmptyComposer(page);
});

test('forking asks for the name in a sheet, prefilled', async ({ page }) => {
  await openWorkspace(page);
  await palette(page, 'Fork', /Fork/);
  const sheet = page.getByRole('dialog', { name: 'Fork “add-auth”' });
  await expect(sheet.getByLabel('Name')).toHaveValue('add-auth-2');
  await expect(sheet.getByText('klaud/add-auth-2')).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
  await expectEmptyComposer(page);
});

test('palette commands open sheets and never prefill the message box', async ({ page }) => {
  await openWorkspace(page);
  await page.keyboard.press('Meta+K');
  await page.getByPlaceholder('Go to, do, or start anything…').fill('/pr');
  await expect(page.getByRole('option', { name: /<|\[/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  for (const [search, option, dialog] of [
    ['pull request', /pull request/i, /Pull Request|Connect GitHub/],
    ['new template', /New Template/, 'New Template'],
    ['name', /Change Your Name/, 'Settings'],
    ['environment', /Environment Variables/, 'Settings'],
  ] as const) {
    await palette(page, search, option);
    await expect(page.getByRole('dialog', { name: dialog })).toBeVisible();
    await expectEmptyComposer(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
});

test('templates: saved from a sheet (name, prompt, plan first), then picked from the list', async ({ page }) => {
  await palette(page, 'new template', /New Template/);
  const sheet = page.getByRole('dialog', { name: 'New Template' });
  await sheet.getByLabel('Name').fill('E2E docs');
  await sheet.getByLabel('Prompt').fill('Document the public API in README.md');
  await sheet.getByText('Plan first', { exact: true }).click();
  await sheet.getByRole('button', { name: 'Save Template' }).click();
  await expect(sheet).toBeHidden();
  await palette(page, 'manage templates', /Manage Templates/);
  const list = page.getByRole('dialog', { name: 'Templates' });
  await expect(list.getByText('E2E docs')).toBeVisible();
  await list.getByRole('button', { name: 'Remove E2E docs' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('dialog', { name: 'Templates' }).getByText('E2E docs')).toHaveCount(0);
  await expectEmptyComposer(page);
});

test('hiding a project asks first', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Hide this project/ }).click();
  const alert = page.getByRole('alertdialog', { name: /Hide “landing”\?/ });
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(sidebar(page).getByRole('button', { name: 'landing' }).first()).toBeVisible();
});

test('dragging a project onto a group moves it there, and out again ungroups it', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Group' }).hover();
  await page.getByRole('menuitem', { name: 'New Group…' }).click();
  const name = sidebar(page).getByRole('textbox', { name: /new group for landing/ });
  await name.fill('Drag here');
  await name.press('Enter');
  const group = sidebar(page).getByRole('button', { name: 'Group Drag here' });
  await expect(group).toContainText('1');
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().dragTo(group);
  await expect(group).toContainText('2');
  // Out to the plain list (it says so while you drag): the group keeps one.
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await page.mouse.down();
  await page.mouse.move(120, 300, { steps: 4 });
  const out = sidebar(page).getByText('Drop here to take it out of its group');
  await expect(out).toBeVisible();
  await out.hover();
  await page.mouse.up();
  await expect(group).toContainText('1');
  await group.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Ungroup/ }).click();
  await expect(group).toBeHidden();
});
