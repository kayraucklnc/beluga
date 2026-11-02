import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePlist, type Plist, asDict } from './formats.js';
import { TERMINAL_APPS, TERMINAL_APP_NAMES, type TerminalAppId, type TerminalFound } from './look.js';
import { type Parsed, type ReadFile, familyFromPostScript, parseAlacritty, parseGhostty, parseIterm, parseKitty, parseTerminalApp, parseWarp, parseWarpTheme, parseWeztermScheme, parseWezterm } from './parsers.js';

/**
 * Which other terminals are on this Mac, and what their settings come to (BLG-212). Reads only:
 * their settings files, their preferences (through `defaults export`, which has what's current),
 * and the theme files they point at. Nothing is written, and nothing but the look is kept.
 */

export interface DetectOptions {
  /** Your home folder (a test's stand-in). */
  readonly home?: string;
  /** Where apps are installed (default /Applications, ~/Applications and macOS's own). */
  readonly appDirs?: readonly string[];
  /** Read preferences with `defaults export` (off in tests: the files are read instead). */
  readonly defaults?: boolean;
  /** Ask macOS for the family of fonts given by PostScript name (off in tests). */
  readonly fonts?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

const MAX_BYTES = 1024 * 1024;

const readText = (file: string): string | undefined => {
  try {
    const st = statSync(file);
    return st.isFile() && st.size <= MAX_BYTES ? readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
};

const readBytes = (file: string, max = 8 * MAX_BYTES): Uint8Array | undefined => {
  try {
    const st = statSync(file);
    return st.isFile() && st.size <= max ? new Uint8Array(readFileSync(file)) : undefined;
  } catch {
    return undefined;
  }
};

const run = (cmd: string, args: readonly string[], input?: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    const child = execFile(cmd, [...args], { timeout: 5000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, out) => resolve(err ? undefined : out));
    if (input !== undefined) child.stdin?.end(input);
  });

const first = (files: readonly string[]): string | undefined => files.find((f) => readText(f) !== undefined);

/** A path from a config: ~ expanded, relative to the config's folder. */
const resolveFrom = (dir: string, home: string, p: string): string => (p.startsWith('~/') ? path.join(home, p.slice(2)) : path.isAbsolute(p) ? p : path.join(dir, p));

/** Files under `dir` (a few levels down) whose names end in one of `exts`. */
function filesUnder(dir: string, exts: readonly string[], depth = 2): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) return depth > 0 ? filesUnder(full, exts, depth - 1) : [];
      return exts.some((e) => d.name.toLowerCase().endsWith(e)) ? [full] : [];
    });
  } catch {
    return [];
  }
}

const APP_BUNDLES: Readonly<Record<TerminalAppId, readonly string[]>> = {
  ghostty: ['Ghostty.app'],
  iterm2: ['iTerm.app', 'iTerm2.app'],
  terminal: ['Utilities/Terminal.app', 'Terminal.app'],
  alacritty: ['Alacritty.app'],
  kitty: ['kitty.app'],
  wezterm: ['WezTerm.app'],
  warp: ['Warp.app'],
};

interface Ctx {
  readonly home: string;
  readonly config: string;
  readonly apps: Readonly<Record<TerminalAppId, string | undefined>>;
  readonly defaults: boolean;
}

const tilde = (home: string, p: string): string => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

/** Ghostty's theme files by name: yours (~/.config/ghostty/themes), then the ones it comes with. */
function ghosttyTheme(ctx: Ctx, name: string): string | undefined {
  if (path.isAbsolute(name)) return readText(name);
  if (name.includes('/') || name.includes('..')) return undefined;
  const dirs = [path.join(ctx.config, 'ghostty', 'themes'), path.join(ctx.home, 'Library', 'Application Support', 'com.mitchellh.ghostty', 'themes'), ...(ctx.apps.ghostty ? [path.join(ctx.apps.ghostty, 'Contents', 'Resources', 'ghostty', 'themes')] : []), '/Applications/Ghostty.app/Contents/Resources/ghostty/themes'];
  for (const d of dirs) {
    const t = readText(path.join(d, name));
    if (t !== undefined) return t;
  }
  return undefined;
}

async function readPrefs(ctx: Ctx, domain: string, file: string): Promise<Plist | undefined> {
  if (ctx.defaults) {
    const xml = await run('defaults', ['export', domain, '-']);
    if (xml) {
      const p = parsePlist(new TextEncoder().encode(xml));
      if (p) return p;
    }
  }
  const bytes = readBytes(file);
  return bytes ? parsePlist(bytes) : undefined;
}

type Reading = { file?: string; parsed?: Parsed };

const READERS: Readonly<Record<TerminalAppId, (ctx: Ctx) => Promise<Reading> | Reading>> = {
  ghostty: (ctx) => {
    const support = path.join(ctx.home, 'Library', 'Application Support', 'com.mitchellh.ghostty');
    const files = [path.join(ctx.config, 'ghostty', 'config'), path.join(ctx.config, 'ghostty', 'config.ghostty'), path.join(support, 'config'), path.join(support, 'config.ghostty')].filter((f) => readText(f) !== undefined);
    if (!files.length) return {};
    // Ghostty reads them all, in this order: later ones win.
    const text = files.map((f) => readText(f)!).join('\n');
    const dir = path.dirname(files[0]!);
    const read: ReadFile = (name) => (name.startsWith('theme:') ? ghosttyTheme(ctx, name.slice(6)) : readText(resolveFrom(dir, ctx.home, name)));
    return { file: files.at(-1)!, parsed: parseGhostty(text, read) };
  },
  iterm2: async (ctx) => {
    const file = path.join(ctx.home, 'Library', 'Preferences', 'com.googlecode.iterm2.plist');
    let prefs = await readPrefs(ctx, 'com.googlecode.iterm2', file);
    if (!prefs) return {};
    let from = file;
    // iTerm2 can keep its settings in a folder of your choosing.
    const root = asDict(prefs);
    if (root?.['LoadPrefsFromCustomFolder'] === true && typeof root['PrefsCustomFolder'] === 'string') {
      const custom = path.join(resolveFrom(ctx.home, ctx.home, root['PrefsCustomFolder']), 'com.googlecode.iterm2.plist');
      const bytes = readBytes(custom);
      const p = bytes ? parsePlist(bytes) : undefined;
      if (p) {
        prefs = p;
        from = custom;
      }
    }
    return { file: from, parsed: parseIterm(prefs) };
  },
  terminal: async (ctx) => {
    const file = path.join(ctx.home, 'Library', 'Preferences', 'com.apple.Terminal.plist');
    const prefs = await readPrefs(ctx, 'com.apple.Terminal', file);
    return prefs ? { file, parsed: parseTerminalApp(prefs) } : {};
  },
  alacritty: (ctx) => {
    // Where Alacritty looks, in its order (the TOML before the older YAML).
    const a = path.join(ctx.config, 'alacritty');
    const file = first([path.join(a, 'alacritty.toml'), path.join(ctx.config, 'alacritty.toml'), path.join(ctx.home, '.alacritty.toml'), path.join(a, 'alacritty.yml'), path.join(a, 'alacritty.yaml'), path.join(ctx.config, 'alacritty.yml'), path.join(ctx.home, '.alacritty.yml')]);
    if (!file) return {};
    const dir = path.dirname(file);
    return { file, parsed: parseAlacritty(readText(file)!, (p) => readText(resolveFrom(dir, ctx.home, p)), /\.ya?ml$/.test(file)) };
  },
  kitty: (ctx) => {
    const dir = path.join(ctx.config, 'kitty');
    const file = path.join(dir, 'kitty.conf');
    const text = readText(file);
    return text === undefined ? {} : { file, parsed: parseKitty(text, (p) => readText(resolveFrom(dir, ctx.home, p))) };
  },
  wezterm: (ctx) => {
    const file = first([path.join(ctx.home, '.wezterm.lua'), path.join(ctx.config, 'wezterm', 'wezterm.lua')]);
    if (!file) return {};
    const read: ReadFile = (name) => {
      if (!name.startsWith('scheme:')) return undefined;
      const scheme = name.slice(7);
      for (const f of filesUnder(path.join(ctx.config, 'wezterm', 'colors'), ['.toml'], 1)) {
        const t = readText(f);
        if (t !== undefined && (path.basename(f, '.toml') === scheme || parseWeztermScheme(t).name === scheme)) return t;
      }
      // Most of WezTerm's built-in schemes are the same ones Ghostty comes with.
      return ghosttyTheme(ctx, scheme);
    };
    return { file, parsed: parseWezterm(readText(file)!, read) };
  },
  warp: async (ctx) => {
    const file = path.join(ctx.home, '.warp', 'settings.toml');
    const settings = readText(file);
    // Older Warp keeps these in its defaults instead.
    const extra: Record<string, unknown> = {};
    if (ctx.defaults && ctx.apps.warp) {
      const p = asDict(await readPrefs(ctx, 'dev.warp.Warp-Stable', path.join(ctx.home, 'Library', 'Preferences', 'dev.warp.Warp-Stable.plist')));
      for (const k of ['Theme', 'FontName', 'FontSize', 'LineHeightRatio', 'CursorBlink', 'ExtraMetaKeys']) if (p?.[k] !== undefined && typeof p[k] !== 'object') extra[k] = p[k];
    }
    if (settings === undefined && !Object.keys(extra).length) return {};
    const read: ReadFile = (name) => {
      if (!name.startsWith('theme:')) return undefined;
      const theme = name.slice(6);
      const dirs = [path.join(ctx.home, '.warp', 'themes'), path.join(ctx.home, '.local', 'share', 'warp-terminal', 'themes')];
      for (const f of dirs.flatMap((d) => filesUnder(d, ['.yaml', '.yml']))) {
        const t = readText(f);
        if (t !== undefined && (path.basename(f).replace(/\.ya?ml$/, '') === theme || parseWarpTheme(t).name === theme)) return t;
      }
      return ghosttyTheme(ctx, theme);
    };
    return { file: settings !== undefined ? file : undefined, parsed: parseWarp(settings, read, extra) };
  },
};

/** PostScript font names → their families, from macOS (one osascript for them all). */
async function fontFamilies(names: readonly string[]): Promise<Record<string, string | null>> {
  if (!names.length || process.platform !== 'darwin') return {};
  const script = `ObjC.import('AppKit'); const out = {}; for (const n of ${JSON.stringify(names)}) { const f = $.NSFont.fontWithNameSize(n, 12); out[n] = f.isNil() ? null : f.familyName.js; } JSON.stringify(out);`;
  const res = await run('osascript', ['-l', 'JavaScript', '-e', script]);
  try {
    return res ? (JSON.parse(res) as Record<string, string | null>) : {};
  } catch {
    return {};
  }
}

/** The terminals on this Mac (installed, or with settings to read), and what each one's look is. */
export async function detectTerminals(opts: DetectOptions = {}): Promise<TerminalFound[]> {
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const appDirs = opts.appDirs ?? ['/Applications', path.join(home, 'Applications'), '/System/Applications'];
  const apps = Object.fromEntries(TERMINAL_APPS.map((app) => [app, appDirs.flatMap((d) => APP_BUNDLES[app].map((b) => path.join(d, b))).find((p) => existsSync(p))])) as Record<TerminalAppId, string | undefined>;
  const ctx: Ctx = { home, config: env['XDG_CONFIG_HOME'] && path.isAbsolute(env['XDG_CONFIG_HOME']) ? env['XDG_CONFIG_HOME'] : path.join(home, '.config'), apps, defaults: opts.defaults ?? true };
  const readings = await Promise.all(
    TERMINAL_APPS.map(async (app) => {
      try {
        return [app, await READERS[app](ctx)] as const;
      } catch {
        return [app, {}] as const;
      }
    }),
  );
  const postscripts = [...new Set(readings.map(([, r]) => r.parsed?.postscript).filter((n): n is string => !!n))];
  const families = opts.fonts === false ? {} : await fontFamilies(postscripts);
  const found: TerminalFound[] = [];
  for (const [app, r] of readings) {
    const installed = !!apps[app];
    if (!installed && !r.file) continue;
    let look = r.parsed?.look;
    const ps = r.parsed?.postscript;
    if (look && ps) {
      const family = families[ps];
      look = { ...look, font: family && !/^\.?SF ?Mono/i.test(family) ? family : family === null || family === undefined ? familyFromPostScript(ps) : '' };
    }
    found.push({ app, name: TERMINAL_APP_NAMES[app], installed, ...(r.file ? { file: tilde(home, r.file) } : {}), ...(look ? { look } : {}), notes: r.parsed?.notes ?? (installed ? [`${TERMINAL_APP_NAMES[app]} is on its standard settings: nothing to bring.`] : []) });
  }
  return found;
}
