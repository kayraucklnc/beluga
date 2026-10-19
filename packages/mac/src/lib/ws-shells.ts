import { useSyncExternalStore } from 'react';
import { globalShellId, globalShellNumber, isGlobalShell } from '@klaud/shared/terminal-keys.js';

/**
 * More shells in a workspace: + in its terminal starts one of your own shells (shell:N) in the
 * workspace's folder and keeps it with that workspace's tabs. Which shells belong where is kept
 * on this Mac (they're your shells: the Terminal view lists them too).
 */

const KEY = 'klaud.wsShells.v1';
type Owners = Readonly<Record<string, string>>;

function load(): Owners {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => isGlobalShell(e[0]) && typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

let owners: Owners = load();
const listeners = new Set<() => void>();
/** Shells claimed but not started yet (they start once their tab shows). */
const starting = new Set<string>();

function save(next: Owners): void {
  owners = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: kept until the window closes
  }
  for (const l of [...listeners]) l();
}

export function useShellOwners(): Owners {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => owners,
  );
}

/** The workspace's extra shells that are still open (or about to start), in the order they were made. */
export function extraShells(all: Owners, wsId: string, terminals: Readonly<Record<string, unknown>>, starting: string | undefined): string[] {
  return Object.keys(all)
    .filter((k) => all[k] === wsId && (k in terminals || k === starting))
    .sort((a, b) => globalShellNumber(a) - globalShellNumber(b));
}

/** A new shell for this workspace: numbered after every open shell. */
export function claimShell(wsId: string, terminals: Readonly<Record<string, unknown>>): string {
  // Shells closed elsewhere (another screen, the Terminal view) are forgotten here too.
  const live = Object.fromEntries(Object.entries(owners).filter(([k]) => k in terminals || starting.has(k)));
  const used = Object.keys(terminals).filter(isGlobalShell).map(globalShellNumber);
  const key = globalShellId(Math.max(0, ...used) + 1);
  starting.add(key);
  save({ ...live, [key]: wsId });
  return key;
}

/**
 * Forget the shells that are gone (closed here, in the Terminal view or on another screen), so a
 * new shell that gets the same number later isn't taken for this workspace's.
 */
export function pruneShells(terminals: Readonly<Record<string, unknown>>): void {
  for (const k of starting) if (k in terminals) starting.delete(k);
  const gone = Object.keys(owners).filter((k) => !(k in terminals) && !starting.has(k));
  if (gone.length) save(Object.fromEntries(Object.entries(owners).filter(([k]) => !gone.includes(k))));
}

/** Forget a shell that was closed. */
export function releaseShell(key: string): void {
  starting.delete(key);
  if (!(key in owners)) return;
  const { [key]: _gone, ...rest } = owners;
  save(rest);
}
