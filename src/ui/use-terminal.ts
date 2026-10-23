import os from 'node:os';
import { useEffect, useMemo, useState, type MutableRefObject } from 'react';
import type { BelugaClient } from '../ipc/client.js';
import type { AppState } from '../core/store.js';
import { globalShellDir, globalShellId, globalShellNumber, isGlobalShell, runId, setupId, shellId } from '../core/workbench.js';
import { terminalLabel } from '../shared/terminal-keys.js';
import { isLeaveChord, type TerminalEmulator } from '../terminal/index.js';
import { TerminalScreens } from './terminal-screens.js';
import { terminalSize } from './components/TerminalView.js';
import { type UiState, rawTabStep } from './keymap.js';
import type { Geometry } from './layout.js';
import { type TerminalTabInfo, globalTerminalBarModel, terminalBarModel } from './work-models.js';
import type { Model } from './workspace-models.js';
import { splitPaste } from './mouse.js';

export interface TerminalPaneInput {
  readonly client: BelugaClient;
  readonly state: AppState;
  readonly ui: UiState;
  readonly uiRef: MutableRefObject<UiState>;
  readonly patchUi: (patch: Partial<UiState>) => void;
  readonly focus: UiState['focus'];
  readonly geometry: Geometry;
  /** Hand the keyboard straight to the terminal (raw bytes), or give it back with undefined. */
  readonly setRawInput?: (sink: ((data: string) => void) | undefined) => void;
  /** Ctrl+Tab / Ctrl+Shift+Tab pressed in the terminal: switch top tabs. */
  readonly onTabStep?: (delta: 1 | -1) => void;
}

export interface TerminalPane {
  readonly termWs?: string;
  readonly termKey?: string;
  readonly termPane: { cols: number; rows: number };
  readonly termSession?: TerminalEmulator;
  readonly termFocused: boolean;
  readonly termBar?: Model;
  /** Where a new global shell starts ('' outside the global Terminal tab). */
  readonly termDir: string;
}

/**
 * The Terminal tabs (a workspace's, and the global one): which session shows (a shell, setup
 * or run), starting the shell, keeping it sized to the pane, redrawing on output, and giving
 * it the raw keyboard while it's focused.
 */
export function useTerminalPane({ client, state, ui, uiRef, patchUi, focus, geometry: g, setRawInput, onTabStep }: TerminalPaneInput): TerminalPane {
  const d = { focus };
  const screens = useMemo(() => new TerminalScreens(client), [client]);
  useEffect(() => () => screens.dispose(), [screens]);
  const { terminals, termExits } = state;
  const isRunning = (key: string): boolean => key in terminals && !(key in termExits);
  const termWs = state.view.kind === 'workspace' && state.view.tab === 'terminal' ? state.view.id : undefined;
  const global = state.view.kind === 'terminal';
  const termKeys = termWs ? [shellId(termWs), setupId(termWs), runId(termWs)] : [];
  const globals = global ? Object.keys(terminals).filter(isGlobalShell).sort((a, b) => globalShellNumber(a) - globalShellNumber(b)) : [];
  // The global tab shows the shell you picked (or a new one you asked for with +), else the first.
  const termKey = termWs
    ? ui.termKey && termKeys.includes(ui.termKey) && ui.termKey in terminals ? ui.termKey : shellId(termWs)
    : global
      ? ui.termKey && isGlobalShell(ui.termKey) ? ui.termKey : (globals[0] ?? globalShellId(1))
      : undefined;
  const globalDir = global ? globalShellDir(state.projects, state.tabs, client.launchDir, os.homedir()) : '';
  const termPane = terminalSize(g.mainWidth, g.paneHeight);
  screens.prune(state);
  const termSession: TerminalEmulator | undefined = termKey ? screens.get(termKey, termPane, state) : undefined;
  const [, setTermTick] = useState(0);
  // The shell starts the first time you open the Terminal tab (or after it exited and you come back).
  const termRunning = termKey ? isRunning(termKey) : false;
  const known = termKey ? termKey in terminals : false;
  useEffect(() => {
    if (known || !termKey) return;
    if (termWs && termKey === shellId(termWs)) void client.api.terminals.shell(termWs, termPane);
    if (global) void client.api.terminals.global(termKey, globalDir, termPane);
  }, [termWs, global, termKey, known]);
  // A shell that exited gives the keyboard back; clicking the terminal starts a new one.
  useEffect(() => {
    if (!termRunning && uiRef.current.focus === 'terminal' && termSession) patchUi({ focus: 'chat' });
  }, [termRunning, termSession]);
  useEffect(() => {
    if (!termSession) return;
    return termSession.onChange(() => setTermTick((n) => n + 1));
  }, [termSession]);
  useEffect(() => {
    termSession?.resize(termPane.cols, termPane.rows);
  }, [termSession, termPane.cols, termPane.rows]);
  // While the terminal is focused, every key goes to it (Ctrl+] gives the keyboard back).
  const termFocused = d.focus === 'terminal' && Boolean(termSession?.running);
  useEffect(() => {
    if (!setRawInput) return;
    if (!termFocused || !termSession) {
      setRawInput(undefined);
      return;
    }
    let inPaste = false;
    const typed = (data: string): boolean => {
      // Ctrl+] gives the keyboard back, even inside a burst of typed keys.
      const leave = data.indexOf('\x1d');
      if (isLeaveChord(data) || leave >= 0) {
        if (leave > 0) termSession.write(data.slice(0, leave));
        patchUi({ focus: 'chat' });
        return false;
      }
      const step = rawTabStep(data);
      if (step && onTabStep) {
        onTabStep(step);
        return false;
      }
      termSession.write(data);
      return true;
    };
    setRawInput((data) => {
      if (uiRef.current.terminalScroll) patchUi({ terminalScroll: 0 });
      // Pastes arrive bracketed (Beluga asks for it); hand them on bracketed only if the program wants that.
      const split = splitPaste(data, inPaste);
      inPaste = split.inPaste;
      for (const part of split.parts) {
        if (part.paste) termSession.paste(part.text);
        else if (!typed(part.text)) return;
      }
    });
    return () => setRawInput(undefined);
  }, [termFocused, termSession, setRawInput]);
  const exitOf = (key: string): { exitCode?: number | null } => (key in termExits ? { exitCode: termExits[key] ?? null } : {});
  const termTabs: TerminalTabInfo[] = termWs
    ? termKeys
        .filter((key) => key in terminals || key === shellId(termWs))
        .map((key) => ({ key, label: terminalLabel(key, state.termNames), running: isRunning(key), ...exitOf(key) }))
    : [];
  const termProject = termWs ? state.projects.find((p) => p.workspaces.some((w) => w.id === termWs)) : undefined;
  const globalKeys = global ? [...new Set([...globals, ...(termKey ? [termKey] : [])])] : [];
  // Shell 1, Shell 2… (just "Shell" when it's the only one), or the name you gave it.
  const globalTabs: TerminalTabInfo[] = globalKeys.map((key, i) => ({ key, label: state.termNames[key] ?? (globalKeys.length > 1 ? `Shell ${i + 1}` : 'Shell'), running: isRunning(key), ...exitOf(key) }));
  const home = os.homedir();
  const shownDir = globalDir.startsWith(home) ? `~${globalDir.slice(home.length)}` : globalDir;
  const termBar = global && termKey
    ? globalTerminalBarModel(globalTabs, termKey, Math.max(1, g.mainWidth - 2), { focused: termFocused, dir: shownDir })
    : termWs && termKey ? terminalBarModel(termWs, termTabs, termKey, Math.max(1, g.mainWidth - 2), { hasRun: Boolean(termProject?.scripts?.run), hasSetup: Boolean(termProject?.scripts?.setup), focused: termFocused }) : undefined;


  return { termWs, termKey, termDir: globalDir, termPane, termSession, termFocused, termBar };
}
