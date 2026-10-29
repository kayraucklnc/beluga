// The install window: Beluga's .dmg with its own background, the two icons placed on it,
// the ".app" hidden, and the volume's hidden files moved out of view (so they stay out of
// sight even for people who show hidden files in Finder).
//
//   node scripts/make-dmg.mjs [path/to/Beluga.app] [out.dmg]
//
// Defaults to the app `tauri build` made. Needs macOS (hdiutil, osascript, tiffutil, SetFile).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.resolve(import.meta.dirname, '..');
const conf = JSON.parse(readFileSync(path.join(here, 'src-tauri/tauri.conf.json'), 'utf8'));
const name = conf.productName;
const version = conf.version;
const app = path.resolve(process.argv[2] ?? path.join(here, `src-tauri/target/release/bundle/macos/${name}.app`));
const out = path.resolve(process.argv[3] ?? path.join(here, `src-tauri/target/release/bundle/dmg/${name}_${version}_${os.arch() === 'arm64' ? 'aarch64' : 'x64'}.dmg`));

// The window, in points; the icons sit where the background expects them (see dmg/background.html).
const WINDOW = { x: 200, y: 140, width: 660, height: 420 };
const ICON_SIZE = 112;
const TITLE_BAR = 28;
const APP_AT = [190, 205];
const APPLICATIONS_AT = [470, 205];
// Off the window's edge: Finder keeps these hidden files out of view there.
const AWAY = [WINDOW.width + 200, WINDOW.height + 200];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts }).toString().trim();

if (!existsSync(app)) throw new Error(`No app at ${app}: run tauri build first`);
const work = mkdtempSync(path.join(os.tmpdir(), 'beluga-dmg-'));
const stage = path.join(work, 'stage');
mkdirSync(path.join(stage, '.background'), { recursive: true });
cpSync(app, path.join(stage, `${name}.app`), { recursive: true, verbatimSymlinks: true });
symlinkSync('/Applications', path.join(stage, 'Applications'));
// One file with both resolutions, so the window is sharp on Retina screens.
run('tiffutil', ['-cathidpicheck', path.join(here, 'dmg/background.png'), path.join(here, 'dmg/background@2x.png'), '-out', path.join(stage, '.background/background.tiff')]);
const icns = path.join(here, 'src-tauri/icons/icon.icns');
if (existsSync(icns)) cpSync(icns, path.join(stage, '.VolumeIcon.icns'));

const rw = path.join(work, 'rw.dmg');
run('hdiutil', ['create', '-volname', name, '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDRW', '-ov', rw]);
const attached = run('hdiutil', ['attach', '-readwrite', '-noverify', '-noautoopen', '-nobrowse', rw]);
const mount = attached.split('\n').map((l) => l.split('\t').pop().trim()).find((p) => p.startsWith('/Volumes/'));
if (!mount) throw new Error(`Couldn't mount the image:\n${attached}`);
const volume = path.basename(mount);

try {
  if (existsSync(path.join(mount, '.VolumeIcon.icns'))) run('SetFile', ['-a', 'C', mount]);
  const hidden = ['.background', '.VolumeIcon.icns', '.fseventsd', '.Trashes', '.DS_Store'];
  const script = `
tell application "Finder"
  tell disk "${volume}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    -- The bounds include the title bar: the content area is the background's size.
    set the bounds of container window to {${WINDOW.x}, ${WINDOW.y}, ${WINDOW.x + WINDOW.width}, ${WINDOW.y + WINDOW.height + TITLE_BAR}}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to ${ICON_SIZE}
    set text size of opts to 13
    set label position of opts to bottom
    set background picture of opts to file ".background:background.tiff"
    set extension hidden of item "${name}.app" to true
    set position of item "${name}.app" of container window to {${APP_AT.join(', ')}}
    set position of item "Applications" of container window to {${APPLICATIONS_AT.join(', ')}}
${hidden.map((f) => `    try\n      set position of item "${f}" of container window to {${AWAY.join(', ')}}\n    end try`).join('\n')}
    update without registering applications
    delay 1
    close
  end tell
end tell`;
  run('osascript', ['-e', script]);
  run('sync', []);
} finally {
  run('hdiutil', ['detach', mount, '-force']);
}

mkdirSync(path.dirname(out), { recursive: true });
rmSync(out, { force: true });
// LZMA (macOS 10.15+; Beluga needs 12): about a quarter smaller than zlib's UDZO (BLG-382).
run('hdiutil', ['convert', rw, '-format', 'ULMO', '-o', out]);
rmSync(work, { recursive: true, force: true });
console.log(out);
