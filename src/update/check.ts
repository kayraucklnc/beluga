import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Runs a command in the install folder and resolves with its stdout. */
export type Run = (cmd: string, args: readonly string[]) => Promise<string>;

export interface Commit {
  readonly sha: string;
  readonly subject: string;
}

export interface Status {
  readonly branch: string;
  readonly upstream: string;
  readonly head: string;
  readonly behind: number;
  readonly ahead: number;
  readonly dirty: boolean;
  readonly incoming: readonly Commit[];
  /** package.json / package-lock.json change in the incoming commits, so npm install is needed. */
  readonly depsChanged: boolean;
}

export type Decision =
  | { readonly kind: 'latest' }
  | { readonly kind: 'available'; readonly count: number }
  | { readonly kind: 'blocked'; readonly reason: string };

/** The folder klaud runs from (dist/update/check.js → repo root). */
export function installRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** The installed version, from package.json. */
export function installedVersion(root = installRoot()): string {
  try {
    return (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function makeRun(cwd: string): Run {
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      // npm is npm.cmd on Windows, which only runs through a shell (arguments here are fixed strings).
      execFile(cmd, [...args], { cwd, shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || stdout || err.message).trim().split('\n').slice(-3).join('\n')));
        else resolve(stdout);
      });
    });
}

const canonical = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * True only when `root` is itself the top of a git checkout. A klaud installed inside
 * someone's project (node_modules) sits *inside* their repo; updating that would
 * pull and install into their project, so it must not count.
 */
export async function isGitCheckout(run: Run, root: string): Promise<boolean> {
  try {
    return canonical((await run('git', ['rev-parse', '--show-toplevel'])).trim()) === canonical(root);
  } catch {
    return false;
  }
}

/** Is `root` the global npm install of klaud (npm install -g klaud)? */
export async function isGlobalNpmInstall(run: Run, root: string): Promise<boolean> {
  try {
    return canonical(path.join((await run('npm', ['root', '-g'])).trim(), 'klaud')) === canonical(root);
  } catch {
    return false;
  }
}

/** The newest klaud on npm. */
export async function latestOnNpm(run: Run): Promise<string> {
  return (await run('npm', ['view', 'klaud', 'version'])).trim();
}

/** -1, 0 or 1, comparing "1.2.3" versions (pre-release tags sort before the release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = '', pre = ''] = v.split('-');
    return { nums: main.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export async function fetchLatest(run: Run): Promise<void> {
  await run('git', ['fetch', '--quiet', 'origin']);
}

async function upstreamOf(run: Run): Promise<string> {
  try {
    return (await run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  } catch {
    return 'origin/main';
  }
}

export function parseCommits(log: string): Commit[] {
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(' ');
      return i < 0 ? { sha: line, subject: '' } : { sha: line.slice(0, i), subject: line.slice(i + 1) };
    });
}

export async function readStatus(run: Run): Promise<Status> {
  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const upstream = await upstreamOf(run);
  const head = (await run('git', ['rev-parse', '--short', 'HEAD'])).trim();
  const [behindRaw, aheadRaw] = (await run('git', ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).trim().split(/\s+/);
  const behind = Number(behindRaw) || 0;
  const ahead = Number(aheadRaw) || 0;
  const dirty = (await run('git', ['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
  const incoming = behind ? parseCommits(await run('git', ['log', '--format=%h %s', `HEAD..${upstream}`])) : [];
  const changed = behind ? (await run('git', ['diff', '--name-only', `HEAD...${upstream}`])).split('\n') : [];
  const depsChanged = changed.some((f) => f === 'package.json' || f === 'package-lock.json');
  return { branch, upstream, head, behind, ahead, dirty, incoming, depsChanged };
}

/** What `klaud update` can do from here. */
export function decide(s: Status): Decision {
  if (s.behind === 0) return { kind: 'latest' };
  if (s.dirty) return { kind: 'blocked', reason: 'You have local edits in the klaud folder. Commit or discard them, then run klaud update again.' };
  if (s.ahead > 0) return { kind: 'blocked', reason: `Your copy has ${s.ahead} commit(s) that aren't on ${s.upstream}. Pull or rebase by hand, then run klaud update again.` };
  return { kind: 'available', count: s.behind };
}
