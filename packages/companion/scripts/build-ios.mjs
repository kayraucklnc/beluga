#!/usr/bin/env node
// The iPhone app (README "iOS"): the Xcode project, an archive, or a build on TestFlight. Signing
// is Xcode's automatic signing for your Apple team; nothing about the team is in the repo.
//
//   npm run ios:prepare      worklet bundle, prebuild (clean), pods: then open ios/Beluga.xcworkspace
//   npm run ios:archive      … and a Release archive + dist/Beluga-<version>-<build>.ipa
//   npm run ios:testflight   … and upload it to App Store Connect (TestFlight)
//
// Needs BELUGA_APPLE_TEAM_ID for archive/testflight (also fine for prepare: Xcode then has the team
// set). BELUGA_IOS_BUNDLE_ID when the team can't use sh.ratel.beluga; BELUGA_IOS_BUILD_NUMBER to
// pick the build number (default: the time, yymmddHHMM, so every upload is new). The upload signs
// in with Xcode's account (Xcode › Settings › Accounts), or with an App Store Connect API key:
// BELUGA_ASC_KEY_PATH (the .p8), BELUGA_ASC_KEY_ID, BELUGA_ASC_ISSUER_ID.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
const MODES = ['prepare', 'archive', 'testflight'];
const mode = process.argv[2] ?? 'prepare';

const fail = (msg) => {
  console.error(`build-ios: ${msg}`);
  process.exit(1);
};

if (!MODES.includes(mode)) fail(`say one of ${MODES.join(', ')}, not "${mode}"`);
if (process.platform !== 'darwin') fail('iOS builds need a Mac with Xcode');
const team = process.env.BELUGA_APPLE_TEAM_ID?.trim();
if (mode !== 'prepare' && !team) fail('set BELUGA_APPLE_TEAM_ID to your Apple team ID (developer.apple.com › Membership details)');

const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(2, 12);
const build = process.env.BELUGA_IOS_BUILD_NUMBER?.trim() || (mode === 'prepare' ? undefined : stamp());
const env = {
  ...process.env,
  CI: '1',
  // CocoaPods fails on Ruby 3.4+ without a UTF-8 locale.
  LANG: process.env.LANG?.includes('UTF-8') ? process.env.LANG : 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  ...(build ? { BELUGA_IOS_BUILD_NUMBER: build } : {}),
};

const ios = path.join(root, 'ios');
const run = (cmd, args, cwd = root) => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (r.status !== 0) fail(`${cmd} ${args[0] ?? ''} failed`);
};

run('npm', ['run', 'worklet:bundle', '--', '--ios']);
run('npx', ['expo', 'prebuild', '--platform', 'ios', '--no-install', '--clean']);
run('pod', ['install'], ios);
if (mode === 'prepare') {
  console.log(`✓ open ${path.relative(process.cwd(), path.join(ios, 'Beluga.xcworkspace'))} in Xcode${team ? '' : ' and pick your team under Signing & Capabilities'}`);
  process.exit(0);
}

const dist = path.join(root, 'dist');
const archive = path.join(dist, `Beluga-${app.version}-${build}.xcarchive`);
fs.mkdirSync(dist, { recursive: true });
run('xcodebuild', [
  '-workspace', 'Beluga.xcworkspace', '-scheme', 'Beluga', '-configuration', 'Release',
  '-destination', 'generic/platform=iOS', '-archivePath', archive, '-allowProvisioningUpdates',
  `DEVELOPMENT_TEAM=${team}`, 'CODE_SIGN_STYLE=Automatic', 'archive',
], ios);

const upload = mode === 'testflight';
const options = path.join(dist, 'ExportOptions.plist');
fs.writeFileSync(options, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${upload ? 'upload' : 'export'}</string>
  <key>teamID</key><string>${team}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict></plist>
`);
const { BELUGA_ASC_KEY_PATH: key, BELUGA_ASC_KEY_ID: keyId, BELUGA_ASC_ISSUER_ID: issuer } = process.env;
const auth = key && keyId && issuer ? ['-authenticationKeyPath', key, '-authenticationKeyID', keyId, '-authenticationKeyIssuerID', issuer] : [];
run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', options, '-exportPath', dist, '-allowProvisioningUpdates', ...auth], ios);

if (upload) console.log(`✓ Beluga ${app.version} (${build}) uploaded: it shows in App Store Connect › TestFlight once Apple has processed it (a few minutes)`);
else console.log(`✓ ${path.relative(root, archive)} and its .ipa in dist/ (Xcode › Window › Organizer can upload the archive too)`);
