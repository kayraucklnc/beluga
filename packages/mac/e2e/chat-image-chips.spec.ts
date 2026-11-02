import path from 'node:path';
import { expect, test, type Locator, type Page } from './fixtures.js';

/**
 * A pasted image is a chip in the words (BLG-72): in the box it hugs its icon and name, a long
 * name loses its start ("…8.14.32@2x"), and the sent message shows the same chip where it was,
 * the first word included.
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.beluga/scratch');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').last();

// A 2×2 red PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==';

const pasteImage = (box: Locator, name: string) =>
  box.evaluate(
    (el, [b64, file]) => {
      const bytes = Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], file!, { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    [PNG, name],
  );

/** How much room a chip has around its icon and name, left and right. */
const slack = (chip: Locator) =>
  chip.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const icon = el.querySelector('svg')!.getBoundingClientRect();
    const name = el.querySelector('bdi')!.getBoundingClientRect();
    return { left: icon.left - box.left, right: box.right - name.right, width: box.width };
  });

/** What makes a chip look like one. */
const look = (el: Element) => {
  const cs = getComputedStyle(el);
  return [cs.backgroundColor, cs.borderRadius, cs.fontWeight, cs.boxShadow, cs.color];
};

test('an image at the very start: a hugging chip in the box, and still there in the sent message', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  const box = composer(page);
  await box.fill('');
  await box.focus();
  await pasteImage(box, 'Screenshot 2026-10-24 at 18.14.32@2x.png');
  await expect(box).toHaveValue(/^\[\d+ …8\.14\.32@2x\] $/);
  // (The box puts its caret after the image once the image is in: type after that.)
  await page.waitForTimeout(300);
  await box.press('End');
  await box.pressSequentially('we have this visual problem connecting to phone. ');
  await expect(box).toHaveValue(/^\[\d+ …8\.14\.32@2x\] we have this visual problem connecting to phone\. $/);
  await pasteImage(box, 'image.png');
  await expect(box).toHaveValue(/phone\. \[\d+ …[\w-]+\] $/);
  await page.waitForTimeout(300);
  await box.press('End');
  await box.pressSequentially('I just realized');
  await expect(box).toHaveValue(/\] I just realized$/);

  // In the box: the chips hug their icon and name (a few pixels of padding, not a wide band).
  const chips = page.getByTestId('mention-highlighter').locator('[data-image-chip]');
  await expect(chips).toHaveCount(2);
  await expect(chips.first()).toHaveText('…8.14.32@2x');
  for (const chip of await chips.all()) {
    const room = await slack(chip);
    expect(room.left).toBeLessThan(12);
    expect(room.right).toBeLessThan(12);
    expect(room.left).toBeGreaterThan(1);
    expect(room.right).toBeGreaterThan(1);
  }
  const at = (await box.boundingBox())!;
  await page.screenshot({ path: path.join(SHOTS, '10-box-chips.png'), clip: { x: at.x - 16, y: at.y - 12, width: at.width + 32, height: at.height + 24 } });

  const boxLook = await chips.first().evaluate(look);

  await box.press('Enter');
  // The sent message: both images are chips where they were written, the first one first.
  const sent = page.locator('[data-mine="true"]').filter({ hasText: 'I just realized' }).last();
  await expect(sent).toBeVisible();
  const inWords = sent.locator('[data-image-chip]');
  await expect(inWords).toHaveCount(2);
  await expect(inWords.first()).toHaveText(/^image \d+$/);
  const first = await sent.locator('p').first().evaluate((p) => p.firstElementChild?.hasAttribute('data-image-chip'));
  expect(first).toBe(true);
  // And the pictures, below.
  await expect(sent.getByRole('button', { name: /^Open image \d+/ })).toHaveCount(2);
  // The same chip as in the box.
  expect(await inWords.first().evaluate(look)).toEqual(boxLook);
  await sent.screenshot({ path: path.join(SHOTS, '11-sent-chips.png') });
  await inWords.first().click();
  await expect(page.getByRole('dialog')).toContainText(/image \d+/);
  await page.keyboard.press('Escape');
});

test('a name too long for its chip loses its start, and reads left to right', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  const box = composer(page);
  await box.fill('');
  await box.focus();
  await pasteImage(box, 'Screenshot 2026-10-24 at 18.14.32@2x.png');
  const chip = page.getByTestId('mention-highlighter').locator('[data-image-chip]').first();
  await expect(chip).toHaveText('…8.14.32@2x');
  await page.emulateMedia({ colorScheme: 'dark' });
  const at = (await box.boundingBox())!;
  await page.screenshot({ path: path.join(SHOTS, '12-box-chip-dark.png'), clip: { x: at.x - 16, y: at.y - 12, width: Math.min(at.width + 32, 420), height: at.height + 24 } });
  await page.emulateMedia({ colorScheme: 'light' });
  // Squeezed: the end of the name stays in view, its start is cut.
  const cut = await chip.evaluate((el) => {
    (el as HTMLElement).style.right = '40%';
    const name = el.querySelector('bdi')!;
    const clip = name.parentElement!.getBoundingClientRect();
    const text = name.getBoundingClientRect();
    return { endShown: Math.abs(text.right - clip.right) < 2, startCut: text.left < clip.left - 2, dir: getComputedStyle(name).direction, text: name.textContent };
  });
  expect(cut).toEqual({ endShown: true, startCut: true, dir: 'ltr', text: '…8.14.32@2x' });
  await box.fill('');
});
