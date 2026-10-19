// The README's GIFs, recorded from the Mac app's web view against `vite` + a demo daemon.
//   KLAUD_URL=http://localhost:1420 node scripts/gifs.mjs [scene…]   → assets/mac/<scene>.gif
// Needs ffmpeg. Each scene is recorded as a video, then turned into a GIF with its own palette.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const repo = path.resolve(import.meta.dirname, '../../..');
const out = path.join(repo, 'assets/mac');
const tmp = path.join(repo, '.context/gifs');
const url = process.env.KLAUD_URL ?? 'http://localhost:1420';
const only = process.argv.slice(2);

const side = (page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page) => page.locator('textarea:not(.xterm-helper-textarea)');

async function networkOn(page) {
  const card = side(page).getByRole('group', { name: 'Talk with friends' });
  if (await card.isVisible().catch(() => false)) await card.getByRole('button', { name: 'Turn On' }).click();
  await side(page).getByRole('button', { name: /^bob, / }).waitFor({ timeout: 30_000 });
}

async function say(page, text) {
  await composer(page).click();
  await page.keyboard.type(text, { delay: 45 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
}

/** A desktop behind the pop-up: a wallpaper and someone else's app in front. */
const DESKTOP = `
  html[data-popup], html[data-popup] body { background: linear-gradient(135deg, #6c8cff 0%, #b06cff 45%, #ff8f6c 100%) !important; height: 100%; }
  html[data-popup] body::before { content: ''; position: fixed; left: 32px; top: 64px; width: 330px; height: 360px; border-radius: 12px;
    box-shadow: 0 24px 70px rgba(0,0,0,.28), 0 0 0 .5px rgba(0,0,0,.15);
    background:
      radial-gradient(circle at 18px 16px, #ff5f57 5px, transparent 6px),
      radial-gradient(circle at 36px 16px, #febc2e 5px, transparent 6px),
      radial-gradient(circle at 54px 16px, #28c840 5px, transparent 6px),
      linear-gradient(#e9e9ee, #e9e9ee) 0 0 / 100% 32px no-repeat,
      linear-gradient(#d9dbe6, #d9dbe6) 20px 56px / 180px 12px no-repeat,
      linear-gradient(#e6e7ee, #e6e7ee) 20px 80px / 270px 9px no-repeat,
      linear-gradient(#e6e7ee, #e6e7ee) 20px 98px / 230px 9px no-repeat,
      linear-gradient(135deg, #c9d4ff, #f3c6ff) 20px 128px / 290px 150px no-repeat,
      linear-gradient(#e6e7ee, #e6e7ee) 20px 296px / 250px 9px no-repeat,
      linear-gradient(#e6e7ee, #e6e7ee) 20px 314px / 200px 9px no-repeat,
      #fbfbfd; }
  html[data-popup] body::after { content: 'landing — Figma'; position: fixed; left: 32px; width: 330px; text-align: center; top: 72px; font: 600 12px -apple-system, sans-serif; color: rgba(0,0,0,.5); }
  html[data-popup] #root { position: fixed; top: 6px; right: 0; width: 392px; }
`;

const SCENES = {
  /** "@bob run the tests": your Claude asks bob's Claude on his Mac, and the answer comes back. */
  'ask-a-friend': {
    viewport: { width: 1280, height: 760 },
    async run(page) {
      await networkOn(page);
      await side(page).getByRole('button', { name: /^webhook-retries/ }).first().click();
      await page.waitForTimeout(1200);
      const answers = page.getByText(/^bob's Claude says/);
      const before = await answers.count();
      await say(page, '@bob run the tests in bob-api and tell me how many pass');
      await answers.nth(before).waitFor({ timeout: 60_000 });
      await page.mouse.move(560, 360);
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(3500);
    },
  },
  /** mia's Claude wants a screenshot: the pop-up on your desktop, See more, Allow. */
  'wants-to': {
    viewport: { width: 760, height: 480 },
    async run(page, context) {
      const main = await context.newPage();
      await main.goto(url);
      await side(main).waitFor();
      await networkOn(main);
      await page.addStyleTag({ content: DESKTOP });
      await page.bringToFront();
      await page.waitForTimeout(1500);
      await side(main).getByRole('button', { name: /^mia, / }).click();
      const box = main.getByRole('textbox', { name: 'Message mia' });
      await box.fill('can your Claude grab a screenshot from me?');
      await box.press('Enter');
      const card = page.getByTestId('request-popup-card').first();
      await card.waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2600);
      await card.getByRole('button', { name: 'See more' }).hover();
      await page.waitForTimeout(500);
      await card.getByRole('button', { name: 'See more' }).click();
      await page.waitForTimeout(3800);
      await card.getByRole('button', { name: 'Allow', exact: true }).hover();
      await page.waitForTimeout(900);
      await card.getByRole('button', { name: 'Allow', exact: true }).click();
      await page.waitForTimeout(1800);
      await main.close();
    },
    path: '/popup.html',
    // Skip the wait for mia's Claude to ask.
    trim: 2.2,
  },
  /** Say what you want: a worktree of its own, named for the task, and Claude at work in it. */
  'worktree-per-task': {
    viewport: { width: 1280, height: 760 },
    async run(page) {
      await side(page).getByRole('button', { name: /^add-auth/ }).first().click();
      await page.waitForTimeout(1200);
      await say(page, 'Add rate limiting to the login endpoint and write tests');
      await page.waitForTimeout(9000);
    },
  },
};

async function record(name, scene, browser) {
  rmSync(path.join(tmp, name), { recursive: true, force: true });
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: scene.viewport, colorScheme: 'light', recordVideo: { dir, size: scene.viewport } });
  const page = await context.newPage();
  await page.goto(`${url}${scene.path ?? '/'}`);
  if (!scene.path) await side(page).waitFor();
  await page.waitForTimeout(600);
  await scene.run(page, context);
  const video = await page.video()?.path();
  await context.close();
  const webm = path.join(dir, 'scene.webm');
  renameSync(video ?? path.join(dir, readdirSync(dir).find((f) => f.endsWith('.webm'))), webm);
  const gif = path.join(out, `${name}.gif`);
  const width = Math.min(scene.viewport.width, 1100);
  // Trim the blank first frames, then a palette made for this scene.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(scene.trim ?? 0.8), '-i', webm, '-vf', `fps=12,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', gif]);
  console.log(`${name}: ${gif}`);
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, scene] of Object.entries(SCENES)) if (!only.length || only.includes(name)) await record(name, scene, browser);
} finally {
  await browser.close();
}
