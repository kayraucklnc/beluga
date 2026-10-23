#!/usr/bin/env node
// Publish the last `klaudcode` (the npm name before the rename) and deprecate it, so terminal installs
// from before the rename hear about Beluga. Run it once, right after `npm run release:npm` put the same
// version on npm as beluga-code.
//
//   npm run release:klaudcode              publish klaudcode@<version>, then npm deprecate klaudcode
//   npm run release:klaudcode -- --dry-run pack it as klaudcode, publish nothing
//
// It's this same Beluga under the old name. An old klaudcode's `klaud update` only asks npm about
// klaudcode, so it installs this one; this one says on every start how to move (src/core/rename-note.ts),
// and its own `klaud update` moves the install to beluga-code (src/update/update.ts).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LEGACY = 'klaudcode';
// klaudcode goes first: npm won't install beluga-code over klaudcode's `klaud` command.
const DEPRECATE_MESSAGE = 'Klaud is now Beluga: npm uninstall -g klaudcode && npm i -g beluga-code';

const root = path.resolve(import.meta.dirname, '..');
const dry = process.argv.includes('--dry-run');
const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: root, stdio: 'inherit' });
const read = (cmd, argv) => execFileSync(cmd, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const versionsOf = (name) => {
  try {
    return [].concat(JSON.parse(read('npm', ['view', name, 'versions', '--json'])));
  } catch {
    return [];
  }
};

function fail(message) {
  console.error(`release-klaudcode: ${message}`);
  process.exit(1);
}

const manifest = path.join(root, 'package.json');
const original = readFileSync(manifest, 'utf8');
const pkg = JSON.parse(original);
const { version } = pkg;

if (!dry) {
  try {
    read('npm', ['whoami']);
  } catch {
    fail('not logged in to npm: run `npm login` first.');
  }
  if (read('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('release from main.');
  if (read('git', ['status', '--porcelain'])) fail('the checkout has changes: commit or stash them first.');
}
// Moving over has to land somewhere: beluga-code goes out first, at this same version.
if (!versionsOf(pkg.name).includes(version)) {
  if (!dry) fail(`${pkg.name}@${version} isn't on npm yet: run \`npm run release:npm\` first.`);
  console.warn(`release-klaudcode: ${pkg.name}@${version} isn't on npm yet (fine for a dry run).`);
}
if (versionsOf(LEGACY).includes(version)) fail(`${LEGACY}@${version} is already on npm.`);

console.log(`Releasing ${LEGACY}@${version}: Beluga under its old npm name, pointing to ${pkg.name}`);
// Built before the name changes: npm drops a bin whose file isn't there yet, and klaud is the bin.
run('npm', ['run', 'build']);
// Only the name changes, and only for the publish: package.json goes back as it was, whatever happens.
writeFileSync(manifest, `${JSON.stringify({ ...pkg, name: LEGACY }, null, 2)}\n`);
try {
  // prepublishOnly typechecks and builds dist/ again.
  run('npm', dry ? ['publish', '--dry-run'] : ['publish', '--access', 'public']);
} finally {
  writeFileSync(manifest, original);
}
if (dry) {
  console.log(`\nDry run: nothing published. Then it would run: npm deprecate ${LEGACY} "${DEPRECATE_MESSAGE}"`);
  process.exit(0);
}
// Every version, this last one too: npm shows it on each install, and `npm view` still finds the newest.
run('npm', ['deprecate', LEGACY, DEPRECATE_MESSAGE]);
console.log(`\nReleased ${LEGACY}@${version} and deprecated ${LEGACY}: https://www.npmjs.com/package/${LEGACY}`);
