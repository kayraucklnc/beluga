// Beluga Link's icon (BLG-389): Beluga's own beluga (assets/beluga.svg), in ink on a soft pastel
// instead of white on near-black, with a chain-link badge, so the add-on reads as Beluga's helper and
// never as a second Beluga. Writes the adaptive icon's foreground and the legacy square and round
// icons for every density into modules/phone-control/addon/src/main/res.
//
//   node scripts/make-link-icon.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const here = path.resolve(import.meta.dirname, '..');
const root = path.resolve(here, '../..');
const { Resvg } = createRequire(path.join(root, 'package.json'))('@resvg/resvg-js');
const res = path.join(here, 'modules/phone-control/addon/src/main/res');

const beluga = readFileSync(path.join(root, 'assets/beluga.svg'), 'utf8').match(/ d="([^"]+)"/)[1];
export const BACKGROUND = '#DCE6F2';
const INK = '#1C2430';

// The badge: lucide's "link" (24 grid, stroke 2) in a round white chip, low on the right.
const badge = (cx, cy, r) => `
  <circle cx="${cx}" cy="${cy}" r="${r + 10}" fill="${BACKGROUND}"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="#FFFFFF"/>
  <g transform="translate(${cx - r * 0.6} ${cy - r * 0.6}) scale(${(r * 1.2) / 24})" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </g>`;

/** The mark on a 1024 canvas; `scale` keeps it inside the adaptive icon's safe circle. */
const mark = (scale) => `
  <path transform="translate(512 512) scale(${scale}) translate(-512 -512)" fill="${INK}" fill-rule="evenodd" d="${beluga}"/>
  ${badge(512 + 300 * scale, 512 + 250 * scale, 150 * scale)}`;

const svg = (body, background) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${background ?? ''}${body}</svg>`;
const png = (s, size) => new Resvg(s, { fitTo: { mode: 'width', value: size } }).render().asPng();

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, d] of Object.entries(DENSITIES)) {
  const dir = path.join(res, `mipmap-${name}`);
  mkdirSync(dir, { recursive: true });
  // Adaptive foreground: 108 dp, the mark within the middle 66 dp.
  writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), png(svg(mark(0.5)), 108 * d));
  // Legacy icons (48 dp): a rounded square and a circle.
  writeFileSync(path.join(dir, 'ic_launcher.png'), png(svg(mark(0.66), `<rect width="1024" height="1024" rx="180" fill="${BACKGROUND}"/>`), 48 * d));
  writeFileSync(path.join(dir, 'ic_launcher_round.png'), png(svg(mark(0.6), `<circle cx="512" cy="512" r="512" fill="${BACKGROUND}"/>`), 48 * d));
}
// A preview for people to look at (not shipped).
writeFileSync(path.join(root, '.beluga/scratch/beluga-link-icon.png'), png(svg(mark(0.66), `<rect width="1024" height="1024" rx="180" fill="${BACKGROUND}"/>`), 512));
console.log('Beluga Link icon written to', res);
