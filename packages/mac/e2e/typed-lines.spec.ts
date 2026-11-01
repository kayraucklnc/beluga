import path from 'node:path';
import { expect, test } from './fixtures.js';

/**
 * What you type keeps its shape (BLG-567): a line you broke stays broken, and blank lines you left
 * stay as room between the words, instead of folding into one Markdown paragraph break.
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.beluga/scratch');

test('blank lines and broken lines you typed show in the sent message', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: 'Group chat' }).click();
  const box = page.locator('main textarea:not(.xterm-helper-textarea)').last();
  await box.fill('in the chat if I type new line like\n\n\n\nthis\nand one more line');
  await box.press('Enter');

  const sent = page.locator('[data-mine="true"]').filter({ hasText: 'and one more line' }).last();
  await expect(sent).toBeVisible();
  // Three blank lines: the paragraph break, then a paragraph holding the two more.
  const paragraphs = sent.locator('p');
  await expect(paragraphs).toHaveCount(3);
  const gap = await sent.evaluate((el) => {
    const [first, , last] = [...el.querySelectorAll('p')].map((p) => p.getBoundingClientRect());
    return last!.top - first!.bottom;
  });
  const line = await paragraphs.first().evaluate((p) => parseFloat(getComputedStyle(p).lineHeight));
  expect(gap).toBeGreaterThan(line * 2.5);
  // "this" and the line under it stay on two lines.
  const last = await paragraphs.last().evaluate((p) => p.getBoundingClientRect().height);
  expect(last).toBeGreaterThan(line * 1.5);
  // Once it has landed (it flies in from the box).
  await page.waitForTimeout(800);
  const bubble = (await sent.boundingBox())!;
  await page.screenshot({ path: path.join(SHOTS, '01-typed-lines.png'), clip: { x: bubble.x - 300, y: bubble.y - 16, width: bubble.width + 316, height: bubble.height + 32 } });
});
