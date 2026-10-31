import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Beluga's pop-up buttons (components/Select.tsx) aren't native <select>s, so Playwright's
 * selectOption and toHaveValue don't apply: click it, then the option; the value is `data-value`.
 */

type Scope = Page | Locator;
const pageOf = (scope: Scope): Page => ('goto' in scope ? scope : scope.page());

/** The pop-up button named `label` (its aria-label). */
export const popup = (scope: Scope, label: string | RegExp): Locator => scope.getByRole('combobox', { name: label });

/** The open menu (it's in a portal, outside any sheet). */
export const popupMenu = (page: Page): Locator => page.getByRole('listbox');

/** Opens the pop-up named `label` and picks `option` (a string matches the option's label exactly). */
export async function pick(scope: Scope, label: string | RegExp, option: string | RegExp): Promise<void> {
  const page = pageOf(scope);
  await popup(scope, label).click();
  await popupMenu(page)
    .getByRole('option', { name: option, exact: typeof option === 'string' })
    .click();
  await expect(popupMenu(page)).toHaveCount(0);
}

/** The pop-up shows this value (an option's value, not its label). */
export async function expectPicked(button: Locator, value: string | RegExp): Promise<void> {
  await expect(button).toHaveAttribute('data-value', value);
}

/** The labels of a pop-up's options, read by opening it (then closing it with Esc). */
export async function optionLabels(button: Locator): Promise<string[]> {
  const page = button.page();
  await button.click();
  const labels = await popupMenu(page).locator('[data-option-label]').allTextContents();
  await page.keyboard.press('Escape');
  await expect(popupMenu(page)).toHaveCount(0);
  return labels;
}

/** Plans: the sidebar's Work row (Tasks, Issues, Actions and Plans, BLG-197), then its Plans tab. */
export async function openPlans(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Work/ }).first().click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: /^Plans/ }).click();
}
