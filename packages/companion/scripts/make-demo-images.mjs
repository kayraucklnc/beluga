// Makes the demo Mac's pictures (lib/link/demo/images.generated.ts): SVG mock-ups rendered with
// resvg and encoded as JPEG, so they behave like the thumbnails a real Mac sends (sips, JPEG).
// Run from the repo root (it uses the engine's @resvg/resvg-js and jpeg-js):
//   node packages/companion/scripts/make-demo-images.mjs
import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const BELUGA = readFileSync(join(pkg, 'lib/beluga-path.ts'), 'utf8').match(/'(M[^']+)'/)[1];

const mark = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s / 1024})">
  <path d="M512 62C890 62 962 134 962 512S890 962 512 962 62 890 62 512 134 62 512 62Z" fill="url(#tile)"/>
  <path d="M512 62C890 62 962 134 962 512S890 962 512 962 62 890 62 512 134 62 512 62Z" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="5"/>
  <g transform="translate(512 512) scale(.76) translate(-512 -512)"><path d="${BELUGA}" fill="#F5F5F7" fill-rule="evenodd"/></g></g>`;

const defs = `<defs>
  <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2A2C31"/><stop offset="1" stop-color="#0F1013"/></linearGradient>
  <radialGradient id="silk" cx="50%" cy="0%" r="90%"><stop offset="0" stop-color="#3a3a42"/><stop offset=".45" stop-color="#1c1c20"/><stop offset="1" stop-color="#0f0f11"/></radialGradient>
  <radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <radialGradient id="copper" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#df946a" stop-opacity=".35"/><stop offset="1" stop-color="#df946a" stop-opacity="0"/></radialGradient>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2a4a"/><stop offset=".55" stop-color="#d9825b"/><stop offset="1" stop-color="#f3c27a"/></linearGradient>
  <linearGradient id="desk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b2d5c"/><stop offset=".5" stop-color="#6b4a8a"/><stop offset="1" stop-color="#d98a6a"/></linearGradient>
  <linearGradient id="map" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16251f"/><stop offset="1" stop-color="#0d1712"/></linearGradient>
</defs>`;

const font = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`;

const screens = {
  // A phone screenshot: the pairing screen.
  pairScreen: { w: 540, h: 1170, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="1170" viewBox="0 0 540 1170">${defs}
    <rect width="540" height="1170" fill="#FAF8F5"/>
    ${mark(200, 300, 140)}
    <text x="270" y="540" text-anchor="middle" ${font} font-size="38" font-weight="700" fill="#1F2328">Your Mac,</text>
    <text x="270" y="586" text-anchor="middle" ${font} font-size="38" font-weight="700" fill="#1F2328">in your pocket</text>
    ${[['#CDEFE0', 'Answer what needs you'], ['#CFE3FA', 'See what Claude makes'], ['#FBDCCB', 'Ask your Mac anything']].map(([c, t], i) => `<circle cx="150" cy="${650 + i * 54}" r="19" fill="${c}"/><text x="186" y="${657 + i * 54}" ${font} font-size="20" fill="#1F2328">${t}</text>`).join('')}
    <rect x="50" y="960" width="440" height="62" rx="31" fill="#1F2328"/>
    <text x="270" y="999" text-anchor="middle" ${font} font-size="21" font-weight="600" fill="#fff">Scan the code</text>
    <rect x="50" y="1036" width="440" height="62" rx="31" fill="#F2EFEA"/>
    <text x="270" y="1075" text-anchor="middle" ${font} font-size="21" font-weight="600" fill="#1F2328">Type the code</text></svg>` },
  // The fingerprint confirmation.
  confirmScreen: { w: 540, h: 1170, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="1170" viewBox="0 0 540 1170">${defs}
    <rect width="540" height="1170" fill="#FAF8F5"/>
    <text x="270" y="420" text-anchor="middle" ${font} font-size="34" font-weight="700" fill="#1F2328">Same on your Mac?</text>
    ${[0, 1, 2, 3].map((i) => `<rect x="${62 + i * 106}" y="470" width="92" height="108" rx="22" fill="#fff" stroke="#1F2328" stroke-opacity=".08"/>`).join('')}
    ${['#CDEFE0', '#FBDCCB', '#CFE3FA', '#E3DCF7'].map((c, i) => `<circle cx="${108 + i * 106}" cy="524" r="26" fill="${c}"/>`).join('')}
    <text x="270" y="640" text-anchor="middle" ${font} font-size="20" fill="#5B6169">If they match, click Pair on your Mac.</text></svg>` },
  // The Mac app: a contrast check.
  contrast: { w: 960, h: 600, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">${defs}
    <rect width="960" height="600" fill="#19191b"/>
    <rect x="0" y="0" width="230" height="600" fill="#26262a"/>
    ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="22" y="${70 + i * 40}" width="${150 - i * 12}" height="12" rx="6" fill="${i === 1 ? '#79aef0' : '#3a3a40'}"/>`).join('')}
    <circle cx="30" cy="26" r="7" fill="#ef7a72"/><circle cx="54" cy="26" r="7" fill="#e3a64a"/><circle cx="78" cy="26" r="7" fill="#6cc187"/>
    <text x="270" y="80" ${font} font-size="26" font-weight="700" fill="#ececee">Contrast · dark theme</text>
    ${[['Text on bg', '13.9 : 1', '#6cc187'], ['Secondary', '7.2 : 1', '#6cc187'], ['Tertiary', '4.1 : 1', '#e3a64a'], ['Copper on glass', '5.6 : 1', '#6cc187'], ['Hairline', '1.3 : 1', '#a8a8ae']].map(([a, b, c], i) => `
      <rect x="270" y="${120 + i * 86}" width="640" height="70" rx="14" fill="#2a2a2e"/>
      <text x="296" y="${163 + i * 86}" ${font} font-size="21" fill="#ececee">${a}</text>
      <text x="880" y="${163 + i * 86}" text-anchor="end" ${font} font-size="21" font-weight="700" fill="${c}">${b}</text>`).join('')}</svg>` },
  // Weather radar tiles.
  radar: { w: 900, h: 640, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="640" viewBox="0 0 900 640">${defs}
    <rect width="900" height="640" fill="url(#map)"/>
    ${Array.from({ length: 12 }, (_, i) => `<path d="M${i * 80 - 40} 0 L${i * 80 + 60} 640" stroke="#2b4a3c" stroke-width="2"/>`).join('')}
    ${Array.from({ length: 8 }, (_, i) => `<path d="M0 ${i * 90} L900 ${i * 90 + 40}" stroke="#2b4a3c" stroke-width="2"/>`).join('')}
    <ellipse cx="420" cy="300" rx="260" ry="170" fill="#3fb37f" fill-opacity=".45"/>
    <ellipse cx="470" cy="310" rx="170" ry="110" fill="#e3d24a" fill-opacity=".6"/>
    <ellipse cx="500" cy="320" rx="90" ry="60" fill="#ef7a52" fill-opacity=".75"/>
    <ellipse cx="520" cy="325" rx="35" ry="24" fill="#d94a8a" fill-opacity=".85"/>
    <ellipse cx="720" cy="140" rx="110" ry="60" fill="#3fb37f" fill-opacity=".4"/>
    <rect x="24" y="24" width="250" height="56" rx="16" fill="#000" fill-opacity=".45"/>
    <text x="46" y="61" ${font} font-size="24" font-weight="700" fill="#fff">Radar · 14:20</text></svg>` },
  // Mia's photo: a sunset.
  sunset: { w: 800, h: 1000, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">${defs}
    <rect width="800" height="1000" fill="url(#sky)"/>
    <circle cx="520" cy="560" r="90" fill="#ffe2a8" fill-opacity=".9"/>
    <path d="M0 700 L160 540 L300 660 L460 500 L620 650 L800 560 L800 1000 L0 1000Z" fill="#2a1f33"/>
    <path d="M0 800 L200 690 L380 790 L560 700 L800 820 L800 1000 L0 1000Z" fill="#17121f"/></svg>` },
  // A friend's desktop, as their Claude screenshots it.
  desktop: { w: 1280, h: 800, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">${defs}
    <rect width="1280" height="800" fill="url(#desk)"/>
    <rect width="1280" height="30" fill="#000" fill-opacity=".35"/>
    <text x="1250" y="21" text-anchor="end" ${font} font-size="15" fill="#fff">Thu 14:22</text>
    <rect x="120" y="90" width="700" height="460" rx="14" fill="#1e1e21"/>
    <rect x="120" y="90" width="700" height="40" rx="14" fill="#2a2a2e"/>
    <circle cx="146" cy="110" r="7" fill="#ef7a72"/><circle cx="170" cy="110" r="7" fill="#e3a64a"/><circle cx="194" cy="110" r="7" fill="#6cc187"/>
    ${Array.from({ length: 9 }, (_, i) => `<rect x="150" y="${160 + i * 38}" width="${300 + ((i * 97) % 280)}" height="14" rx="7" fill="${i === 3 ? '#df946a' : '#3a3a40'}"/>`).join('')}
    <rect x="700" y="300" width="460" height="380" rx="14" fill="#f4f4f6"/>
    <rect x="700" y="300" width="460" height="40" rx="14" fill="#e4e4e8"/>
    <rect x="730" y="370" width="400" height="180" rx="10" fill="#79aef0" fill-opacity=".35"/>
    <path d="M730 520 L800 470 L870 500 L960 420 L1050 450 L1130 390" stroke="#2f6cb3" stroke-width="5" fill="none"/>
    <rect x="730" y="580" width="180" height="14" rx="7" fill="#c7c7cc"/><rect x="730" y="610" width="260" height="14" rx="7" fill="#c7c7cc"/>
    <rect x="440" y="730" width="400" height="56" rx="18" fill="#fff" fill-opacity=".25"/>
    ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${462 + i * 62}" y="740" width="40" height="36" rx="10" fill="${['#df946a', '#79aef0', '#6cc187', '#ab93f3', '#e3a64a', '#ececee'][i]}"/>`).join('')}</svg>` },
  // A chart Claude made from the test timings.
  timings: { w: 960, h: 560, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="560" viewBox="0 0 960 560">${defs}
    <rect width="960" height="560" fill="#1e1e21"/>
    <text x="48" y="70" ${font} font-size="26" font-weight="700" fill="#ececee">Slowest suites</text>
    <text x="48" y="104" ${font} font-size="18" fill="#75757c">seconds, this run vs last</text>
    ${[['pairing', 9.2, 12.8], ['views', 6.1, 6.4], ['link', 4.8, 7.9], ['outputs', 3.3, 3.1], ['push', 2.4, 2.6]].map(([n, a, b], i) => `
      <text x="48" y="${170 + i * 74}" ${font} font-size="19" fill="#a8a8ae">${n}</text>
      <rect x="180" y="${150 + i * 74}" width="${b * 52}" height="14" rx="7" fill="#3a3a40"/>
      <rect x="180" y="${168 + i * 74}" width="${a * 52}" height="14" rx="7" fill="#df946a"/>
      <text x="${196 + b * 52}" y="${178 + i * 74}" ${font} font-size="16" fill="#ececee">${a}s</text>`).join('')}</svg>` },
};

const toJpeg = ({ w, svg }, quality = 82) => {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: w }, background: '#000' }).render();
  return Buffer.from(jpeg.encode({ data: r.pixels, width: r.width, height: r.height }, quality).data).toString('base64');
};

let out = '// Made by scripts/make-demo-images.mjs: the demo Mac\'s pictures, as JPEG (base64). Don\'t edit by hand.\n\n';
out += 'export const DEMO_IMAGES = {\n';
for (const [name, s] of Object.entries(screens)) {
  out += `  ${name}: { w: ${s.w}, h: ${s.h}, b64: '${toJpeg(s)}' },\n`;
}
out += '} as const;\nexport type DemoImage = keyof typeof DEMO_IMAGES;\n';
writeFileSync(join(pkg, 'lib/link/demo/images.generated.ts'), out);
console.log('wrote', Object.keys(screens).length, 'images,', Math.round(out.length / 1024), 'KB');
