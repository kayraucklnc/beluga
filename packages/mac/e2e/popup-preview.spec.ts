import { expect, test } from './fixtures.js';

/**
 * BLG-9: the request pop-up for someone who uses Beluga alone. ⌘K › Preview Request Pop-up puts
 * a pretend friend's request and a pretend decision on it (popup.html, which hears the window over
 * a BroadcastChannel in a browser); their buttons do nothing but say it was a preview.
 */

test('Preview Request Pop-up shows a friend’s request and a decision of yours, and answers nothing', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  const popup = await page.context().newPage();
  await popup.goto('/popup.html');
  await page.bringToFront();
  await page.keyboard.press('Meta+K');
  await page.keyboard.type('Preview Request Pop-up');
  await page.keyboard.press('Enter');
  const cards = popup.getByTestId('request-popup-card');
  await expect(cards).toHaveCount(2, { timeout: 10_000 });
  await expect(cards.first()).toContainText('Mia’s Claude wants to');
  const decision = popup.locator('[data-need="decision"]');
  await expect(decision).toContainText('Your call');
  await expect(decision).toContainText('Which payment providers should checkout offer at launch?');
  await expect(decision).toContainText('Stripe · Apple Pay · PayPal');
  await popup.screenshot({ path: test.info().outputPath('popup-preview.png') });
  // Later hides just that card.
  await decision.getByRole('button', { name: 'Later' }).click();
  await expect(cards).toHaveCount(1);
  // The pretend request's buttons say so, and the preview goes.
  await cards.first().getByRole('button', { name: 'Decline' }).click();
  await expect(page.getByText('That was a preview').first()).toBeVisible();
  await expect(cards).toHaveCount(0, { timeout: 10_000 });
});
