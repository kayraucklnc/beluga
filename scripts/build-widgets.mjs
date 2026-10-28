#!/usr/bin/env node
// Beluga's desktop widgets (BLG-309): packages/mac/widgets/ built into
//   packages/mac/widgets/build/BelugaWidgets.appex
// which tauri.conf.json puts in Beluga.app/Contents/PlugIns (bundle.macOS.files). Plain swiftc, no
// Xcode project: the extension entry point, the App Intents metadata the widget's Edit menu needs,
// its Info.plist (a new CFBundleVersion each build: macOS ignores a rebuilt widget with the same one),
// then signed with its own sandbox entitlements before Tauri signs the app around it (never --deep).
// Needs Xcode (appintentsmetadataprocessor isn't in the Command Line Tools).
// Usage: node scripts/build-widgets.mjs [--arch arm64|x64]
//   $APPLE_SIGNING_IDENTITY signs it (the app's identity: "Beluga Self-Signed" for releases), else ad hoc.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'packages/mac/widgets');
const out = path.join(src, 'build');
const conf = JSON.parse(readFileSync(path.join(root, 'packages/mac/src-tauri/tauri.conf.json'), 'utf8'));
const arch = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : process.arch;
const triple = `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`;
const identity = process.env.APPLE_SIGNING_IDENTITY || '-';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const read = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

const sdk = read('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
const toolchain = path.dirname(path.dirname(read('xcrun', ['-f', 'swiftc'])));
const xcode = /Build version (\S+)/.exec(read('xcodebuild', ['-version']))?.[1] ?? '';
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);

const appex = path.join(out, 'BelugaWidgets.appex');
const obj = path.join(out, 'obj');
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(appex, 'Contents/MacOS'), { recursive: true });
mkdirSync(path.join(appex, 'Contents/Resources'), { recursive: true });
mkdirSync(obj, { recursive: true });

// 1. The extension, its entry point _NSExtensionMain as Xcode links it.
const source = path.join(src, 'BelugaWidgets.swift');
const consts = path.join(obj, 'BelugaWidgets.swiftconstvalues');
const binary = path.join(appex, 'Contents/MacOS/BelugaWidgets');
run('xcrun', ['swiftc', '-target', triple, '-sdk', sdk, '-swift-version', '5', '-O', '-wmo', '-parse-as-library', '-module-name', 'BelugaWidgets', '-application-extension', '-emit-const-values-path', consts, '-Xfrontend', '-const-gather-protocols-file', '-Xfrontend', path.join(src, 'const-gather-protocols.json'), '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain', source, '-o', binary]);
writeFileSync(
  path.join(appex, 'Contents/Info.plist'),
  readFileSync(path.join(src, 'Info.plist'), 'utf8').replaceAll('__ID__', conf.identifier).replaceAll('__VERSION__', conf.version).replaceAll('__BUILD__', `${conf.version}.${stamp}`),
);
writeFileSync(path.join(appex, 'Contents/PkgInfo'), 'XPC!????');

// 2. The App Intents metadata (Xcode's "Extract App Intents Metadata"): the widget's Edit menu.
writeFileSync(path.join(obj, 'sources.txt'), `${source}\n`);
writeFileSync(path.join(obj, 'constvals.txt'), `${consts}\n`);
writeFileSync(path.join(obj, 'metadata.txt'), '');
run('xcrun', ['appintentsmetadataprocessor', '--output', path.join(appex, 'Contents/Resources'), '--toolchain-dir', toolchain, '--module-name', 'BelugaWidgets', '--sdk-root', sdk, '--xcode-version', xcode, '--platform-family', 'macOS', '--deployment-target', '14.0', '--target-triple', triple, '--binary-file', binary, '--source-file-list', path.join(obj, 'sources.txt'), '--swift-const-vals-list', path.join(obj, 'constvals.txt'), '--metadata-file-list', path.join(obj, 'metadata.txt'), '--force']);
rmSync(obj, { recursive: true, force: true });

// 3. Signed with its own entitlements (the app is signed around it by Tauri, without --deep).
run('xattr', ['-cr', appex]);
run('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp=none', '--entitlements', path.join(src, 'widgets.entitlements'), appex]);
run('codesign', ['--verify', '--strict', appex]);
console.log(`Built ${path.relative(root, appex)} (${conf.version}.${stamp}, signed ${identity === '-' ? 'ad hoc' : `with ${identity}`})`);
