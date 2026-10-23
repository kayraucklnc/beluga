import { expect, test, type Locator, type Page } from './fixtures.js';

/**
 * Pinch to zoom on a trackpad, for PDFs and pictures: the Mac's web view sends gesture events
 * (Safari's), Chromium sends Ctrl+wheel; both zoom what's under the fingers, never the window.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });

/** Two fingers apart, the way WebKit reports it. */
async function gesture(target: Locator, scale: number): Promise<void> {
  await target.evaluate((el, s) => {
    const r = el.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + 80 };
    const fire = (type: string, scale: number) => el.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, ...at }));
    fire('gesturestart', 1);
    fire('gesturechange', s);
    fire('gestureend', s);
  }, scale);
}

async function openHeroFile(page: Page, folder: string, file: string): Promise<Locator> {
  await page.goto('/');
  await expect(sidebar(page).getByRole('button', { name: 'landing' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await panel(page).getByRole('tablist', { name: 'Panel' }).getByRole('tab', { name: 'Files', exact: true }).click();
  const dir = panel(page).getByRole('treeitem', { name: folder });
  if ((await dir.getAttribute('aria-expanded')) !== 'true') await dir.click();
  await panel(page).getByRole('treeitem', { name: file }).click();
  await panel(page).getByRole('region', { name: file }).getByRole('button', { name: 'Open in full' }).click();
  return page.getByRole('main').getByRole('region', { name: file });
}

test('a PDF zooms with a pinch, both ways a trackpad reports it', async ({ page }) => {
  const full = await openHeroFile(page, 'docs', 'brand-brief.pdf');
  const pageOne = full.getByRole('img', { name: 'Page 1' });
  await expect(pageOne).toBeVisible();
  const zoom = full.getByRole('toolbar', { name: 'Zoom' });
  await expect(zoom).toContainText('Fit');
  const before = (await pageOne.boundingBox())!.width;
  // Chromium: Ctrl+wheel, fingers apart (negative deltaY).
  await pageOne.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -40);
  await page.keyboard.up('Control');
  await expect(zoom).not.toContainText('Fit');
  await expect.poll(async () => (await pageOne.boundingBox())!.width).toBeGreaterThan(before * 1.2);
  // WebKit: a gesture, fingers together, zooms back out.
  const wide = (await pageOne.boundingBox())!.width;
  await gesture(full.getByRole('img', { name: 'Page 1' }), 0.5);
  await expect.poll(async () => (await pageOne.boundingBox())!.width).toBeLessThan(wide * 0.7);
  // The window itself didn't zoom.
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
});

test('a picture zooms with a pinch, and scrolls once it’s bigger than the window', async ({ page }) => {
  const full = await openHeroFile(page, 'public', 'hero-shot.png');
  const picture = full.locator('img');
  await expect(picture).toBeVisible();
  const before = (await picture.boundingBox())!.width;
  await gesture(picture, 3);
  await expect.poll(async () => (await picture.boundingBox())!.width).toBeGreaterThan(before * 2);
  await expect(full.getByRole('toolbar', { name: 'Zoom' })).not.toContainText('Fit');
});
