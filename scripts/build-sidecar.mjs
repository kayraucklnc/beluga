#!/usr/bin/env node
// Everything the Mac app needs to run klaud by itself (no Node or klaud installed):
//   packages/mac/src-tauri/resources/daemon/   klaud compiled (dist/) + its production node_modules
//   packages/mac/src-tauri/binaries/node-<target>   an official Node binary (pinned below)
// Usage: node scripts/build-sidecar.mjs [--arch arm64|x64]
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** One place for the Node version: native modules' prebuilds must match its ABI. */
export const NODE_VERSION = '24.22.0';

const root = path.resolve(import.meta.dirname, '..');
const tauri = path.join(root, 'packages/mac/src-tauri');
const arch = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : process.arch;
const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// 1. klaud itself.
run('npm', ['run', 'build'], { cwd: root });
const out = path.join(tauri, 'resources/daemon');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, 'dist'), path.join(out, 'dist'), { recursive: true });
copyFileSync(path.join(root, 'package.json'), path.join(out, 'package.json'));
copyFileSync(path.join(root, 'package-lock.json'), path.join(out, 'package-lock.json'));

// 2. Its production dependencies, installed for this architecture (prebuilt native modules).
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', `--cpu=${arch}`, '--os=darwin'], { cwd: out, env: { ...process.env, npm_config_arch: arch } });
rmSync(path.join(out, 'package-lock.json'), { force: true });
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
console.log(`\nklaud sidecar ready for ${triple} (Node ${NODE_VERSION})`);
