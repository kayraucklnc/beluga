#!/usr/bin/env node
// Linux and Windows builds of Beluga on a release (.github/workflows/release-desktop.yml), next to
// the Mac's (scripts/release-mac.mjs). Two steps:
//
//   node scripts/release-desktop.mjs collect --tag v1.9.0-mac --out release-out
//       after `tauri build` on a Linux or Windows runner: copy what people download (deb, rpm,
//       AppImage / the Windows installer) to <out>, named for the app, and write <out>/<platform>.json
//       with the update's signature and download URL
//   node scripts/release-desktop.mjs publish --tag v1.9.0-mac --dir artifacts
//       once every build is done: upload the files, and add each platform to the release's
//       latest.json (the Mac's entry stays)
//
// Needs gh (GH_TOKEN in CI). The updater's key comes from $TAURI_SIGNING_PRIVATE_KEY at build time.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP, REPO, assetUrl, mergeLatest, releasedLatest } from './release-mac.mjs';

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(root, 'packages/mac/src-tauri/target/release/bundle');

/** tauri-plugin-updater's name for a platform: linux-x86_64, windows-aarch64… */
export const platformKey = (os, arch) => `${os === 'win32' ? 'windows' : os}-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`;

/** A built file as it's offered: Beluga_1.9.0_amd64.AppImage, Beluga_1.9.0_x64-setup.exe… */
export const assetName = (file, productName) => (productName === APP ? file : file.replace(productName, APP));

/**
 * What a build made for people, and which of those the updater installs (Linux: the AppImage, as
 * deb and rpm come from a package manager; Windows: the NSIS installer).
 */
export function pickBuilt(os, files) {
  const ends = (f, ...ext) => ext.some((e) => f.endsWith(e));
  const offered = files.filter((f) => (os === 'win32' ? ends(f, '-setup.exe') : ends(f, '.AppImage', '.deb', '.rpm')));
  const update = offered.find((f) => (os === 'win32' ? ends(f, '-setup.exe') : ends(f, '.AppImage')));
  return { offered, update };
}

/** Every file under a folder (relative paths). */
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name)) : []);

function args() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (name) => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : undefined);
  return { cmd, tag: opt('tag'), out: opt('out') ?? 'release-out', dir: opt('dir') ?? 'artifacts', notes: opt('notes') };
}

function collect({ tag, out }) {
  const os = process.platform;
  const conf = JSON.parse(readFileSync(path.join(root, 'packages/mac/src-tauri/tauri.conf.json'), 'utf8'));
  const files = walk(bundle);
  const { offered, update } = pickBuilt(os, files);
  if (!update) throw new Error(`No ${os === 'win32' ? 'installer' : 'AppImage'} in ${bundle}: did tauri build run?`);
  if (!existsSync(`${update}.sig`)) throw new Error(`${path.basename(update)} isn't signed: is TAURI_SIGNING_PRIVATE_KEY set?`);
  mkdirSync(out, { recursive: true });
  for (const f of offered) copyFileSync(f, path.join(out, assetName(path.basename(f), conf.productName)));
  const name = assetName(path.basename(update), conf.productName);
  copyFileSync(`${update}.sig`, path.join(out, `${name}.sig`));
  const key = platformKey(os, process.arch);
  writeFileSync(path.join(out, `${key}.json`), `${JSON.stringify({ key, version: conf.version, signature: readFileSync(`${update}.sig`, 'utf8').trim(), url: assetUrl(tag, name) }, null, 2)}\n`);
  console.log(`Collected for ${key}:\n${readdirSync(out).map((f) => `  ${f}`).join('\n')}`);
}

/** The platforms the builds wrote, as latest.json's entries. */
export function platformsOf(entries) {
  return Object.fromEntries(entries.map((e) => [e.key, { signature: e.signature, url: e.url }]));
}

function publish({ tag, dir }) {
  const files = walk(dir);
  const entries = files.filter((f) => /\/(linux|windows)-[\w]+\.json$/.test(f.replaceAll('\\', '/'))).map((f) => JSON.parse(readFileSync(f, 'utf8')));
  if (!entries.length) throw new Error(`No builds in ${dir}`);
  const uploads = files.filter((f) => !f.endsWith('.json'));
  execFileSync('gh', ['release', 'upload', tag, ...uploads, '--repo', REPO, '--clobber'], { stdio: 'inherit' });
  const existing = releasedLatest(tag);
  const version = entries[0].version;
  const latest = mergeLatest(existing, { version, notes: existing?.notes ?? '', pub_date: existing?.pub_date ?? new Date().toISOString(), platforms: platformsOf(entries) });
  const file = path.join(dir, 'latest.json');
  writeFileSync(file, `${JSON.stringify(latest, null, 2)}\n`);
  execFileSync('gh', ['release', 'upload', tag, file, '--repo', REPO, '--clobber'], { stdio: 'inherit' });
  console.log(`latest.json for ${tag} now offers: ${Object.keys(latest.platforms).join(', ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const a = args();
  try {
    if (!a.tag) throw new Error('--tag is needed');
    if (a.cmd === 'collect') collect(a);
    else if (a.cmd === 'publish') publish(a);
    else throw new Error('collect or publish');
  } catch (err) {
    console.error(`release-desktop: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
