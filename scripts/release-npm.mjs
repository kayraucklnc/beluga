#!/usr/bin/env node
// Release the terminal app to npm (`klaudcode`) from this Mac, instead of CI.
//
//   npm run release:npm              typecheck, test, build, publish, tag v<version>, push
//   npm run release:npm -- --dry-run do everything but publish and push
//
// If package.json's version is already on npm (or tagged), the patch number goes up
// (0.6.2 -> 0.6.3) and that bump is committed. For a minor or major release, set the version
// in package.json first. Needs `npm login` (once) and a clean checkout of main.
// Klaud for Mac has its own: packages/mac, npm run release (scripts/release-mac.mjs).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dry = process.argv.includes('--dry-run');
const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: root, stdio: 'inherit' });
const read = (cmd, argv) => execFileSync(cmd, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const pkg = () => JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

function fail(message) {
  console.error(`release-npm: ${message}`);
  process.exit(1);
}

try {
  read('npm', ['whoami']);
} catch {
  fail('not logged in to npm: run `npm login` first.');
}
if (read('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('release from main.');
if (read('git', ['status', '--porcelain'])) fail('the checkout has changes: commit or stash them first.');
run('git', ['pull', '--ff-only', 'origin', 'main']);

const { name } = pkg();
const published = (() => {
  try {
    return [].concat(JSON.parse(read('npm', ['view', name, 'versions', '--json'])));
  } catch {
    return [];
  }
})();
run('git', ['fetch', '--tags', '--quiet']);
const taken = (v) => published.includes(v) || read('git', ['tag', '-l', `v${v}`]) !== '';
let bumped = false;
while (taken(pkg().version)) {
  read('npm', ['version', 'patch', '--no-git-tag-version']);
  bumped = true;
}
const { version } = pkg();
console.log(`Releasing ${name}@${version}${bumped ? ' (patch bumped)' : ''}`);

run('npm', ['run', 'typecheck']);
run('npm', ['test']);
if (dry) {
  run('npm', ['publish', '--dry-run']);
  if (bumped) run('git', ['checkout', '--', 'package.json', 'package-lock.json']);
  console.log('\nDry run: nothing published, committed or pushed.');
  process.exit(0);
}
// prepublishOnly typechecks and builds dist/ again.
run('npm', ['publish', '--access', 'public']);
if (bumped) run('git', ['commit', '-am', `chore: release v${version}`]);
run('git', ['tag', `v${version}`]);
run('git', ['push', 'origin', 'HEAD:main', `v${version}`]);
console.log(`\nReleased ${name}@${version}: https://www.npmjs.com/package/${name}`);
