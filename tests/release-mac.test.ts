import { describe, expect, it } from 'vitest';

/** The maintainer's Mac release script (scripts/release-mac.mjs): what it writes, not what it runs. */

interface ReleaseScript {
  isNewer(next: string, prev: string | undefined): boolean;
  archOf(nodeArch: string): string;
  updateAsset(version: string, arch: string): string;
  dmgAsset(version: string, arch: string): string;
  assetUrl(tag: string, name: string): string;
  latestJson(o: { version: string; notes: string; pubDate: string; signature: string; url: string; arch: string }): unknown;
}

const script = (): Promise<ReleaseScript> => import('../scripts/release-mac.mjs' as string) as Promise<ReleaseScript>;

describe('release-mac', () => {
  it('only releases a version newer than what GitHub offers', async () => {
    const { isNewer } = await script();
    expect(isNewer('0.4.1', '0.4.0')).toBe(true);
    expect(isNewer('0.5.0', 'v0.4.9-mac')).toBe(true);
    expect(isNewer('0.4.0', '0.4.0')).toBe(false);
    expect(isNewer('0.4.0', '0.10.0')).toBe(false);
    expect(isNewer('1.0.0', undefined)).toBe(true);
    expect(isNewer('nope', '0.1.0')).toBe(false);
  });

  it('writes the latest.json every installed copy reads, with Orca-named files', async () => {
    const { archOf, assetUrl, dmgAsset, latestJson, updateAsset } = await script();
    const arch = archOf('arm64');
    const name = updateAsset('0.5.0', arch);
    expect(name).toBe('Orca_0.5.0_aarch64.app.tar.gz');
    expect(dmgAsset('0.5.0', arch)).toBe('Orca_0.5.0_aarch64.dmg');
    const url = assetUrl('v0.5.0-mac', name);
    expect(url).toBe('https://github.com/kayraucklnc/orca/releases/download/v0.5.0-mac/Orca_0.5.0_aarch64.app.tar.gz');
    expect(latestJson({ version: '0.5.0', notes: '- Faster', pubDate: '2026-10-18T10:00:00.000Z', signature: 'c2ln\n', url, arch })).toEqual({
      version: '0.5.0',
      notes: '- Faster',
      pub_date: '2026-10-18T10:00:00.000Z',
      platforms: { 'darwin-aarch64': { signature: 'c2ln', url } },
    });
  });
});
