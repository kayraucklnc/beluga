import { expect, test, type Page } from '@playwright/test';

/**
 * Claude's steps open to show what ran and what came back (the demo's Claude records realistic
 * tool calls and a stretch of thinking), and a message you send flies from the box into the chat.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const lastSteps = (page: Page) => page.getByRole('list', { name: "Claude's steps" }).last();

async function openWorkspace(page: Page, name: string, project = 'bob-api'): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: project }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

/** Counts copies of a sent message flying in (they live for well under a second). */
async function countFlights(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { flights: number };
    w.flights = 0;
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement && n.dataset.sendFlight) w.flights++;
    }).observe(document.body, { childList: true, subtree: true });
  });
}
const flights = (page: Page) => page.evaluate(() => (window as unknown as { flights: number }).flights);

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a Bash step opens to show its command and output, and thinking opens to show the thinking', async ({ page }) => {
  await openWorkspace(page, 'new-hero', 'landing');
  await send(page, 'run the tests please');
  await expect(page.getByText(/Done in/).last()).toBeVisible({ timeout: 30_000 });
  const steps = lastSteps(page);
  const earlier = steps.getByRole('button', { name: /earlier step/ });
  if (await earlier.count()) await earlier.click();

  const bash = steps.locator('[data-step-kind="bash"]').last();
  // In words, never the tool's name.
  await expect(bash).toContainText('Ran npm test');
  const head = bash.getByRole('button', { name: /npm test/ });
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  // Keyboard: Return opens it, like any button.
  await head.focus();
  await page.keyboard.press('Enter');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  const detail = bash.locator('[data-step-detail="bash"]');
  await expect(detail.getByText('$ npm test')).toBeVisible();
  await expect(detail.getByText(/24 passed/)).toBeVisible();
  // The output's colours survive (green for passed).
  await expect(detail.locator('span', { hasText: '24 passed' }).first()).toHaveCSS('color', /rgb/);

  const thinking = steps.locator('[data-step-kind="thinking"]').first();
  await expect(thinking).toContainText(/Thought/);
  await thinking.getByRole('button').first().click();
  await expect(thinking.locator('[data-step-detail="thinking"]')).toContainText('They asked');

  // Collapse all, then Expand all (in the card's hover actions, next to Copy).
  await steps.hover();
  await page.getByRole('button', { name: 'Collapse all' }).last().click();
  await expect(steps.locator('[data-step-detail]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand all' }).last().click();
  await expect(steps.locator('[data-step-detail="bash"]')).toBeVisible();
  await expect(steps.locator('[data-step-detail="read"]')).toBeVisible();
});

test('a sent message flies from the box into the chat and lands in place', async ({ page }) => {
  await openWorkspace(page, 'new-hero', 'landing');
  await countFlights(page);
  await send(page, 'Summarize the hero section copy');
  const row = page.locator('[data-mine="true"]', { hasText: 'Summarize the hero section copy' }).last();
  await expect(row).toHaveAttribute('data-flown', 'true');
  await expect(row).toBeVisible();
  expect(await flights(page)).toBeGreaterThanOrEqual(1);
  // The copy is gone once it landed.
  await expect(page.locator('[data-send-flight]')).toHaveCount(0);
  await expect(page.getByText(/Done in/).last()).toBeVisible({ timeout: 30_000 });
});

test('with reduced motion, a sent message just appears', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWorkspace(page, 'new-hero', 'landing');
  await countFlights(page);
  await send(page, 'What does the hero say now?');
  const row = page.locator('[data-mine="true"]', { hasText: 'What does the hero say now?' }).last();
  await expect(row).toHaveAttribute('data-flown', 'instant');
  expect(await flights(page)).toBe(0);
  await expect(page.getByText(/Done in/).last()).toBeVisible({ timeout: 30_000 });
});

test('while Claude works, a sent message flies into the queue above the box', async ({ page }) => {
  await openWorkspace(page, 'new-hero', 'landing');
  await send(page, 'deep dive into the webhook code, take your time');
  await expect(page.getByText(/Working ·/).last()).toBeVisible();
  await countFlights(page);
  await send(page, 'then list the riskiest parts');
  const queued = page.getByRole('region', { name: 'Queued messages' }).locator('li', { hasText: 'then list the riskiest parts' });
  await expect(queued).toHaveAttribute('data-flown', 'true');
  expect(await flights(page)).toBeGreaterThanOrEqual(1);
  // Stop: the queued message comes back to the box.
  await page.getByRole('button', { name: 'Stop Claude' }).first().click();
  await expect(composer(page)).toHaveValue(/then list the riskiest parts/);
  await composer(page).fill('');
});
