// The phone app's Home, as the welcome's phone step shows it (src/onboarding/PhoneStep.tsx):
// the companion's own demo (packages/companion, "Try the demo first": a convincing pretend Mac
// with a question waiting, a friend's request, finished and running work), in light and dark.
//
//   node scripts/phone-shots.mjs          → src/assets/phone-home-{light,dark}.webp
//
// Starts the companion's web build itself (or set PHONE_URL to one already running). Needs
// `npm ci` in packages/companion, and cwebp (brew install webp) to make the small WebPs.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const here = import.meta.dirname;
const companion = path.resolve(here, '../../companion');
const out = path.resolve(here, '../src/assets');
const port = Number(process.env.PHONE_PORT ?? 8099);
let url = process.env.PHONE_URL;
let expo;

const waitFor = async (u, ms = 180_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(u)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${u} didn't answer`);
};

if (!url) {
  url = `http://localhost:${port}`;
  expo = spawn('npx', ['expo', 'start', '--web', '--port', String(port)], { cwd: companion, env: { ...process.env, CI: '1', BROWSER: 'none' }, stdio: 'ignore', detached: true });
  await waitFor(url);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'phone-shots-'));
const browser = await chromium.launch();
try {
  for (const scheme of ['light', 'dark']) {
    // A phone's size, at 2x (the step draws it about 200 px wide, so this stays sharp on Retina).
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme, isMobile: true, hasTouch: true });
    await page.goto(url);
    await page.getByText('Try the demo first').click({ timeout: 120_000 });
    // The demo pairs first (the four pictures), then Home fills in as the demo Mac answers.
    await page.getByText('Same four on both?').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => undefined);
    // Then the "paired" check, then Home.
    await page.waitForTimeout(Number(process.env.PHONE_WAIT ?? 12_000));
    const png = path.join(tmp, `${scheme}.png`);
    await page.screenshot({ path: png });
    await page.close();
    const webp = path.join(out, `phone-home-${scheme}.webp`);
    execFileSync('cwebp', ['-quiet', '-q', '78', '-m', '6', png, '-o', webp]);
    console.log(`${path.relative(process.cwd(), webp)}  ${Math.round(statSync(webp).size / 1024)} KB`);
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
  if (expo) process.kill(-expo.pid);
}
