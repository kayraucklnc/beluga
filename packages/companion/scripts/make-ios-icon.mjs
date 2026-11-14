// The iPhone's icon: Beluga's own mark (assets/logo.svg) drawn full bleed, because iOS rounds the
// corners itself and refuses a transparent icon. assets/icon.png keeps the Mac's squircle with its
// transparent margin (Android and the web use it); app.json points ios.icon at this one.
// App Store Connect also refuses an alpha channel, and resvg always writes one: drop it after.
//
//   node scripts/make-ios-icon.mjs && magick assets/icon-ios.png -alpha off assets/icon-ios.png
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const here = path.resolve(import.meta.dirname, '..');
const root = path.resolve(here, '../..');
const { Resvg } = createRequire(path.join(root, 'package.json'))('@resvg/resvg-js');

const beluga = readFileSync(path.join(root, 'assets/beluga.svg'), 'utf8').match(/ d="([^"]+)"/)[1];
// The logo's gradient and its mark's scale: the tail reaches the canvas's corner, so any larger
// and iOS's rounded corners would clip it.
const TOP = '#26282D';
const BOTTOM = '#08090A';
const SCALE = 0.74;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TOP}"/><stop offset="1" stop-color="${BOTTOM}"/></linearGradient></defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <path transform="translate(512 512) scale(${SCALE.toFixed(4)}) translate(-512 -512)" fill="#FFFFFF" fill-rule="evenodd" d="${beluga}"/>
</svg>`;

const out = path.join(here, 'assets/icon-ios.png');
writeFileSync(out, new Resvg(svg, { background: BOTTOM, fitTo: { mode: 'width', value: 1024 } }).render().asPng());
console.log('iOS icon written to', out);
