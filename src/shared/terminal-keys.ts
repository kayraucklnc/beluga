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
