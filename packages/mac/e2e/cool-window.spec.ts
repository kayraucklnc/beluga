import { expect, test, type Page } from './fixtures.js';

/**
 * Beluga's window stays cool while Claude works (KLD-40): what moves while Claude works moves with
 * one slow clock (lib/live-motion.ts), not CSS animations; while you're not looking at Beluga it
 * all rests, and the moment you look back it moves again. (Measured with scripts/cpu-bench.mjs.)
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
/** The light passing over "Working" in the working line at the bottom of Claude's card. */
const progress = (page: Page) => page.locator('[data-working] [class*="shimmer"]').last();
const travel = (page: Page) => progress(page).evaluate((el) => (el as HTMLElement).style.backgroundPosition);

/** As WebKit tells the page when you switch to another app (true) or back (false). */
async function lookAway(page: Page, away: boolean): Promise<void> {
  await page.evaluate((away) => {
    const w = window as unknown as { __away?: boolean };
    if (w.__away === undefined) {
      const hasFocus = document.hasFocus.bind(document);
      document.hasFocus = () => !w.__away && hasFocus();
    }
    w.__away = away;
    window.dispatchEvent(new Event(away ? 'blur' : 'focus'));
  }, away);
}

test('what moves while Claude works rests while you look away, and moves again when you look back', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-window', 'active');
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await composer(page).fill('Add rate limiting to the login endpoint, write tests, then run the whole suite');
  await composer(page).press('Enter');
  await expect(progress(page)).toBeVisible();

  // In front: the light travels (no CSS animation: the live clock writes it).
  const first = await travel(page);
  await expect.poll(() => travel(page), { timeout: 2000 }).not.toBe(first);
  expect(await progress(page).evaluate((el) => getComputedStyle(el).animationName)).toBe('none');

  // Another app in front: the window says it's idle, and nothing moves.
  await lookAway(page, true);
  await expect(page.locator('html')).toHaveAttribute('data-window', 'idle');
  if (await progress(page).isVisible()) {
    const resting = await travel(page);
    // A fixed wait, on purpose: it shows that nothing moves for a while.
    await page.waitForTimeout(500);
    expect(await travel(page)).toBe(resting);
  }

  // Back: moving again at once.
  await lookAway(page, false);
  await expect(page.locator('html')).toHaveAttribute('data-window', 'active');
  if (await progress(page).isVisible()) {
    const back = await travel(page);
    await expect.poll(() => travel(page), { timeout: 1000 }).not.toBe(back);
  }
});

test('while you look away, CSS animations pause, and looking back resumes them', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  // Any animation in the app: one is made here, so the rule is checked whatever is on screen.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '@keyframes kld40 { to { opacity: 0.5 } } #kld40 { animation: kld40 1s infinite; }';
    const el = Object.assign(document.createElement('div'), { id: 'kld40' });
    document.head.append(style);
    document.body.append(el);
  });
  const state = () => page.locator('#kld40').evaluate((el) => getComputedStyle(el).animationPlayState);
  expect(await state()).toBe('running');
  await lookAway(page, true);
  await expect.poll(state).toBe('paused');
  await lookAway(page, false);
  await expect.poll(state).toBe('running');
});
