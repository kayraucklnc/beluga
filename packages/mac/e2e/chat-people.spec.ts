import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test, type Page } from './fixtures.js';

/**
 * Who's who in a chat with friends (BLG-210), against the demo's people scene
 * (BELUGA_DEMO_SCENE=people): a channel with bob, mia and ata, ata gone offline, mia's Claude asking
 * for a secret. The header has a pill per person, the band says what waits on whom, the box says who
 * gets it later. SHOTS=<folder>: screenshots there, light and dark.
 */

test.describe.configure({ mode: 'serial' });
test.skip(process.env.BELUGA_DEMO_SCENE !== 'people', 'needs BELUGA_DEMO_SCENE=people');

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SHOTS) return;
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

async function turnOn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const card = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  if (await card.isVisible()) await card.getByRole('button', { name: 'Turn On' }).click();
}

test('a channel: each person and their Claude in the header, what waits, who gets it later', async ({ page }) => {
  test.setTimeout(90_000);
  await turnOn(page);
  const channel = sidebar(page).getByRole('button', { name: /^Channel api-redesign\b/ });
  await expect(channel).toBeVisible({ timeout: 40_000 });
  await channel.click();
  const log = page.getByRole('log', { name: 'Channel api-redesign' });
  await expect(log).toContainText('Sure, just this once.', { timeout: 20_000 });
  const pills = page.getByRole('list', { name: 'People here' });
  await expect(pills.getByRole('listitem')).toHaveCount(4);
  await expect(pills).toContainText('You');
  await expect(pills).toContainText(/ata\s*offline/, { timeout: 20_000 });
  const band = page.getByRole('region', { name: 'Waiting' });
  await expect(band).toContainText('Waiting on you: mia’s agent wants your private SSH key id_ed25519', { timeout: 30_000 });
  await expect(page.getByRole('note')).toHaveText('ata is offline: this waits for them');
  // Your words on the right, a friend's on the left in their colour.
  await expect(log.locator('[data-mine="true"]').filter({ hasText: 'Sure, just this once.' })).toBeVisible();
  // The secret's card: only Allow Once and Decline.
  const card = log.locator('section[data-task]').filter({ hasText: 'A secret · only you can allow it, each time' });
  await expect(card).toBeVisible();
  await band.getByRole('button').first().click();
  await expect(card).toHaveAttribute('data-flash', 'true');
  await expect(card).not.toHaveAttribute('data-flash', 'true', { timeout: 4000 });
  await shot(page, '01-channel-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, '02-channel-dark');
  await page.emulateMedia({ colorScheme: 'light' });
});

test('a DM: a request to someone offline waits on them', async ({ page, demo }) => {
  test.setTimeout(90_000);
  await turnOn(page);
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e', timeoutMs: 10_000 });
  try {
    await client.api.gateway.ask('ata', 'Run the tests in ata-api and tell me what fails');
  } finally {
    client.close();
  }
  await sidebar(page).getByRole('button', { name: /^ata, / }).click();
  const band = page.getByRole('region', { name: 'Waiting' });
  await expect(band).toContainText('Waiting on ata: Run the tests in ata-api', { timeout: 20_000 });
  await expect(page.getByRole('note')).toHaveText('ata is offline: this waits for them');
  await sidebar(page).getByRole('button', { name: /^bob, / }).click();
  await expect(page.getByRole('region', { name: 'Waiting' })).toHaveCount(0);
  await sidebar(page).getByRole('button', { name: /^ata, / }).click();
  await shot(page, '03-dm-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, '04-dm-dark');
});
