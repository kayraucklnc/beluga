// Builds the link worklet (worklet/link.ts) into the bundle the app starts in Bare
// (worklet/dist/link.bundle.mjs, imported by lib/link/bare.ts):
//   1. tsc compiles the worklet and what it imports from the repo (src/companion/client.ts, ...)
//      to plain ES modules in worklet/build (bare-pack doesn't map './x.js' imports to .ts files);
//   2. bare-pack packs that module graph for Android (and iOS), with native addons linked
//      (`--linked`: udx-native and sodium-native come from the app, see README "The link");
// Usage: npm run worklet:bundle [-- --ios]
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: pkg, stdio: 'inherit' });
const ios = process.argv.includes('--ios');

rmSync(join(pkg, 'worklet/build'), { recursive: true, force: true });
run('npx', ['tsc', '-p', 'worklet/tsconfig.build.json']);
// The compiled files are ES modules.
writeFileSync(join(pkg, 'worklet/build/package.json'), '{ "type": "module" }\n');
mkdirSync(join(pkg, 'worklet/dist'), { recursive: true });
const hosts = ios ? ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'] : ['android-arm64', 'android-arm', 'android-x64', 'android-ia32'];
run('npx', ['bare-pack', '--linked', ...hosts.flatMap((h) => ['--host', h]), '--out', 'worklet/dist/link.bundle.mjs', 'worklet/build/packages/companion/worklet/link.js']);
// 3. Link the native addons the bundle loads (udx-native, sodium-native, ...) into the directory
//    react-native-bare-kit builds into the app (it lives in node_modules: re-run after npm install).
const entry = 'worklet/build/packages/companion/worklet/link.js';
if (ios) run('npx', ['bare-link', '--preset', 'ios', '--out', 'node_modules/react-native-bare-kit/ios/addons', entry]);
else run('npx', ['bare-link', '--preset', 'android', '--out', 'node_modules/react-native-bare-kit/android/src/main/addons', entry]);
console.log('worklet bundled: worklet/dist/link.bundle.mjs (addons linked)');
