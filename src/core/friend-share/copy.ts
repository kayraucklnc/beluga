import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_DOWNLOAD_BYTES } from '../../protocol.js';
import { git } from '../../workspaces/git.js';
import { normalizeRemote } from '../../workspaces/manager.js';

/**
 * A friend's own copy of a project you share with them whole (BLG-258). They clone the repository
 * straight from where it lives when they can read it (a public one, or one they have access to);
 * otherwise your Mac packs every branch into a git bundle and sends it over your link, and they
 * clone from that. Either way it lands in ~/Beluga/<you>/<project> and joins their Projects.
 */

/** How long a clone may take before it's given up (a big repository over a slow line). */
const CLONE_MS = 15 * 60_000;
const BUNDLE_MS = 10 * 60_000;
/** A bundle waits this long for the friend to fetch it. */
export const COPY_TTL_MS = 60 * 60_000;

/**
 * The https address to clone a remote from, without any user or token in it, or undefined when it
 * isn't one a friend could clone (a local path, an odd scheme).
 */
export function cloneUrl(remote: string | undefined): string | undefined {
  if (!remote || /^(?:file:|\/|\.|~)/i.test(remote.trim())) return undefined;
  const hostPath = normalizeRemote(remote);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}(?:\/[\w.~-]+){2,}$/i.test(hostPath)) return undefined;
  return `https://${hostPath}`;
}

const safeName = (s: string): string => s.replace(/[/\\:\0]/g, '-').replace(/^\.+/, '').trim().slice(0, 80) || 'project';

/** Where copies go: ~/Beluga. */
export const copiesHome = (): string => path.join(os.homedir(), 'Beluga');

/** A fresh folder for the copy: ~/Beluga/<owner>/<project>, or "<project> 2" if that's taken. */
export function copyTarget(ownerName: string, project: string, home = copiesHome()): string {
  const base = path.join(home, safeName(ownerName), safeName(project));
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? base : `${base} ${i}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/** Clone `url` into `dest` without asking for a password (git.ts): rejects when they can't read it. */
export async function cloneFrom(url: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await git(path.dirname(dest), ['clone', '--quiet', '--', url, dest], CLONE_MS);
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true });
    throw err;
  }
}

/** Every branch and tag of the project at `root`, in one bundle file under `dir`. */
export async function packProject(root: string, dir: string): Promise<{ file: string; size: number }> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'project.bundle');
  await git(root, ['bundle', 'create', file, 'HEAD', '--branches', '--tags'], BUNDLE_MS);
  const size = (await fs.stat(file)).size;
  if (size > MAX_DOWNLOAD_BYTES) {
    await fs.rm(dir, { recursive: true, force: true });
    throw new Error('the project is too large to send this way');
  }
  return { file, size };
}

/**
 * Clone `dest` from a bundle's bytes, with every branch it carries made local, then point origin
 * at the real repository (when there is one) so pulling later goes there, not to a deleted file.
 */
export async function cloneFromBundle(bytes: Buffer, dest: string, url: string | undefined): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beluga-copy-'));
  const bundle = path.join(tmpDir, 'project.bundle');
  try {
    await fs.writeFile(bundle, bytes, { mode: 0o600 });
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await git(path.dirname(dest), ['clone', '--quiet', '--', bundle, dest], CLONE_MS);
    const heads = await git(dest, ['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin']).catch(() => '');
    const current = (await git(dest, ['branch', '--show-current']).catch(() => '')).trim();
    for (const b of heads.split('\n').map((s) => s.trim())) {
      if (b && b !== 'HEAD' && b !== current) await git(dest, ['branch', '--no-track', '--', b, `origin/${b}`]).catch(() => undefined);
    }
    if (url) await git(dest, ['remote', 'set-url', 'origin', url]);
    else await git(dest, ['remote', 'remove', 'origin']);
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true });
    throw err;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
