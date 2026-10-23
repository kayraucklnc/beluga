import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BELUGA } from '../packages/mac/src/components/beluga-path.js';

/** The beluga everywhere the app shows its icon, all from assets/beluga.svg (packages/mac/scripts/make-icons.mjs). */
const root = path.resolve(import.meta.dirname, '..');
const read = (file: string): Buffer => readFileSync(path.join(root, file));
const pngSize = (png: Buffer): [number, number] => [png.readUInt32BE(16), png.readUInt32BE(20)];

describe('the beluga', () => {
  const drawing = read('assets/beluga.svg').toString().match(/ d="([^"]+)"/)?.[1];

  it('is one path, and every copy of it is the drawing', () => {
    expect(drawing).toBeTruthy();
    expect(BELUGA).toBe(drawing);
    for (const logo of ['assets/logo.svg', 'assets/logo-light.svg']) expect(read(logo).toString()).toContain(drawing);
    for (const banner of ['assets/banner-light.svg', 'assets/banner-dark.svg']) expect(read(banner).toString()).toContain(drawing);
  });

  it('left no >_ mark behind', () => {
    for (const file of ['assets/logo.svg', 'assets/banner-light.svg', 'assets/banner-dark.svg', 'packages/mac/src/onboarding/Mark.tsx', 'packages/mac/dmg/background.html']) {
      expect(read(file).toString(), file).not.toMatch(/M318 386|M5 6\.5l5 4\.5/);
    }
  });

  it('sits in the menu bar at exactly @2x (macOS draws it 18 points tall)', () => {
    expect(pngSize(read('packages/mac/src-tauri/icons/tray.png'))[1]).toBe(36);
  });

  it('comes in every size the bundle lists', () => {
    const conf = JSON.parse(read('packages/mac/src-tauri/tauri.conf.json').toString()) as { bundle: { icon: string[] } };
    for (const icon of conf.bundle.icon.filter((f) => /\d+x\d+/.test(f))) {
      const [, w, h, x2] = icon.match(/(\d+)x(\d+)(@2x)?/) ?? [];
      expect(pngSize(read(path.join('packages/mac/src-tauri', icon))), icon).toEqual([Number(w) * (x2 ? 2 : 1), Number(h) * (x2 ? 2 : 1)]);
    }
  });
});
