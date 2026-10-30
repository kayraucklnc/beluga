import { describe, expect, it } from 'vitest';
import { newer, plainNotes, releaseOf } from '../packages/companion/lib/release.js';

/** The phone app updating itself (BLG-426): which APK the latest release carries, and whether it's newer. */

const release = {
  tag_name: 'v1.8.0-mac',
  body: '**Phones update themselves.**\n\n- **Update Now** on the phone, like the Mac\n- `Beluga-Link.apk` is unchanged\n\nThe Android app (`Beluga-1.8.0.apk`) is attached.',
  assets: [
    { name: 'Beluga-Link.apk', size: 2_000_000, browser_download_url: 'https://x/Beluga-Link.apk', digest: 'sha256:aa' },
    { name: 'Beluga_1.8.0_aarch64.dmg', size: 59_000_000, browser_download_url: 'https://x/b.dmg' },
    { name: 'Beluga-1.8.0.apk', size: 63_000_000, browser_download_url: 'https://x/Beluga-1.8.0.apk', digest: 'sha256:ABCDEF' },
  ],
};

describe('phone app updates', () => {
  it('compares versions as numbers', () => {
    expect(newer('1.10.0', '1.9.2')).toBe(true);
    expect(newer('1.8.0', '1.7.0')).toBe(true);
    expect(newer('1.7.0', '1.7.0')).toBe(false);
    expect(newer('1.6.9', '1.7.0')).toBe(false);
    expect(newer('2.0.0', '1.99.99')).toBe(true);
  });

  it('picks the app’s APK, not Beluga Link or the Mac’s files', () => {
    const r = releaseOf(release);
    expect(r).toMatchObject({ version: '1.8.0', name: 'Beluga-1.8.0.apk', size: 63_000_000, url: 'https://x/Beluga-1.8.0.apk', sha256: 'ABCDEF' });
  });

  it('finds nothing in a release without the phone app', () => {
    expect(releaseOf({ assets: [release.assets[0], release.assets[1]] })).toBeUndefined();
    expect(releaseOf({})).toBeUndefined();
  });

  it('has no digest when GitHub gives none', () => {
    const r = releaseOf({ assets: [{ ...release.assets[2], digest: null }] });
    expect(r?.sha256).toBeUndefined();
  });

  it('shows the notes as plain lines, without the attached-files line', () => {
    expect(plainNotes(release.body)).toBe('Phones update themselves.\n\n•  Update Now on the phone, like the Mac\n•  Beluga-Link.apk is unchanged');
  });
});
