// Screenshots of the Mac app's web view (run against `vite` + a demo daemon).
//   node scripts/shots.mjs [scene…]   → .context/shots/<scene>.png
import { chromium } from 'playwright';
import path from 'node:path';

const out = path.resolve(import.meta.dirname, '../../../.context/shots');
const url = process.env.KLAUD_URL ?? 'http://localhost:1420';
const theme = process.env.THEME ?? 'light';
const scenes = process.argv.slice(2);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForSelector('nav[aria-label="Sidebar"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const STEPS = {
  room: async () => {},
  workspace: async () => {
    await page.getByRole('button', { name: /bob-api|landing|api/ }).first().click();
    await page.waitForTimeout(300);
    const ws = page.locator('nav [role="button"]').filter({ hasText: /auth|hero|fix/i }).first();
    if (await ws.count()) await ws.click();
    await page.waitForTimeout(800);
  },
  overview: async () => {
    await page.getByRole('button', { name: 'Overview' }).first().click();
    await page.waitForTimeout(600);
  },
  palette: async () => {
    await page.keyboard.press('Meta+K');
    await page.waitForTimeout(500);
  },
  settings: async () => {
    await page.keyboard.press('Meta+,');
    await page.waitForTimeout(500);
  },
};

for (const scene of scenes.length ? scenes : ['room']) {
  const [name, ...rest] = scene.split(':');
  await (STEPS[name] ?? (async () => {}))(rest);
  const file = path.join(out, `${scene.replace(/[^\w-]/g, '_')}-${theme}.png`);
  await page.screenshot({ path: file });
  console.log(file);
}
if (errors.length) console.log('ERRORS:\n' + [...new Set(errors)].slice(0, 20).join('\n'));
await browser.close();
