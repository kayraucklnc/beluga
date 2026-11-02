#!/usr/bin/env node
// Linux and Windows builds of Beluga on a release (.github/workflows/release-desktop.yml), next to
// the Mac's (scripts/release-mac.mjs). Two steps:
//
//   node scripts/release-desktop.mjs collect --tag v1.9.0-mac --out release-out
//       after `tauri build` on a Linux or Windows runner: copy what people download (deb, rpm,
//       AppImage / the Windows installer) to <out>, named for the app, and write <out>/<target>.json
//       for each signed one (linux-x86_64, linux-x86_64-deb, windows-x86_64-nsis…)
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

/**
 * The updater targets a signed package answers to (tauri-plugin-updater looks for
 * `{os}-{arch}-{installer}`, then `{os}-{arch}`): the AppImage and the Windows installer are also
 * the plain one; a .deb or .rpm install only takes its own kind, so each gets its own name.
 */
export function updateTargets(key, file) {
  if (file.endsWith('.AppImage')) return [key, `${key}-appimage`];
  if (file.endsWith('-setup.exe')) return [key, `${key}-nsis`];
  if (file.endsWith('.deb')) return [`${key}-deb`];
  if (file.endsWith('.rpm')) return [`${key}-rpm`];
  return [];
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
  if (!offered.length) throw new Error(`Nothing to offer in ${bundle}: did tauri build run?`);
  mkdirSync(out, { recursive: true });
  for (const f of offered) copyFileSync(f, path.join(out, assetName(path.basename(f), conf.productName)));
  const key = platformKey(os, process.arch);
  // Each signed package updates the installs of its own kind (an AppImage, a .deb, an .rpm, the
  // Windows installer). Without signatures (a run that didn't sign) the packages are still offered,
  // and latest.json skips them.
  const signed = offered.filter((f) => existsSync(`${f}.sig`));
  for (const file of signed) {
    const name = assetName(path.basename(file), conf.productName);
    const signature = readFileSync(`${file}.sig`, 'utf8').trim();
    copyFileSync(`${file}.sig`, path.join(out, `${name}.sig`));
    for (const target of updateTargets(key, file)) writeFileSync(path.join(out, `${target}.json`), `${JSON.stringify({ key: target, version: conf.version, signature, url: assetUrl(tag, name) }, null, 2)}\n`);
  }
  if (!update || !signed.includes(update)) console.warn(`release-desktop: no signed update for ${os}; installed copies won't update to this one`);
  console.log(`Collected for ${key}:\n${readdirSync(out).map((f) => `  ${f}`).join('\n')}`);
}

/** The platforms the builds wrote, as latest.json's entries. */
export function platformsOf(entries) {
  return Object.fromEntries(entries.map((e) => [e.key, { signature: e.signature, url: e.url }]));
}

function publish({ tag, dir }) {
  const files = walk(dir);
  const entries = files.filter((f) => /\/(linux|windows)-[\w-]+\.json$/.test(f.replaceAll('\\', '/'))).map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const uploads = files.filter((f) => !f.endsWith('.json'));
  if (!uploads.length) throw new Error(`No builds in ${dir}`);
  execFileSync('gh', ['release', 'upload', tag, ...uploads, '--repo', REPO, '--clobber'], { stdio: 'inherit' });
  if (!entries.length) return console.log(`Uploaded to ${tag}; nothing signed for updates, so latest.json stays as it was`);
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
