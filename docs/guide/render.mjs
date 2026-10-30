// Renders the short guide to PDF: node docs/guide/render.mjs  →  docs/guide/beluga-guide.pdf
import path from 'node:path';
import { createRequire } from 'node:module';

const dir = import.meta.dirname;
const { chromium } = createRequire(path.join(dir, '../../packages/mac/package.json'))('playwright');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file://${path.join(dir, 'beluga-guide.html')}`, { waitUntil: 'networkidle' });
await page.pdf({ path: path.join(dir, 'beluga-guide.pdf'), preferCSSPageSize: true, printBackground: true });
await browser.close();
