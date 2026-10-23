// The orca, everywhere the app shows its icon, all from one drawing: assets/orca.svg (traced
// from assets/orca-source.jpeg). Writes the app icon (assets/logo.svg, and every size in
// src-tauri/icons via `tauri icon`), the menu-bar template (src-tauri/icons/tray.png), the path
// the onboarding mark draws (src/components/orca-path.ts) and the DMG background (dmg/*.png).
//
//   node scripts/make-icons.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const here = path.resolve(import.meta.dirname, '..');
const root = path.resolve(here, '../..');
const { Resvg } = createRequire(path.join(root, 'package.json'))('@resvg/resvg-js');

const orca = readFileSync(path.join(root, 'assets/orca.svg'), 'utf8').match(/ d="([^"]+)"/)[1];

/** Apple's icon grid: an 824-point tile in a 1024 canvas, with continuous (superellipse) corners. */
function tile(x0, size, n = 5, steps = 360) {
  const c = x0 + size / 2;
  const r = size / 2;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    pts.push(`${(c + r * Math.sign(cos) * Math.abs(cos) ** (2 / n)).toFixed(2)},${(c + r * Math.sign(sin) * Math.abs(sin) ** (2 / n)).toFixed(2)}`);
  }
  return `M${pts.join(' L')} Z`;
}

const TILE = tile(100, 824);
// The orca fills ~75% of the tile, as in the source; macOS draws the shadow itself.
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="Orca">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#F1F2F4"/>
    </linearGradient>
  </defs>
  <path d="${TILE}" fill="url(#bg)"/>
  <path d="${TILE}" fill="none" stroke="#000000" stroke-opacity="0.08" stroke-width="2"/>
  <path transform="translate(512 512) scale(0.7) translate(-512 -512)" fill="#0B0B0C" fill-rule="evenodd" d="${orca}"/>
</svg>
`;
writeFileSync(path.join(root, 'assets/logo.svg'), icon);

// The README banners carry the icon inline, centered over the name.
for (const banner of ['banner-light.svg', 'banner-dark.svg']) {
  const file = path.join(root, 'assets', banner);
  const body = icon.replace(/^<svg[^>]*>\n|<\/svg>\n$/g, '').replaceAll('id="bg"', 'id="logo-bg"').replaceAll('url(#bg)', 'url(#logo-bg)');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/<g transform="[^"]*">[\s\S]*?\n  <\/g>/, `<g transform="translate(413.4 3.4) scale(0.13)">\n${body}  </g>`));
}

const png = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();

// The app icon: `tauri icon` makes every size from one 1024 PNG; keep the ones the bundle uses.
const work = mkdtempSync(path.join(os.tmpdir(), 'orca-icons-'));
try {
  writeFileSync(path.join(work, 'icon-1024.png'), png(icon, 1024));
  execFileSync('npx', ['tauri', 'icon', path.join(work, 'icon-1024.png'), '-o', path.join(work, 'out')], { cwd: here, stdio: 'inherit' });
  for (const f of ['32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.icns', 'icon.ico']) {
    copyFileSync(path.join(work, 'out', f), path.join(here, 'src-tauri/icons', f));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// The menu-bar icon: a template (black on clear; macOS tints it for light and dark bars).
// macOS draws it 18 points tall, so 36 pixels is exactly @2x; the width follows the orca.
const tray = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="36" viewBox="53 99 918 826">
  <path fill="#000" fill-rule="evenodd" d="${orca}"/>
</svg>`;
writeFileSync(path.join(here, 'src-tauri/icons/tray.png'), new Resvg(tray, { fitTo: { mode: 'height', value: 36 } }).render().asPng());

writeFileSync(
  path.join(here, 'src/components/orca-path.ts'),
  `// Made by scripts/make-icons.mjs from assets/orca.svg: don't edit by hand.\n\n/** The orca, one even-odd path (eye, belly and saddle cut out), centered in a 1024 box. */\nexport const ORCA = '${orca}';\n`,
);

// The install window's background, at both resolutions (it shows the app icon by the name).
const { chromium } = createRequire(path.join(here, 'package.json'))('playwright');
const browser = await chromium.launch();
try {
  for (const [scale, file] of [[1, 'background.png'], [2, 'background@2x.png']]) {
    const page = await browser.newPage({ viewport: { width: 660, height: 420 }, deviceScaleFactor: scale });
    await page.goto(`file://${path.join(here, 'dmg/background.html')}`);
    await page.screenshot({ path: path.join(here, 'dmg', file) });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('icons written');
