// Screenshots of the Mac app's web view (run against `vite` + a demo daemon).
//   THEME=dark node scripts/shots.mjs [scene…]   → .context/shots/<scene>-<theme>.png
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
const wait = (ms) => page.waitForTimeout(ms);
const side = (name) => page.locator('nav [role="button"]').filter({ hasText: name }).first();

const openWs = async (name = 'add-auth') => {
  if (!(await side(name).isVisible().catch(() => false))) await side('bob-api').click();
  await wait(300);
  await side(name).click();
  await wait(700);
};
const tab = async (name) => {
  await page.getByRole('tab', { name }).click();
  await wait(1200);
};

const STEPS = {
  room: async () => {},
  workspace: async () => openWs(),
  chatrun: async () => {
    await openWs();
    await page.locator('textarea:not(.xterm-helper-textarea)').fill('Add rate limiting to the login endpoint and write tests');
    await page.keyboard.press('Enter');
    await wait(5000);
  },
  diff: async () => {
    await openWs();
    await tab('Diff');
  },
  files: async () => {
    await openWs();
    await tab('Files');
    const readme = page.locator('[role="option"]').filter({ hasText: /\.md$/ }).first();
    if (await readme.count()) await readme.click();
    await wait(800);
  },
  terminal: async () => {
    await openWs();
    await tab('Terminal');
    await wait(1500);
    await page.keyboard.type('ls -la && git log --oneline -3\n');
    await wait(1500);
  },
  overview: async () => side('Overview').click(),
  usage: async () => side('Usage').click(),
  search: async () => {
    await side('Search').click();
    await wait(200);
    await page.keyboard.type('auth');
  },
  shared: async () => side('Shared files').click(),
  palette: async () => page.keyboard.press('Meta+K'),
  settings: async () => page.keyboard.press('Meta+,'),
  person: async () => side('bob').click(),
  dock: async () => {
    await openWs();
    await page.keyboard.press('Meta+J');
    await wait(2500);
    await page.locator('textarea:not(.xterm-helper-textarea)').fill('Run the tests and fix whatever fails');
    await page.keyboard.press('Enter');
    await wait(3500);
  },
  picker: async () => {
    await openWs();
    await page.getByRole('button', { name: 'Model and effort' }).click();
    await wait(500);
  },
};

for (const scene of scenes.length ? scenes : ['room']) {
  await page.goto(url);
  await page.waitForSelector('nav[aria-label="Sidebar"]', { timeout: 20000 });
  await wait(1200);
  await (STEPS[scene] ?? (async () => {}))();
  await wait(700);
  const file = path.join(out, `${scene}-${theme}.png`);
  await page.screenshot({ path: file });
  console.log(file);
}
if (errors.length) console.log('ERRORS:\n' + [...new Set(errors)].slice(0, 20).join('\n'));
await browser.close();
