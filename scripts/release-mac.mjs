#!/usr/bin/env node
// Release Klaud for Mac by hand: build it, sign the update, and put it on GitHub so every
// installed Klaud finds it (they read releases/latest/download/latest.json).
//
//   node scripts/release-mac.mjs --notes notes.md            build, then create the release
//   node scripts/release-mac.mjs --notes-text "Faster" --dry-run   build only; print what it would upload
//   node scripts/release-mac.mjs --set-version 0.5.0          set the app's version (then commit it)
//
// Options:
//   --notes <file> | --notes-text <text>   release notes (markdown; shown in the app's update sheet)
//   --tag <tag>        default v<version>-mac (CI's npm releases use v<version>)
//   --skip-build       reuse what the last `npm run app:build` made
//   --dry-run          build and write latest.json, but don't touch GitHub
//   --force            release even if GitHub's latest release isn't older
//   --key <file>       the updater's private key (default ~/.tauri/klaud-updater.key, or
//                      $TAURI_SIGNING_PRIVATE_KEY); its password, if any, from
//                      $TAURI_SIGNING_PRIVATE_KEY_PASSWORD or <key>.password
//
// A maintainer's tool: nothing runs it automatically. Needs macOS, gh (logged in) and the key.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPO = 'kayraucklnc/klaud';
const root = path.resolve(import.meta.dirname, '..');
const mac = path.join(root, 'packages/mac');
const confFile = path.join(mac, 'src-tauri/tauri.conf.json');
const pkgFile = path.join(mac, 'package.json');

/** "1.2.3" or "v1.2.3-mac" → [1, 2, 3]; undefined when it isn't a version. */
export function versionParts(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Whether `next` is a newer release than `prev` (a prerelease of the same numbers isn't). */
export function isNewer(next, prev) {
  const a = versionParts(next);
  const b = versionParts(prev);
  if (!a) return false;
  if (!b) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export const archOf = (nodeArch = process.arch) => (nodeArch === 'arm64' ? 'aarch64' : 'x64');
export const updateAsset = (version, arch) => `Klaud_${version}_${arch}.app.tar.gz`;
export const assetUrl = (tag, name) => `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;

/** The file every installed Klaud reads to learn about this release (tauri-plugin-updater's format). */
export function latestJson({ version, notes, pubDate, signature, url, arch }) {
  return { version, notes, pub_date: pubDate, platforms: { [`darwin-${arch}`]: { signature: signature.trim(), url } } };
}

function args(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--notes', '--notes-text', '--tag', '--key', '--set-version'].includes(a)) out[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) out.flags.add(a.slice(2));
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...opts });
const read = (cmd, argv) => execFileSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Set the app's version in both places it's written (the window reads tauri.conf.json's). */
function setVersion(version) {
  if (!versionParts(version)) throw new Error(`Not a version: ${version}`);
  for (const file of [confFile, pkgFile]) {
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
  }
  console.log(`Klaud for Mac is now ${version} (tauri.conf.json, package.json). Commit it, then release.`);
}

function signingEnv(opts) {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) return {};
  const key = opts.key ?? path.join(os.homedir(), '.tauri/klaud-updater.key');
  if (!existsSync(key)) throw new Error(`No updater key at ${key}. See docs/updates.md (or pass --key).`);
  const passFile = `${key}.password`;
  const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? (existsSync(passFile) ? readFileSync(passFile, 'utf8').trim() : '');
  return { TAURI_SIGNING_PRIVATE_KEY: readFileSync(key, 'utf8').trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password };
}

/** The version GitHub's latest release offers, if there is one with a latest.json. */
function publishedVersion() {
  try {
    return JSON.parse(read('gh', ['release', 'download', '--repo', REPO, '--pattern', 'latest.json', '--output', '-'])).version;
  } catch {
    return undefined;
  }
}

function notesOf(opts) {
  if (opts.notes) return readFileSync(opts.notes, 'utf8').trim();
  return (opts['notes-text'] ?? '').trim();
}

function main() {
  const opts = args(process.argv.slice(2));
  if (opts['set-version']) return setVersion(opts['set-version']);
  const version = readJson(confFile).version;
  const pkgVersion = readJson(pkgFile).version;
  if (version !== pkgVersion) throw new Error(`tauri.conf.json says ${version} but packages/mac/package.json says ${pkgVersion}: run --set-version first.`);
  const notes = notesOf(opts);
  if (!notes) throw new Error('Say what changed: --notes <file.md> or --notes-text "…"');
  const tag = opts.tag ?? `v${version}-mac`;
  const dry = opts.flags.has('dry-run');

  if (!dry) {
    const published = publishedVersion();
    if (published && !isNewer(version, published) && !opts.flags.has('force')) {
      throw new Error(`GitHub's latest release is ${published}; ${version} isn't newer, so no Klaud would update. Bump it: --set-version.`);
    }
  }

  const arch = archOf();
  if (!opts.flags.has('skip-build')) {
    console.log(`Building Klaud ${version} (${arch}) with update signing…`);
    run('npm', ['run', 'app:build'], { cwd: mac, env: { ...process.env, ...signingEnv(opts) } });
  }

  const bundle = path.join(mac, 'src-tauri/target/release/bundle');
  const app = path.join(bundle, 'macos/Klaud.app.tar.gz');
  const dmg = path.join(bundle, `dmg/Klaud_${version}_${arch}.dmg`);
  for (const f of [app, `${app}.sig`, dmg]) if (!existsSync(f)) throw new Error(`Missing ${f}: did the build sign the update? (createUpdaterArtifacts, the key)`);

  const out = path.join(bundle, 'release');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const name = updateAsset(version, arch);
  copyFileSync(app, path.join(out, name));
  copyFileSync(`${app}.sig`, path.join(out, `${name}.sig`));
  copyFileSync(dmg, path.join(out, path.basename(dmg)));
  const signature = readFileSync(`${app}.sig`, 'utf8');
  const latest = latestJson({ version, notes, pubDate: new Date().toISOString(), signature, url: assetUrl(tag, name), arch });
  writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  writeFileSync(path.join(out, 'notes.md'), `${notes}\n`);
  const files = ['latest.json', name, `${name}.sig`, path.basename(dmg)].map((f) => path.join(out, f));
  console.log(`\nReady in ${out}:\n${files.map((f) => `  ${path.basename(f)}`).join('\n')}`);
  if (dry) return console.log(`\nDry run: nothing uploaded. The release would be ${tag} on ${REPO}, marked latest.`);

  let exists = true;
  try {
    read('gh', ['release', 'view', tag, '--repo', REPO]);
  } catch {
    exists = false;
  }
  if (exists) {
    run('gh', ['release', 'upload', tag, ...files, '--repo', REPO, '--clobber']);
    run('gh', ['release', 'edit', tag, '--repo', REPO, '--latest', '--notes-file', path.join(out, 'notes.md')]);
  } else {
    run('gh', ['release', 'create', tag, ...files, '--repo', REPO, '--latest', '--title', `Klaud ${version}`, '--notes-file', path.join(out, 'notes.md')]);
  }
  console.log(`\nReleased Klaud ${version}: https://github.com/${REPO}/releases/tag/${tag}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    console.error(`release-mac: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
