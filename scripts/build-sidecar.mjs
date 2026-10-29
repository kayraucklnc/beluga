#!/usr/bin/env node
// Everything the Mac app needs to run Beluga by itself (no Node or Beluga installed):
//   packages/mac/src-tauri/resources/daemon/   Beluga compiled (dist/) + its production node_modules
//   packages/mac/src-tauri/binaries/node-<target>   an official Node binary (pinned below)
// Usage: node scripts/build-sidecar.mjs [--arch arm64|x64]
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** One place for the Node version: native modules' prebuilds must match its ABI. */
export const NODE_VERSION = '24.22.0';

const root = path.resolve(import.meta.dirname, '..');
const tauri = path.join(root, 'packages/mac/src-tauri');
const arch = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : process.arch;
const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// 1. Beluga itself.
run('npm', ['run', 'build'], { cwd: root });
const out = path.join(tauri, 'resources/daemon');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, 'dist'), path.join(out, 'dist'), { recursive: true });
copyFileSync(path.join(root, 'package.json'), path.join(out, 'package.json'));
copyFileSync(path.join(root, 'package-lock.json'), path.join(out, 'package-lock.json'));

// 2. Its production dependencies, installed for this architecture (prebuilt native modules).
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', `--cpu=${arch}`, '--os=darwin'], { cwd: out, env: { ...process.env, npm_config_arch: arch } });
// Claude Code's binary (239 MB, half the app) isn't bundled: the app downloads this exact package on
// first launch and checks it against the integrity pinned here (src/agent/claude-code.ts, BLG-384).
{
  const lock = JSON.parse(readFileSync(path.join(out, 'package-lock.json'), 'utf8'));
  const name = `@anthropic-ai/claude-agent-sdk-darwin-${arch}`;
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry?.resolved || !entry?.integrity) throw new Error(`${name} isn't in package-lock.json`);
  writeFileSync(path.join(out, 'claude-code.json'), JSON.stringify({ version: entry.version, url: entry.resolved, integrity: entry.integrity }, null, 2) + '\n');
  rmSync(path.join(out, 'node_modules', name), { recursive: true, force: true });
}
rmSync(path.join(out, 'package-lock.json'), { force: true });
// Nothing loads these at run time (BLG-383): cloudflared's binary (downloaded to ~/.beluga/bin when
// the relay fallback first needs it), mathjax's es5 build (math-svg.ts uses mathjax-full/js), and
// whisper's C++ sources and wasm fallback (the native darwin build is there).
for (const dir of ['cloudflared/bin', 'mathjax-full/es5', '@fugood/whisper.node/src', '@fugood/node-whisper-wasm']) rmSync(path.join(out, 'node_modules', dir), { recursive: true, force: true });
// Nor type declarations, source maps, TypeScript sources or docs (licenses stay).
const junk = /\.(d\.[cm]?ts|[cm]?ts|map|md|markdown)$/i;
const strip = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) strip(p);
    else if (junk.test(e.name) && !/^licen[cs]e/i.test(e.name)) rmSync(p, { force: true });
  }
};
strip(path.join(out, 'node_modules'));
// Prebuilt binaries for other systems aren't needed in a Mac app.
const prune = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name === 'prebuilds') {
      for (const plat of readdirSync(p)) if (!plat.startsWith(`darwin-${arch}`) && plat !== 'darwin') rmSync(path.join(p, plat), { recursive: true, force: true });
    } else prune(p);
  }
};
prune(path.join(out, 'node_modules'));
// node-pty's helper must stay executable (some copies drop the bit).
const helper = path.join(out, `node_modules/@lydell/node-pty-darwin-${arch}/prebuilds/darwin-${arch}/spawn-helper`);
if (existsSync(helper)) chmodSync(helper, 0o755);

// 3. Node.
const bin = path.join(tauri, 'binaries', `node-${triple}`);
mkdirSync(path.dirname(bin), { recursive: true });
rmSync(bin, { force: true });
const tmp = mkdtempSync(path.join(os.tmpdir(), 'klaud-node-'));
const name = `node-v${NODE_VERSION}-darwin-${arch}`;
run('curl', ['-fsSL', '-o', path.join(tmp, 'node.tar.gz'), `https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`]);
run('tar', ['-xzf', path.join(tmp, 'node.tar.gz'), '-C', tmp, `${name}/bin/node`]);
copyFileSync(path.join(tmp, name, 'bin/node'), bin);
chmodSync(bin, 0o755);
rmSync(tmp, { recursive: true, force: true });
writeFileSync(path.join(out, 'NODE_VERSION'), NODE_VERSION);

// The daemon reports its package.json version, and the app restarts a kept-alive daemon whose
// version isn't the one it bundles (after an update). Beluga's own version doesn't change with
// every Mac release, so the bundled copy carries the app's too: 0.4.0+mac.0.5.1.
{
  const appVersion = JSON.parse(readFileSync(path.join(tauri, 'tauri.conf.json'), 'utf8')).version;
  const pkgFile = path.join(out, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  pkg.version = `${String(pkg.version).split('+')[0]}+mac.${appVersion}`;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
}
console.log(`\nBeluga sidecar ready for ${triple} (Node ${NODE_VERSION})`);
