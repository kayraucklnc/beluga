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

/** A desktop behind the pop-up: kay browsing the web in Chrome, under the macOS menu bar. */
const DESKTOP = `
  html[data-popup], html[data-popup] body { background: linear-gradient(160deg, #2b3a67 0%, #4a5d9a 40%, #c0729b 100%) !important; height: 100%; }
  html[data-popup] #root { position: fixed; top: 26px; right: 0; width: 392px; z-index: 10; }
  #desk { position: fixed; inset: 0; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; color: #1f2328; }
  #desk .menubar { height: 26px; display: flex; align-items: center; gap: 18px; padding: 0 14px; background: rgba(30,30,40,.35); backdrop-filter: blur(20px); color: #fff; font-weight: 500; }
  #desk .menubar b { font-weight: 700; } #desk .menubar .right { margin-left: auto; opacity: .9; }
  #desk .win { position: absolute; left: 24px; top: 44px; right: 24px; bottom: 22px; border-radius: 11px; overflow: hidden; background: #fff; box-shadow: 0 22px 70px rgba(0,0,0,.45), 0 0 0 .5px rgba(0,0,0,.3); }
  #desk .tabs { height: 38px; background: #dee1e6; display: flex; align-items: flex-end; padding-left: 78px; gap: 2px; position: relative; }
  #desk .dots { position: absolute; left: 14px; top: 13px; display: flex; gap: 8px; } #desk .dots i { width: 12px; height: 12px; border-radius: 50%; display: block; }
  #desk .tab { height: 30px; padding: 0 14px; display: flex; align-items: center; gap: 8px; border-radius: 8px 8px 0 0; font-size: 12px; color: #3c4043; max-width: 210px; white-space: nowrap; overflow: hidden; }
  #desk .tab.on { background: #fff; } #desk .fav { width: 14px; height: 14px; border-radius: 50%; background: #1f2328; flex: none; }
  #desk .bar { height: 38px; display: flex; align-items: center; gap: 12px; padding: 0 12px; border-bottom: 1px solid #e3e3e3; }
  #desk .url { flex: 1; height: 28px; border-radius: 14px; background: #f1f3f4; display: flex; align-items: center; padding: 0 14px; color: #3c4043; font-size: 13px; }
  #desk .page { display: flex; }
  #desk .main { flex: 1; padding: 18px 26px; }
  #desk .repo { font-size: 19px; color: #0969da; } #desk .repo b { font-weight: 600; } #desk .pill { font-size: 11px; border: 1px solid #d0d7de; border-radius: 10px; padding: 1px 7px; color: #59636e; margin-left: 8px; vertical-align: 3px; }
  #desk .nav { display: flex; gap: 22px; margin: 14px 0 16px; padding-bottom: 10px; border-bottom: 1px solid #d0d7de; color: #59636e; } #desk .nav .on { color: #1f2328; font-weight: 600; box-shadow: 0 12px 0 -10px #fd8c73; }
  #desk .files { border: 1px solid #d0d7de; border-radius: 6px; width: 520px; }
  #desk .files div { display: flex; gap: 10px; padding: 7px 12px; border-top: 1px solid #d8dee4; color: #59636e; font-size: 12.5px; } #desk .files div:first-child { border-top: 0; background: #f6f8fa; color: #1f2328; }
  #desk .files span:first-child { width: 150px; color: #1f2328; }
`;

/** The page kay has open: a GitHub repository in Chrome. */
const DESKTOP_HTML = `
  <div class="menubar"><span></span><b>Chrome</b><span>File</span><span>Edit</span><span>View</span><span>History</span><span>Bookmarks</span><span class="right">Mon 12:40</span></div>
  <div class="win">
    <div class="tabs"><div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
      <div class="tab on"><span class="fav"></span>kay/portfolio: my site</div><div class="tab">Pull requests · kay/portfolio</div><div class="tab">Vercel – Deployments</div></div>
    <div class="bar"><span>‹ ›</span><div class="url">github.com/kay/portfolio</div></div>
    <div class="page"><div class="main">
      <div class="repo">kay / <b>portfolio</b><span class="pill">Public</span></div>
      <div class="nav"><span class="on">Code</span><span>Issues 3</span><span>Pull requests 2</span><span>Actions</span><span>Settings</span></div>
      <div class="files">
        <div><span>kay</span><span>dark mode for the blog</span></div>
        <div><span>app/</span><span>pricing page</span></div>
        <div><span>components/</span><span>hero: shorter subtitle</span></div>
        <div><span>public/</span><span>og image</span></div>
        <div><span>README.md</span><span>setup notes</span></div>
        <div><span>package.json</span><span>next 15</span></div>
      </div>
    </div></div>
  </div>`;

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
    viewport: { width: 1000, height: 600 },
    async run(page, context) {
      const main = await context.newPage();
      await main.goto(url);
      await side(main).waitFor();
      await networkOn(main);
      await page.addStyleTag({ content: DESKTOP });
      await page.evaluate((html) => {
        const desk = document.createElement('div');
        desk.id = 'desk';
        desk.innerHTML = html;
        document.body.prepend(desk);
      }, DESKTOP_HTML);
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
