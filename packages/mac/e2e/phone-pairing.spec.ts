import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Settings › Phone › Pair a Phone… while the pairing opens (BLG-73): one clear button, the same
 * size, with a small spinner and "Opening…" at full contrast. (It used to go 40% see-through and
 * narrower, and WebKit left the wider, hovered "Pair a Phone…" showing past its left edge: what
 * looked like a second square with a phone icon.)
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.klaud/scratch');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

for (const scheme of ['light', 'dark'] as const) {
  test(`Pair a Phone… opens as one button with a spinner (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await expect(sidebar(page)).toBeVisible();
    await page.keyboard.press('Meta+,');
    await settings(page).getByRole('button', { name: 'Phone', exact: true }).click();
    const pair = settings(page).getByRole('button', { name: 'Pair a Phone…' });
    await expect(pair).toBeVisible();
    const before = (await pair.boundingBox())!;
    await pair.hover();
    // The click and the look right after it, before the pairing can answer.
    const clicked = Date.now();
    const waiting = await pair.evaluate(async (el) => {
      el.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const shown = [...el.querySelectorAll('[data-shown]')].map((s) => s.textContent);
      const rect = el.getBoundingClientRect();
      return {
        busy: el.getAttribute('aria-busy'),
        disabled: (el as HTMLButtonElement).disabled,
        opacity: getComputedStyle(el).opacity,
        shown,
        spinner: Boolean(el.querySelector('[data-shown] [aria-hidden="true"]')),
        icons: el.querySelectorAll('svg').length,
        width: rect.width,
        height: rect.height,
      };
    });
    expect(waiting).toMatchObject({ busy: 'true', disabled: true, opacity: '1', shown: ['Opening…'], spinner: true });
    // The same size as before: nothing narrows, nothing is left behind.
    expect(Math.abs(waiting.width - before.width)).toBeLessThan(0.5);
    expect(Math.abs(waiting.height - before.height)).toBeLessThan(0.5);
    // Only one phone icon in the whole button (the hidden label's, kept for its room).
    expect(waiting.icons).toBe(1);
    await settings(page).screenshot({ path: path.join(SHOTS, `20-pair-opening-${scheme}.png`) });
    // The pairing opens (the QR), or says why it can't; either way the button is done waiting.
    await expect(settings(page).getByRole('img', { name: /Scan with the Beluga app/ }).or(settings(page).getByRole('button', { name: 'Pair a Phone…' }))).toBeVisible({ timeout: 30_000 });
    console.log(`pairing (${scheme}) answered in ${Date.now() - clicked} ms`);
    await settings(page).screenshot({ path: path.join(SHOTS, `21-pair-open-${scheme}.png`) });
    const cancel = settings(page).getByRole('button', { name: 'Cancel' });
    if (await cancel.isVisible()) await cancel.click();
  });
}
