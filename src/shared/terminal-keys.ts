// The names of terminal programs klaud runs (a workspace's shell, setup and run; the global shells).

export const shellId = (wsId: string): string => wsId;
export const setupId = (wsId: string): string => `${wsId}:setup`;
export const runId = (wsId: string): string => `${wsId}:run`;
/** Shells of the global Terminal tab (not tied to a workspace): `shell:1`, `shell:2`… */
export const globalShellId = (n: number): string => `shell:${n}`;
export const isGlobalShell = (key: string): boolean => /^shell:\d+$/.test(key);
export const globalShellNumber = (key: string): number => Number(key.slice('shell:'.length)) || 0;

/**
 * Where a new global shell starts: the project you last opened a workspace in, else the
 * project klaud was started in, else your home folder.
 */
export function globalShellDir(projects: readonly { root: string; workspaces: readonly { id: string }[] }[], openTabs: readonly string[], launchDir: string, home: string): string {
  for (const id of [...openTabs].reverse()) {
    const p = projects.find((x) => x.root && x.workspaces.some((w) => w.id === id));
    if (p) return p.root;
  }
  const sep = launchDir.includes('\\') ? '\\' : '/';
  const launched = projects.find((p) => p.root && (launchDir === p.root || launchDir.startsWith(p.root + sep)));
  return launched?.root ?? home;
}

/** Longest name you can give a terminal. */
export const MAX_TERMINAL_NAME = 40;

/** A name typed for a terminal, tidied: one line, no control characters, not too long ('' resets it). */
// eslint-disable-next-line no-control-regex
export const cleanTerminalName = (name: string): string => name.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TERMINAL_NAME);

/** What a terminal's tab says: the name you gave it, else Shell N, Shell, Setup or Run. */
export function terminalLabel(key: string, names: Readonly<Record<string, string>> = {}): string {
  const named = names[key];
  if (named) return named;
  if (isGlobalShell(key)) return `Shell ${globalShellNumber(key)}`;
  return key.endsWith(':setup') ? 'Setup' : key.endsWith(':run') ? 'Run' : 'Shell';
}
