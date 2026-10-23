import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type AppState, isRunning } from '../core/store.js';
import { type Run, compareVersions, decide, fetchLatest, installRoot, installedVersion, isGitCheckout, isGlobalNpmInstall, latestOnNpm, makeRun, readStatus } from './check.js';
import { runUpdate } from './update.js';

/**
 * The terminal app keeping itself up to date (the Mac app has its own updater, which brings its
 * daemon along: src-tauri/src/updater.rs). It looks at launch and every few hours; with
 * "Update automatically" on, a newer Beluga from npm is installed in the background and a daemon
 * that nothing is using restarts into it. Otherwise it says once that there's a new version.
 * The decisions are pure (`lookDue`, `isNewer`, `UpdateWatch` with its effects passed in), so
 * tests/update-auto.test.ts covers them without a network.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Starting Beluga looks unless it looked less than this ago (another window, a restart). */
export const LAUNCH_AFTER_MS = HOUR;
/** While Beluga runs, it looks every few hours. */
export const LOOK_EVERY_MS = 4 * HOUR;
/** After a failed look (offline, npm down), wait this long before trying again. */
export const RETRY_AFTER_MS = HOUR;
/** How often the watch wakes up (cheap: nothing goes out unless a look is due). */
export const TICK_MS = 10 * MINUTE;
/** Let Beluga start before the first look. */
export const FIRST_LOOK_MS = 20_000;

export type Occasion = 'launch' | 'running';

/** Whether to look for a new version now (times in ms since the epoch). Mirrors update_rules.rs. */
export function lookDue(now: number, lastOk: number | undefined, lastTry: number | undefined, occasion: Occasion): boolean {
  if (lastTry !== undefined && lastTry <= now && now - lastTry < RETRY_AFTER_MS) return false;
  if (lastOk === undefined) return true;
  // The clock went backwards (or was wrong before): don't wait for it to catch up.
  if (lastOk > now) return true;
  return now - lastOk >= (occasion === 'launch' ? LAUNCH_AFTER_MS : LOOK_EVERY_MS);
}

/** Beluga's own version, without build details (0.4.0+mac.0.5.1 → 0.4.0). */
export const baseVersion = (v: string): string => v.trim().replace(/^v/, '').split('+')[0] ?? '';

const VERSION = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/** Is `latest` a newer Beluga than `current`? Anything that isn't a version never is. */
export function isNewer(latest: string, current: string): boolean {
  const a = baseVersion(latest);
  const b = baseVersion(current);
  return VERSION.test(a) && VERSION.test(b) && compareVersions(a, b) > 0;
}

/** What a look found: a newer release on npm, or new commits for a git checkout. */
export type Found = { readonly kind: 'npm'; readonly version: string } | { readonly kind: 'git'; readonly count: number };

/** What's kept between runs (~/.beluga/update-check.json). */
export interface Saved {
  readonly lastCheck?: number;
  /** The newest version npm had then. */
  readonly latest?: string;
}

export interface WatchDeps {
  /** The version running now. */
  readonly current: string;
  /** Look for a newer Beluga (undefined: this is the latest). Throws when it can't tell. */
  readonly look: () => Promise<Found | undefined>;
  /** Install this version from npm; true when it worked. */
  readonly install: (version: string) => Promise<boolean>;
  /** "Update automatically" is on. */
  readonly auto: () => boolean;
  /** Nothing would be interrupted by a restart (no screens, no Claude working, nobody in the room). */
  readonly idle: () => boolean;
  /** Restart into the installed version; missing when this Beluga can't (it runs in your terminal). */
  readonly restart?: (version: string) => void;
  readonly tell: (text: string, level: 'info' | 'success' | 'warn') => void;
  readonly load: () => Saved;
  readonly save: (saved: Saved) => void;
  readonly now?: () => number;
}

export class UpdateWatch {
  private lastTry: number | undefined;
  private busy = false;
  /** Installed and waiting for a restart. */
  private installed: string | undefined;
  /** Said once per run: what was found (a version, or a count of commits). */
  private told = new Set<string>();
  private failed = new Set<string>();
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly deps: WatchDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Look soon after launch, then wake up every TICK_MS. */
  start(firstMs = FIRST_LOOK_MS, everyMs = TICK_MS): () => void {
    const first = setTimeout(() => {
      void this.tick('launch');
      const every = setInterval(() => void this.tick('running'), everyMs);
      every.unref?.();
      this.timers.push(every);
    }, firstMs);
    first.unref?.();
    this.timers.push(first);
    return () => this.stop();
  }

  stop(): void {
    for (const t of this.timers.splice(0)) clearTimeout(t);
  }

  /** The version installed and waiting for a restart, if any. */
  get waiting(): string | undefined {
    return this.installed;
  }

  async tick(occasion: Occasion): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.installed) return this.restartIfIdle();
      const saved = this.deps.load();
      // What an earlier run (or another window) found counts without asking npm again.
      const known: Found | undefined = saved.latest && isNewer(saved.latest, this.deps.current) ? { kind: 'npm', version: saved.latest } : undefined;
      let found: Found | undefined;
      if (lookDue(this.now(), saved.lastCheck, this.lastTry, occasion)) {
        this.lastTry = this.now();
        try {
          found = await this.deps.look();
          this.deps.save({ lastCheck: this.now(), ...(found?.kind === 'npm' ? { latest: found.version } : {}) });
        } catch {
          // Offline or npm is down: try again after RETRY_AFTER_MS, quietly.
          found = known;
        }
      } else if (occasion === 'launch') {
        found = known;
      }
      if (!found) return;
      if (found.kind === 'git') return this.say(`git:${found.count}`, `Beluga has ${found.count} new change${found.count === 1 ? '' : 's'} on GitHub. Run beluga update to get them`, 'info');
      if (!this.deps.auto() || this.failed.has(found.version)) return this.offer(found.version);
      await this.installNow(found.version);
    } finally {
      this.busy = false;
    }
  }

  private offer(version: string): void {
    this.say(version, `Beluga ${version} is available (you have ${baseVersion(this.deps.current)}). Run beluga update, or turn on Update automatically in Settings`, 'info');
  }

  private say(key: string, text: string, level: 'info' | 'success' | 'warn'): void {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.deps.tell(text, level);
  }

  private async installNow(version: string): Promise<void> {
    const ok = await this.deps.install(version).catch(() => false);
    if (!ok) {
      this.failed.add(version);
      this.say(`failed:${version}`, `Beluga ${version} didn't install by itself. Run beluga update to install it`, 'warn');
      return;
    }
    this.installed = version;
    this.say(`installed:${version}`, this.deps.restart ? `Beluga ${version} is installed. It restarts into it once nothing is running` : `Beluga ${version} is installed. Quit and start Beluga again to use it`, 'success');
    this.restartIfIdle();
  }

  private restartIfIdle(): void {
    if (this.installed && this.deps.restart && this.deps.idle()) this.deps.restart(this.installed);
  }
}

/** Nothing a restart would cut short: no Claude working, nobody else in the room. */
export function quietNow(st: Pick<AppState, 'log' | 'peers' | 'self'>): boolean {
  const claude = st.log.some((l) => l.type === 'agent' && isRunning(l.status));
  const others = st.peers.some((p) => p.peerId !== st.self?.peerId);
  return !claude && !others;
}

// ---- the real effects

const savedPath = (home: string): string => path.join(home, 'update-check.json');

function loadSaved(home: string): Saved {
  try {
    const raw = JSON.parse(readFileSync(savedPath(home), 'utf8')) as Record<string, unknown>;
    return {
      ...(typeof raw.lastCheck === 'number' ? { lastCheck: raw.lastCheck } : {}),
      ...(typeof raw.latest === 'string' ? { latest: raw.latest } : {}),
    };
  } catch {
    return {};
  }
}

function writeSaved(home: string, saved: Saved): void {
  try {
    mkdirSync(home, { recursive: true });
    const tmp = `${savedPath(home)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
    renameSync(tmp, savedPath(home));
  } catch {
    // Best effort: the next run looks again.
  }
}

/** Look on npm (a global install) or GitHub (a git checkout); an install inside a project is left to it. */
export async function lookOnline(run: Run, root: string): Promise<Found | undefined> {
  if (await isGitCheckout(run, root)) {
    await fetchLatest(run);
    const d = decide(await readStatus(run));
    return d.kind === 'available' ? { kind: 'git', count: d.count } : undefined;
  }
  if (!(await isGlobalNpmInstall(run, root))) return undefined;
  const latest = await latestOnNpm(run);
  return isNewer(latest, installedVersion(root)) ? { kind: 'npm', version: latest } : undefined;
}

/** Whether this Beluga looks for updates itself: not the Mac app's (its updater does), not when turned off. */
export function watchesItself(version: string, env: { readonly check?: string }): boolean {
  return !version.includes('+mac') && env.check !== '0';
}

export interface StartOptions {
  readonly home: string;
  readonly version: string;
  readonly auto: () => boolean;
  readonly idle: () => boolean;
  readonly restart?: (version: string) => void;
  readonly tell: WatchDeps['tell'];
}

/** Start watching for updates with the real npm and git. Returns stop. */
export function startUpdateWatch(opts: StartOptions): () => void {
  const root = installRoot();
  const run = makeRun(root);
  const quiet = { write: () => undefined, tty: false };
  const watch = new UpdateWatch({
    current: opts.version,
    look: () => lookOnline(run, root),
    // `beluga update` itself (npm only here: a git checkout is never changed behind your back).
    install: async (version) => (await runUpdate({ root, run, out: quiet })) === 0 && !isNewer(version, installedVersion(root)),
    auto: opts.auto,
    idle: opts.idle,
    ...(opts.restart ? { restart: opts.restart } : {}),
    tell: opts.tell,
    load: () => loadSaved(opts.home),
    save: (saved) => writeSaved(opts.home, saved),
  });
  return watch.start();
}
