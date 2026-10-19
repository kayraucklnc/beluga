import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Images a message shows by their path on this Mac (`![shot](</Users/…/shot.png>)`, the way Claude
 * shows a screenshot it took): thumbnails like pasted images, a row of them, and the lightbox.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

// A 2×2 red PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==', 'base64');

test('a message’s local screenshots show as thumbnails that open full size', async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud e2e shots-'));
  writeFileSync(path.join(dir, 'first.png'), PNG);
  writeFileSync(path.join(dir, 'second.png'), PNG);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  await composer(page).fill(`Here they are:\n\n![First shot](<${dir}/first.png>)\n![](${dir.replace(/ /g, '%20')}/second.png)\n\nand a [web one](https://example.com) ![logo](https://example.com/logo.png)`);
  await composer(page).press('Enter');

  const first = page.getByRole('button', { name: 'Open First shot' }).last();
  await expect(first).toBeVisible();
  await expect(first.locator('img')).toHaveJSProperty('complete', true);
  await expect(page.getByRole('button', { name: 'Open second.png' }).last()).toBeVisible();
  // A web image is a chip that opens in the browser (the window loads only what klaud reads).
  await expect(page.getByRole('link', { name: 'logo' }).last()).toBeVisible();

  await first.click();
  const box = page.getByRole('dialog');
  await expect(box).toContainText('First shot');
  await expect(box).toContainText('1 of 2');
  await page.keyboard.press('ArrowRight');
  await expect(box).toContainText('second.png');
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
});
