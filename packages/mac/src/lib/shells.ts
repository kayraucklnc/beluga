import { globalShellDir, globalShellId, globalShellNumber, isGlobalShell } from '@klaud/shared/terminal-keys.js';
import { useApi, useApp, useKlaud, useUi } from './klaud.js';

/** Picked after the last shell is closed: show "no shells" instead of starting a new one. */
const NONE = 'shell:none';

// Shells this window has seen running. One that's gone was closed (here or on another screen),
// so picking it again must not start it back up.
const seen = new Set<string>();

export interface GlobalShells {
  /** The shell shown, or undefined when they're all closed. */
  readonly key: string | undefined;
  readonly tabs: ReadonlyArray<{ key: string; label: string; running: boolean }>;
  /** Where new shells start. */
  readonly dir: string;
  readonly pick: (key: string) => void;
  readonly open: () => void;
  readonly close: (key: string) => void;
}

/** Your own shells (the Terminal tab and the dock show the same ones). */
export function useGlobalShells(): GlobalShells {
  const api = useApi();
  const { ui } = useKlaud();
  const terminals = useApp((st) => st.terminals);
  const termExits = useApp((st) => st.termExits);
  const projects = useApp((st) => st.projects);
  const openTabs = useApp((st) => st.tabs);
  const home = useApp((st) => st.home);
  const picked = useUi((u) => u.termKey);
  const dir = globalShellDir(projects, openTabs, home, home);
  const globals = Object.keys(terminals).filter(isGlobalShell).sort((a, b) => globalShellNumber(a) - globalShellNumber(b));
  for (const k of globals) seen.add(k);
  const pickable = (k: string | undefined): k is string => !!k && isGlobalShell(k) && (k in terminals || !seen.has(k));
  // With none open, the first one starts by itself, unless you (or another screen) closed them all.
  const key = pickable(picked) ? picked : (globals[0] ?? (picked === NONE || seen.size ? undefined : globalShellId(1)));
  const shown = key && !globals.includes(key) ? [...globals, key] : globals;
  const tabs = shown.map((k) => ({ key: k, label: `Shell ${globalShellNumber(k)}`, running: k in terminals && !(k in termExits) }));
  return {
    key,
    tabs,
    dir,
    pick: (k) => ui.patch({ termKey: k }),
    open: () => {
      // Numbered after the open ones, like the terminal app does; it starts once it's shown.
      const k = globalShellId(Math.max(0, ...globals.map(globalShellNumber)) + 1);
      seen.delete(k);
      ui.patch({ termKey: k });
    },
    close: (k) => {
      // Show the shell beside it (or nothing, after the last one), then close it.
      const at = shown.indexOf(k);
      const rest = shown.filter((x) => x !== k);
      if (k === key) ui.patch({ termKey: rest[Math.min(at, rest.length - 1)] ?? NONE });
      seen.add(k);
      void api.terminals.close(k);
    },
  };
}
