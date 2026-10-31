// How much CPU the Mac app's web view uses with the demo's plan running (KLD-40).
//   node scripts/cpu-bench.mjs [label] [--headed] [--secs=20] [--scenes=plan,board,chat] [--pace=10] [--port=1491]
// Starts the demo daemon (slowed, so the plan's task keeps working) and a dev server of its own,
// opens the app in Playwright's WebKit (the engine Beluga's window runs; --headed draws it on
// screen, which is what counts), sets the plan's in-progress task to work, and for each scene
// measures CPU while the window is in front and while it's in the background (blurred and hidden,
// as when you switch apps or cover Beluga). Results print and land in .beluga/scratch/cpu-<label>.json.
// To find what costs what: --peek (screenshots, running animations, DOM changes and socket
// traffic while away), --kill=<selector> / --css=<rules> (inject style), --still (Reduce Motion),
// --sample=<front|background> (a macOS `sample` of the web content process).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webkit } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const label = args.find((a) => !a.startsWith('--')) ?? 'run';
const headed = args.includes('--headed');
const secs = Number(flag('secs', 20));
const scenes = flag('scenes', 'plan,board,chat').split(',');
const port = Number(flag('port', 1491));
const repo = path.resolve(import.meta.dirname, '../../..');
const out = path.join(repo, '.beluga/scratch');

const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-bench-'));
const children = [];
const start = (cmd, argv, opts) => {
  const child = spawn(cmd, argv, { stdio: 'ignore', detached: true, ...opts });
  children.push(child);
  return child;
};
const stop = () => {
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {}
  }
};
process.on('exit', stop);
process.on('SIGINT', () => process.exit(1));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, BELUGA_HOME: home, KLAUD_HOME: home };
start('npx', ['tsx', 'src/cli.ts', 'daemon', '--keep-alive', 'demo'], { cwd: repo, env: { ...env, BELUGA_DEMO_PACE: flag('pace', '10'), BELUGA_ALLOW_ORIGINS: `http://localhost:${port}` } });
for (let i = 0; i < 120 && !existsSync(path.join(home, 'daemon.json')); i++) await wait(250);
start('npx', ['vite', '--port', String(port), '--strictPort'], { cwd: path.resolve(import.meta.dirname, '..'), env });
for (let i = 0; i < 120; i++) {
  if (await fetch(`http://localhost:${port}`).then((r) => r.ok, () => false)) break;
  await wait(250);
}
await wait(5000); // the pretend friends arrive

/** Cumulative CPU seconds of every process whose command line matches. */
function cpuTimes(match) {
  const rows = execFileSync('ps', ['-axo', 'pid=,time=,command='], { encoding: 'utf8' }).split('\n');
  const times = new Map();
  for (const row of rows) {
    const m = row.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m || !match(m[3])) continue;
    const parts = m[2].split(/[:.]/).map(Number); // [h:]mm:ss.cc
    const [h, mm, ss, cc] = parts.length === 4 ? parts : [0, ...parts];
    times.set(Number(m[1]), { cmd: m[3], t: h * 3600 + mm * 60 + ss + cc / 100 });
  }
  return times;
}
const kind = (cmd) => (/WebContent|WebProcess/.test(cmd) ? 'webcontent' : /GPU/.test(cmd) ? 'gpu' : /Networking|NetworkProcess/.test(cmd) ? 'network' : /WindowServer/.test(cmd) ? 'windowserver' : 'ui');
const watched = (cmd) => (cmd.includes('ms-playwright/webkit') && !cmd.includes('Networking') && !cmd.includes('NetworkProcess')) || cmd.includes('WindowServer');

async function measure(name) {
  const before = cpuTimes(watched);
  // --sample=<scene part>: a macOS `sample` of the web content process while that part is measured.
  const want = flag('sample');
  if (want && name.includes(want))
    for (const [pid, p] of before) if (kind(p.cmd) === 'webcontent' && p.cmd.includes('ms-playwright')) spawn('sample', [String(pid), String(Math.max(1, secs - 2)), '-file', path.join(out, `cpu-${label}-${name.replace(/\W+/g, '-')}-${pid}.sample.txt`)], { stdio: 'ignore' });
  const t0 = performance.now();
  await wait(secs * 1000);
  const after = cpuTimes(watched);
  const elapsed = (performance.now() - t0) / 1000;
  const sums = {};
  for (const [pid, a] of after) {
    const b = before.get(pid);
    if (!b) continue;
    const k = kind(a.cmd);
    sums[k] = (sums[k] ?? 0) + ((a.t - b.t) / elapsed) * 100;
  }
  const row = { scene: name, ...Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Math.round(v * 10) / 10])) };
  console.log(JSON.stringify(row));
  return row;
}

const browser = await webkit.launch({ headless: !headed });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: 'beluga.onboarding.v1', value: JSON.stringify({ version: 'bench', at: 0, how: 'finished' }) }] }] } });
const page = await context.newPage();
// Background, as WebKit tells the page when you switch apps or cover the window.
await page.addInitScript(() => {
  const w = window;
  w.__bench = { focused: true, hidden: false };
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => w.__bench.hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (w.__bench.hidden ? 'hidden' : 'visible') });
  const hasFocus = document.hasFocus.bind(document);
  document.hasFocus = () => w.__bench.focused && hasFocus();
});
// --kill=<css selector>: those elements don't animate; --css=<rules>: any style (to find what costs what).
const kill = flag('kill');
const css = (kill ? `${kill} { animation: none !important; }` : '') + (args.find((a) => a.startsWith('--css='))?.slice(6) ?? '');
if (css) await page.addInitScript((text) => document.addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: text }))), css);
// --still: Beluga's Reduce Motion on (a floor: nothing moves, only live states render).
if (args.includes('--still')) await page.addInitScript(() => localStorage.setItem('beluga.prefs.v1', JSON.stringify({ reduceMotion: true })));
if (args.includes('--peek'))
  await page.addInitScript(() => {
    const w = window;
    w.__ws = { n: 0, bytes: 0, types: {} };
    const Orig = WebSocket;
    w.WebSocket = class extends Orig {
      constructor(...a) {
        super(...a);
        this.addEventListener('message', (e) => {
          w.__ws.n++;
          const text = typeof e.data === 'string' ? e.data : '';
          w.__ws.bytes += text.length;
          const t = /"(?:type|kind|method)"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? '?';
          w.__ws.types[t] = (w.__ws.types[t] ?? 0) + 1;
        });
      }
    };
  });
const background = async (on) => {
  await page.evaluate((on) => {
    window.__bench.focused = !on;
    window.__bench.hidden = on;
    window.dispatchEvent(new Event(on ? 'blur' : 'focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  }, on);
  await wait(1500);
};

const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
const main = page.locator('main');
const openPlan = async () => {
  await sidebar.getByRole('button', { name: /^Plans/ }).first().click();
  await main.getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await main.locator('[data-ready="true"]').waitFor({ timeout: 20_000 });
};
/** Sets the plan's in-progress task to work: its Claude runs a long turn in its worktree's chat. */
const kick = async () => {
  await openPlan();
  await page.getByTestId('rf__node-t:retries').click();
  await page.getByRole('complementary', { name: 'Details' }).getByRole('button', { name: /Open Worktree/ }).click();
  const box = page.getByPlaceholder(/checkout-events/);
  await box.waitFor();
  await box.fill('Add the processed_events migration, then the replay test, then run the whole suite and fix what fails');
  await box.press('Enter');
  await wait(1500);
};
const OPEN = {
  plan: async () => {
    await kick();
    await openPlan();
    await page.keyboard.press('Escape');
  },
  board: async () => {
    await kick();
    await sidebar.getByRole('button', { name: /^Tasks/ }).first().click();
    await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'Board' }).click();
  },
  chat: async () => {
    await kick();
  },
};

await page.goto(`http://localhost:${port}/`);
await sidebar.waitFor();
await wait(3000);
const rows = [];
const peek = async (name) => {
  if (!args.includes('--peek')) return;
  await page.screenshot({ path: path.join(out, `cpu-${label}-${name}.png`) });
  console.log(name, await page.evaluate(() => ({ motion: document.documentElement.dataset.motion, rm: matchMedia('(prefers-reduced-motion: reduce)').matches, glow: [...document.querySelectorAll('[class*=glow]')].map((g) => getComputedStyle(g).animationName + ' ' + getComputedStyle(g).animationPlayState), animations: document.getAnimations().length, names: document.getAnimations().map((a) => `${a.animationName ?? a.constructor.name} ${a.playState} on ${a.effect?.target?.tagName}.${String(a.effect?.target?.className?.baseVal ?? a.effect?.target?.className).slice(0, 50)} ${a.effect?.pseudoElement ?? ''}`) })));
};
process.on('unhandledRejection', async (e) => {
  console.error(e);
  await page.screenshot({ path: path.join(out, `cpu-${label}-failed.png`) }).catch(() => {});
  process.exit(1);
});
for (const scene of scenes) {
  try {
    await OPEN[scene]();
  } catch (e) {
    await page.screenshot({ path: path.join(out, `cpu-${label}-failed.png`) });
    throw e;
  }
  await wait(2000);
  await peek(`${scene}-front`);
  rows.push(await measure(`${scene} · front`));
  await peek(`${scene}-front-end`);
  await OPEN[scene]();
  await wait(2000);
  await background(true);
  if (args.includes('--peek')) await page.evaluate(() => {
    const w = window;
    w.__muts = {};
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        const k = `${r.type}:${el?.tagName}.${String(el?.className?.baseVal ?? el?.className ?? '').slice(0, 40)}`;
        w.__muts[k] = (w.__muts[k] ?? 0) + 1;
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  rows.push(await measure(`${scene} · background`));
  if (args.includes('--peek')) console.log('socket', await page.evaluate(() => ({ ...window.__ws, types: Object.entries(window.__ws.types).sort((a, b) => b[1] - a[1]).slice(0, 12) })));
  if (args.includes('--peek')) console.log('background mutations', await page.evaluate(() => Object.entries(window.__muts).sort((a, b) => b[1] - a[1]).slice(0, 15)));
  await background(false);
}
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, `cpu-${label}.json`), JSON.stringify({ label, headed, secs, at: new Date().toISOString(), rows }, null, 2));
await browser.close();
process.exit(0);
