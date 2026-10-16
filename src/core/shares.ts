import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { type FsEntry, MAX_FILE_BYTES, type ShareInfo } from '../protocol.js';

export interface ShareConfig {
  readonly name: string;
  readonly root: string;
  readonly writable: boolean;
}

/** Credential stores: never served to peers and never readable by an agent without asking. */
const SECRET_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.gcloud']);
const SECRET_FILE = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)$/i,
  /^\.(npmrc|netrc|pypirc|git-credentials)$/i,
  /^credentials(\.json)?$/i,
];
/** Heavy or internal folders that are hidden from peers. */
const HIDDEN_SEGMENTS = new Set(['.git', 'node_modules']);

export class ShareError extends Error {}

const segmentsOf = (p: string): string[] => p.split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());

export function isSecretPath(p: string): boolean {
  const segments = segmentsOf(p);
  if (segments.some((s) => SECRET_SEGMENTS.has(s))) return true;
  const base = segments.at(-1) ?? '';
  return SECRET_FILE.some((re) => re.test(base));
}

export function isDenied(relPath: string): boolean {
  return isSecretPath(relPath) || segmentsOf(relPath).some((s) => HIDDEN_SEGMENTS.has(s));
}

/** Parse `name=path[:rw]` or `path[:rw]` share specs from the CLI. */
export function parseShareSpec(spec: string, cwd: string): ShareConfig {
  let rest = spec;
  let writable = false;
  if (rest.endsWith(':rw')) {
    writable = true;
    rest = rest.slice(0, -3);
  } else if (rest.endsWith(':ro')) {
    rest = rest.slice(0, -3);
  }
  const eq = rest.indexOf('=');
  const rawPath = eq >= 0 ? rest.slice(eq + 1) : rest;
  const root = path.resolve(cwd, rawPath || '.');
  const name = (eq >= 0 ? rest.slice(0, eq) : path.basename(root)).replace(/[^\w.-]/g, '_').slice(0, 64) || 'share';
  return { name, root, writable };
}

/**
 * Resolve a peer-supplied relative path inside a share root, rejecting
 * traversal (`..`), absolute paths, symlink escapes and denied files.
 */
export function resolveInShare(share: ShareConfig, relPath: string): string {
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.split('/').includes('..')) throw new ShareError('Path traversal is not allowed');
  if (isDenied(cleaned)) throw new ShareError('That file is private');
  const root = realRoot(share.root);
  const target = path.resolve(root, cleaned);
  if (target !== root && !target.startsWith(root + path.sep)) throw new ShareError('Path escapes the share');
  let real = target;
  try {
    real = realpathSync(target);
  } catch {
    return target; // does not exist yet; caller reports ENOENT
  }
  if (real !== root && !real.startsWith(root + path.sep)) throw new ShareError('Symlink escapes the share');
  return real;
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

export class ShareService {
  private watcher?: FSWatcher;

  constructor(private readonly shares: readonly ShareConfig[]) {}

  get infos(): ShareInfo[] {
    return this.shares.map((s) => ({ name: s.name, writable: s.writable }));
  }

  get configs(): readonly ShareConfig[] {
    return this.shares;
  }

  find(name: string): ShareConfig {
    const share = this.shares.find((s) => s.name === name);
    if (!share) throw new ShareError(`No share named "${name}"`);
    return share;
  }

  /** Map an absolute path back to (share, relative path) if it lives in a share. */
  locate(absPath: string): { share: string; path: string } | undefined {
    for (const share of this.shares) {
      const root = realRoot(share.root);
      const abs = path.resolve(absPath);
      if (abs === root || abs.startsWith(root + path.sep)) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (!isDenied(rel)) return { share: share.name, path: rel };
      }
    }
    return undefined;
  }

  async list(shareName: string, relPath: string): Promise<FsEntry[]> {
    const share = this.find(shareName);
    const dir = resolveInShare(share, relPath);
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const base = relPath.replace(/^\/+|\/+$/g, '');
    const rel = (name: string): string => (base ? `${base}/${name}` : name);
    const visible = dirents.filter((d) => !isDenied(rel(d.name)));
    const entries = await Promise.all(
      visible.map(async (d): Promise<FsEntry | undefined> => {
        let target = path.join(dir, d.name);
        if (d.isSymbolicLink()) {
          try {
            target = resolveInShare(share, rel(d.name)); // hides links pointing outside the share
          } catch {
            return undefined;
          }
        }
        const stat = await fs.stat(target).catch(() => undefined);
        if (!stat) return undefined;
        return { name: d.name, dir: stat.isDirectory(), size: stat.isDirectory() ? 0 : stat.size };
      }),
    );
    return entries
      .filter((e): e is FsEntry => e !== undefined)
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)).slice(0, 5000);
  }

  async read(shareName: string, relPath: string): Promise<{ content: string; truncated: boolean }> {
    const share = this.find(shareName);
    const file = resolveInShare(share, relPath);
    const stat = await fs.stat(file);
    if (stat.isDirectory()) throw new ShareError('That is a directory');
    const handle = await fs.open(file, 'r');
    try {
      const length = Math.min(stat.size, MAX_FILE_BYTES);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, 0);
      if (buf.includes(0)) return { content: '[binary file]', truncated: false };
      return { content: buf.toString('utf8'), truncated: stat.size > MAX_FILE_BYTES };
    } finally {
      await handle.close();
    }
  }

  /** Watch all shares and report changed files as (share, relative path). */
  watch(onChange: (share: string, relPath: string) => void): void {
    if (this.shares.length === 0) return;
    this.watcher = watch(
      this.shares.map((s) => s.root),
      {
        ignoreInitial: true,
        ignored: (p: string) => /[\\/](node_modules|\.git)([\\/]|$)/.test(p),
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
      },
    );
    const report = (abs: string): void => {
      const hit = this.locate(abs);
      if (hit) onChange(hit.share, hit.path);
    };
    this.watcher.on('add', report).on('change', report).on('unlink', report);
  }

  async close(): Promise<void> {
    await this.watcher?.close();
  }
}
