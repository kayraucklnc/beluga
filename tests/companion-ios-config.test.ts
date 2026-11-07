import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The iPhone app's config (packages/companion/app.config.js, README "iOS"): the team, bundle id and build number come from the environment, never the repo. */

const pkg = path.join(import.meta.dirname, '../packages/companion');
const require = createRequire(import.meta.url);
const withEnv = require(path.join(pkg, 'app.config.js')) as (ctx: { config: Record<string, unknown> }) => { ios: Record<string, unknown> };
const config = (JSON.parse(readFileSync(path.join(pkg, 'app.json'), 'utf8')) as { expo: Record<string, unknown> & { ios: Record<string, unknown> } }).expo;

afterEach(() => vi.unstubAllEnvs());

describe('iOS app config', () => {
  it('keeps app.json as it is without the environment', () => {
    vi.stubEnv('BELUGA_APPLE_TEAM_ID', '');
    vi.stubEnv('BELUGA_IOS_BUNDLE_ID', '');
    vi.stubEnv('BELUGA_IOS_BUILD_NUMBER', '');
    const out = withEnv({ config });
    expect(out.ios).toEqual(config.ios);
    expect(out.ios).not.toHaveProperty('appleTeamId');
  });

  it('takes the team, bundle id and build number from the environment', () => {
    vi.stubEnv('BELUGA_APPLE_TEAM_ID', 'ABCDE12345');
    vi.stubEnv('BELUGA_IOS_BUNDLE_ID', 'com.example.beluga');
    vi.stubEnv('BELUGA_IOS_BUILD_NUMBER', '2611050040');
    const out = withEnv({ config });
    expect(out.ios).toMatchObject({ appleTeamId: 'ABCDE12345', bundleIdentifier: 'com.example.beluga', buildNumber: '2611050040', icon: config.ios.icon });
    // app.json itself is untouched.
    expect(config.ios).not.toHaveProperty('appleTeamId');
    expect(config.ios.bundleIdentifier).toBe('sh.ratel.beluga');
  });

  it('refuses values Xcode would choke on', () => {
    vi.stubEnv('BELUGA_APPLE_TEAM_ID', 'my team');
    expect(() => withEnv({ config })).toThrow(/BELUGA_APPLE_TEAM_ID/);
    vi.stubEnv('BELUGA_APPLE_TEAM_ID', '');
    vi.stubEnv('BELUGA_IOS_BUNDLE_ID', 'beluga');
    expect(() => withEnv({ config })).toThrow(/BELUGA_IOS_BUNDLE_ID/);
    vi.stubEnv('BELUGA_IOS_BUNDLE_ID', '');
    vi.stubEnv('BELUGA_IOS_BUILD_NUMBER', '1.2.3.4');
    expect(() => withEnv({ config })).toThrow(/BELUGA_IOS_BUILD_NUMBER/);
  });

  it('says why it needs the camera, photos, microphone and local network', () => {
    const plist = config.ios.infoPlist as Record<string, unknown>;
    expect(plist.NSMicrophoneUsageDescription).toBeTruthy();
    expect(plist.NSLocalNetworkUsageDescription).toBeTruthy();
    expect(plist.ITSAppUsesNonExemptEncryption).toBe(false);
    const plugins = JSON.stringify(config.plugins);
    expect(plugins).toContain('cameraPermission');
    expect(plugins).toContain('photosPermission');
  });

  it('drops the push entitlement after expo-notifications adds it, so a free team can sign', () => {
    const plugins = (config.plugins as unknown[]).map((p) => (Array.isArray(p) ? p[0] : p));
    // Expo runs mods last-added first: the first plugin's runs after expo-notifications'.
    expect(plugins[0]).toBe('./plugins/no-push-entitlement');
    expect(plugins).toContain('expo-notifications');
  });

  it('has an opaque 1024 icon, as App Store Connect wants', () => {
    const png = readFileSync(path.join(pkg, config.ios.icon as string));
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
    // IHDR colour type 2 = RGB (6 would be RGBA: refused on upload).
    expect(png[25]).toBe(2);
  });
});
