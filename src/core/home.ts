import { existsSync, lstatSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { belugaEnv } from './beluga-env.js';

/** The folders Beluga's home had before, newest first: klaud's, then klaude's. */
const LEGACY = ['.klaud', '.klaude'];

/** ~/.beluga, or where the old home stayed when it couldn't move (checked once per process). */
let settled: string | undefined;

const present = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Move an existing ~/.klaud (or ~/.klaude) to ~/.beluga, once, keeping a link at the old place so
 * saved projects, worktree paths and git's own worktree links keep working untouched. A real folder
 * right in `homeDir` is renamed; one that is a link elsewhere stays there, and ~/.beluga links to it.
 * Does nothing when ~/.beluga is already there (or nothing old is). Never loses the old path: when
 * the link back can't be made, the folder goes back where it was and that path is returned.
 */
export function migrateHome(homeDir: string): string {
  const home = path.join(homeDir, '.beluga');
  if (present(home)) return home;
  const old = LEGACY.map((name) => path.join(homeDir, name)).find((p) => existsSync(p));
  if (!old) return home;
  try {
    const real = realpathSync(old);
    if (path.dirname(real) !== realpathSync(homeDir)) {
      symlinkSync(real, home, 'dir');
      return home;
    }
    renameSync(real, home);
    try {
      symlinkSync(home, real, 'dir');
    } catch {
      renameSync(home, real);
      return old;
    }
    return home;
  } catch {
    // Someone else moved it at the same moment, or the folder can't be renamed: use what's there.
    return present(home) ? home : old;
  }
}

/**
 * Where Beluga keeps settings, projects and worktrees: ~/.beluga (or $BELUGA_HOME; $KLAUD_HOME and
 * $KLAUDE_HOME from before the rename still count). An older ~/.klaud moves there on first run.
 */
export function belugaHome(): string {
  const fromEnv = belugaEnv('HOME') ?? process.env.KLAUDE_HOME;
  if (fromEnv) return fromEnv;
  return (settled ??= migrateHome(os.homedir()));
}
