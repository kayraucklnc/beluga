import { existsSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let migrated = false;

/**
 * Where klaud keeps settings, projects and worktrees: ~/.klaud (or $KLAUD_HOME).
 * klaud used to be called klaude: an existing ~/.klaude is linked in place, so saved
 * settings, projects and worktree paths keep working untouched.
 */
export function klaudHome(): string {
  const fromEnv = process.env.KLAUD_HOME ?? process.env.KLAUDE_HOME;
  if (fromEnv) return fromEnv;
  const home = path.join(os.homedir(), '.klaud');
  if (!migrated) {
    migrated = true;
    const old = path.join(os.homedir(), '.klaude');
    try {
      if (!existsSync(home) && existsSync(old)) symlinkSync(old, home, 'dir');
    } catch {
      // Can't link (permissions?): start fresh in ~/.klaud.
    }
  }
  return home;
}
