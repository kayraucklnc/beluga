import { describe, expect, it } from 'vitest';

// Plain .mjs scripts (no types): what the tests use of them.
interface Desktop {
  platformKey(os: string, arch: string): string;
  assetName(file: string, productName: string): string;
  pickBuilt(os: string, files: string[]): { offered: string[]; update?: string };
  platformsOf(entries: Array<{ key: string; signature: string; url: string }>): Record<string, { signature: string; url: string }>;
}
interface Mac {
  mergeLatest(existing: unknown, next: { version: string; platforms: Record<string, unknown> }): { version: string; platforms: Record<string, unknown> };
}
const desktop = (): Promise<Desktop> => import('../scripts/release-desktop.mjs' as string) as Promise<Desktop>;
const mac = (): Promise<Mac> => import('../scripts/release-mac.mjs' as string) as Promise<Mac>;

describe('Linux and Windows releases (BLG-528)', () => {
  it('names platforms as the updater does and picks what it installs', async () => {
    const { platformKey, pickBuilt, assetName } = await desktop();
    expect(platformKey('linux', 'x64')).toBe('linux-x86_64');
    expect(platformKey('win32', 'arm64')).toBe('windows-aarch64');
    const linux = pickBuilt('linux', ['b/deb/Beluga_1.9.0_amd64.deb', 'b/appimage/Beluga_1.9.0_amd64.AppImage', 'b/appimage/Beluga_1.9.0_amd64.AppImage.sig', 'b/rpm/Beluga-1.9.0-1.x86_64.rpm']);
    expect(linux.update).toBe('b/appimage/Beluga_1.9.0_amd64.AppImage');
    expect(linux.offered).toHaveLength(3);
    expect(pickBuilt('win32', ['b/nsis/Beluga_1.9.0_x64-setup.exe', 'b/nsis/Beluga_1.9.0_x64-setup.exe.sig']).update).toBe('b/nsis/Beluga_1.9.0_x64-setup.exe');
    expect(assetName('Klaud_1.9.0_x64-setup.exe', 'Klaud')).toBe('Beluga_1.9.0_x64-setup.exe');
  });

  it("adds each platform to the release's latest.json and keeps the Mac's of the same version", async () => {
    const { mergeLatest } = await mac();
    const { platformsOf } = await desktop();
    const macs = { version: '1.9.0', notes: '- Faster', platforms: { 'darwin-aarch64': { signature: 'm', url: 'u-mac' } } };
    const merged = mergeLatest(macs, { version: '1.9.0', platforms: platformsOf([{ key: 'linux-x86_64', signature: 'l', url: 'u-linux' }]) });
    expect(Object.keys(merged.platforms).sort()).toEqual(['darwin-aarch64', 'linux-x86_64']);
    // An older version's entries would offer an older build: they go.
    expect(Object.keys(mergeLatest({ ...macs, version: '1.8.0' }, { version: '1.9.0', platforms: { 'windows-x86_64': {} } }).platforms)).toEqual(['windows-x86_64']);
    expect(mergeLatest(undefined, { version: '1.9.0', platforms: { a: 1 } }).platforms).toEqual({ a: 1 });
  });
});
