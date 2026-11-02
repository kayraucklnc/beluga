#!/usr/bin/env node
// The release APKs (BLG-430): Beluga-<version>.apk and Beluga-Link.apk in dist/, both signed with
// Beluga's own key and checked against signing.json. The key is ~/.beluga-release/beluga-android.p12
// (or BELUGA_ANDROID_KEYSTORE), its password in the Keychain as "beluga-android-release" (or
// BELUGA_ANDROID_KEY_PASSWORD). An APK signed with any other key can't update installed phones.
//
//   npm run apk            prebuild (clean), gradle assembleRelease, check, copy to dist/
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
const want = JSON.parse(fs.readFileSync(path.join(root, 'signing.json'), 'utf8')).sha256.toLowerCase();

const fail = (msg) => {
  console.error(`build-apk: ${msg}`);
  process.exit(1);
};

const keystore = process.env.BELUGA_ANDROID_KEYSTORE ?? path.join(home, '.beluga-release', 'beluga-android.p12');
if (!fs.existsSync(keystore)) fail(`no signing key at ${keystore}`);
let password = process.env.BELUGA_ANDROID_KEY_PASSWORD;
if (!password) {
  try {
    password = execFileSync('security', ['find-generic-password', '-s', 'beluga-android-release', '-w'], { encoding: 'utf8' }).trim();
  } catch {
    fail('the key’s password isn’t in the Keychain (beluga-android-release)');
  }
}

const sdk = process.env.ANDROID_HOME ?? path.join(home, 'Library', 'Android', 'sdk');
const env = {
  ...process.env,
  CI: '1',
  ANDROID_HOME: sdk,
  JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
  BELUGA_ANDROID_KEYSTORE: keystore,
  BELUGA_ANDROID_KEY_PASSWORD: password,
};

const run = (cmd, args, cwd = root) => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (r.status !== 0) fail(`${cmd} ${args[0] ?? ''} failed`);
};

run('npm', ['run', 'worklet:bundle']);
run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install', '--clean']);
fs.writeFileSync(path.join(root, 'android', 'local.properties'), `sdk.dir=${sdk}\n`);
run('./gradlew', ['assembleRelease'], path.join(root, 'android'));

const tools = path.join(sdk, 'build-tools');
const latest = fs.readdirSync(tools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
const apksigner = path.join(tools, latest, 'apksigner');
const signer = (apk) => {
  const out = execFileSync(apksigner, ['verify', '--print-certs', apk], { env, encoding: 'utf8' });
  const hex = /certificate SHA-256 digest: ([0-9a-f]+)/i.exec(out)?.[1];
  return hex?.match(/../g)?.join(':').toLowerCase();
};

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const outputs = [
  [path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'), `Beluga-${app.version}.apk`],
  [path.join(root, 'modules', 'phone-control', 'addon', 'build', 'outputs', 'apk', 'release', 'phone-control-addon-release.apk'), 'Beluga-Link.apk'],
];
for (const [from, name] of outputs) {
  if (!fs.existsSync(from)) fail(`no ${from}`);
  const got = signer(from);
  if (got !== want) fail(`${name} is signed with ${got ?? 'nothing'}, not Beluga's key (${want})`);
  fs.copyFileSync(from, path.join(dist, name));
  console.log(`✓ dist/${name} · ${(fs.statSync(from).size / 1e6).toFixed(0)} MB · signed with Beluga's key`);
}
