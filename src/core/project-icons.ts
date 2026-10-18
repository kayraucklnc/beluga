import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { klaudHome } from './home.js';

/**
 * A project's own icon, for screens to show next to its name: one you chose, else the one the
 * project ships (app icon, favicon, logo), found where frameworks usually keep it.
 */

export interface ProjectIcon {
  readonly mime: string;
  /** base64 */
  readonly data: string;
}

/** Biggest icon file read (a favicon or app icon is far smaller). */
const MAX_ICON_BYTES = 512 * 1024;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.icns': '',
};

/** Where projects keep their icon, best first (paths are relative to the project folder). */
const CANDIDATES: readonly string[] = [
  '.klaud/icon.png',
  '.klaud/icon.svg',
  // Tauri, Electron, desktop apps
  'src-tauri/icons/128x128@2x.png',
  'src-tauri/icons/icon.png',
  'build/icon.png',
  'resources/icon.png',
  'assets/icon.png',
  // Next.js (app router), Remix, Vite, CRA, Astro, SvelteKit, Nuxt, Rails, Django static
  'app/icon.png',
  'app/icon.svg',
  'src/app/icon.png',
  'src/app/icon.svg',
  'app/apple-icon.png',
  'src/app/apple-icon.png',
  'public/apple-touch-icon.png',
  'public/icon.png',
  'public/icon.svg',
  'public/logo.svg',
  'public/logo.png',
  'public/logo192.png',
  'public/favicon.svg',
  'public/favicon.png',
  'static/favicon.png',
  'static/favicon.svg',
  'web/favicon.png',
  'app/favicon.ico',
  'src/app/favicon.ico',
  'public/favicon.ico',
  'static/favicon.ico',
  // Repos with a logo in the README
  'logo.svg',
  'logo.png',
  'icon.png',
  'icon.svg',
  'assets/logo.svg',
  'assets/logo.png',
  'docs/logo.svg',
  'docs/logo.png',
  '.github/logo.svg',
  '.github/logo.png',
  'favicon.ico',
];

/** Monorepos keep the app in a subfolder: apps/web/public/favicon.ico and the like. */
const NESTED_PARENTS = ['apps', 'packages'];
const NESTED: readonly string[] = ['public/apple-touch-icon.png', 'public/favicon.svg', 'public/favicon.png', 'app/icon.png', 'src/app/icon.png', 'src-tauri/icons/128x128@2x.png', 'public/favicon.ico', 'app/favicon.ico'];

const isFile = (p: string): boolean => {
  try {
    const st = statSync(p);
    return st.isFile() && st.size > 0 && st.size <= MAX_ICON_BYTES;
  } catch {
    return false;
  }
};

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
};

/** An Xcode app icon: the biggest PNG up to 512 pixels in AppIcon.appiconset. */
function xcodeIcon(root: string): string | undefined {
  const sets: string[] = [];
  for (const top of ['', ...subdirs(root).filter((d) => !['node_modules', 'Pods', 'build', 'DerivedData'].includes(d))]) {
    for (const assets of [path.join(root, top, 'Assets.xcassets'), ...subdirs(path.join(root, top)).map((d) => path.join(root, top, d, 'Assets.xcassets'))]) {
      const set = path.join(assets, 'AppIcon.appiconset');
      if (subdirs(assets).includes('AppIcon.appiconset')) sets.push(set);
    }
    if (sets.length) break;
  }
  for (const set of sets) {
    let files: string[];
    try {
      files = readdirSync(set).filter((f) => f.toLowerCase().endsWith('.png'));
    } catch {
      continue;
    }
    const size = (f: string): number => {
      const m = /(\d+)(?:x\d+)?(?:@(\d)x)?/.exec(f);
      return m ? Number(m[1]) * Number(m[2] ?? 1) : 0;
    };
    const best = files.filter((f) => size(f) <= 512).sort((a, b) => size(b) - size(a))[0] ?? files[0];
    if (best && isFile(path.join(set, best))) return path.join(set, best);
  }
  return undefined;
}

/** The icon file a project ships, if any. */
export function findProjectIcon(root: string): string | undefined {
  for (const rel of CANDIDATES) {
    const abs = path.join(root, rel);
    if (isFile(abs)) return abs;
  }
  const xcode = xcodeIcon(root);
  if (xcode) return xcode;
  for (const parent of NESTED_PARENTS) {
    for (const sub of subdirs(path.join(root, parent))) {
      for (const rel of NESTED) {
        const abs = path.join(root, parent, sub, rel);
        if (isFile(abs)) return abs;
      }
    }
  }
  return undefined;
}

const iconsDir = (): string => path.join(klaudHome(), 'project-icons');
const keyOf = (root: string): string => createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16);

/** The icon you chose for a project, if you did. */
function chosenIcon(root: string, dir = iconsDir()): string | undefined {
  const key = keyOf(root);
  for (const ext of ['.png', '.svg', '.jpg', '.jpeg', '.webp', '.ico']) {
    const abs = path.join(dir, key + ext);
    if (isFile(abs)) return abs;
  }
  return undefined;
}

/** The project's icon to show: yours, else its own, else none (screens draw its initial). */
export function readProjectIcon(root: string, dir = iconsDir()): ProjectIcon | undefined {
  const file = chosenIcon(root, dir) ?? findProjectIcon(root);
  const mime = file ? MIME[path.extname(file).toLowerCase()] : undefined;
  if (!file || !mime) return undefined;
  try {
    return { mime, data: readFileSync(file).toString('base64') };
  } catch {
    return undefined;
  }
}

/** Use this image as the project's icon (undefined: back to the project's own). */
export function chooseProjectIcon(root: string, image: string | undefined, dir = iconsDir()): void {
  const existing = chosenIcon(root, dir);
  if (existing) rmSync(existing, { force: true });
  if (!image) return;
  const ext = path.extname(image).toLowerCase();
  if (!MIME[ext]) throw new Error('Pick a PNG, SVG, JPEG, WebP or ICO image');
  if (!isFile(image)) throw new Error(`That image is missing or bigger than ${MAX_ICON_BYTES / 1024} KB`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(image, path.join(dir, keyOf(root) + ext));
}

export interface FoundProject {
  readonly path: string;
  readonly name: string;
  /** When it last changed (its git folder), for "most recent first". */
  readonly changed: number;
}

/** Folders people keep their code in. */
const CODE_DIRS = ['Projects', 'projects', 'Developer', 'code', 'Code', 'dev', 'src', 'repos', 'Repos', 'GitHub', 'github', 'git', 'work', 'Work', 'workspace', 'Sites', 'Documents/GitHub', 'Documents/Projects'];

const gitChanged = (dir: string): number | undefined => {
  try {
    return statSync(path.join(dir, '.git')).mtimeMs;
  } catch {
    return undefined;
  }
};

/**
 * Git repositories in the usual code folders (two levels deep) that aren't projects yet, most
 * recently worked on first: one click to add them.
 */
export function suggestProjects(existing: readonly string[], home = os.homedir(), limit = 24): FoundProject[] {
  // The same folder by its real name ("Projects" and "projects" are one folder on a Mac).
  const real = (p: string): string => {
    try {
      return realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const known = new Set(existing.map(real));
  const found = new Map<string, FoundProject>();
  const visit = (dir: string, depth: number): void => {
    for (const name of subdirs(dir)) {
      if (name === 'node_modules') continue;
      const abs = real(path.join(dir, name));
      const changed = gitChanged(abs);
      if (changed !== undefined) {
        if (!known.has(abs)) found.set(abs, { path: abs, name, changed });
      } else if (depth > 1) visit(abs, depth - 1);
    }
  };
  for (const dir of new Set(CODE_DIRS.map((rel) => real(path.join(home, rel))))) visit(dir, 2);
  return [...found.values()].sort((a, b) => b.changed - a.changed).slice(0, limit);
}
