import { useEffect, useState, type MutableRefObject } from 'react';
import type { Session } from '../core/session.js';
import type { AppState } from '../core/store.js';
import { runId, setupId, shellId } from '../core/workbench.js';
import { isLeaveChord, type TerminalSession } from '../terminal/index.js';
import { terminalSize } from './components/TerminalView.js';
import type { UiState } from './keymap.js';
import type { Geometry } from './layout.js';
import { type TerminalTabInfo, terminalBarModel } from './work-models.js';
import type { Model } from './workspace-models.js';
import { splitPaste } from './mouse.js';

export interface TerminalPaneInput {
  readonly session: Session;
  readonly state: AppState;
  readonly ui: UiState;
  readonly uiRef: MutableRefObject<UiState>;
  readonly patchUi: (patch: Partial<UiState>) => void;
  readonly focus: UiState['focus'];
  readonly geometry: Geometry;
  /** Hand the keyboard straight to the terminal (raw bytes), or give it back with undefined. */
  readonly setRawInput?: (sink: ((data: string) => void) | undefined) => void;
}

export interface TerminalPane {
  readonly termWs?: string;
  readonly termKey?: string;
  readonly termPane: { cols: number; rows: number };
  readonly termSession?: TerminalSession;
  readonly termFocused: boolean;
  readonly termBar?: Model;
}

/**
 * The Terminal tab: which session shows (shell, setup or run), starting the shell, keeping it
 * sized to the pane, redrawing on output, and giving it the raw keyboard while it's focused.
 */
export function useTerminalPane({ session, state, ui, uiRef, patchUi, focus, geometry: g, setRawInput }: TerminalPaneInput): TerminalPane {
  const d = { focus };
  const bench = session.workbench;
  const termWs = state.view.kind === 'workspace' && state.view.tab === 'terminal' ? state.view.id : undefined;
  const termKeys = termWs ? [shellId(termWs), setupId(termWs), runId(termWs)] : [];
  const termKey = termWs ? (ui.termKey && termKeys.includes(ui.termKey) && bench?.terminals?.get(ui.termKey) ? ui.termKey : shellId(termWs)) : undefined;
  const termPane = terminalSize(g.mainWidth, g.paneHeight);
  const termSession: TerminalSession | undefined = termKey ? bench?.terminals?.get(termKey) : undefined;
  const [, setTermTick] = useState(0);
  // The shell starts the first time you open the Terminal tab (or after it exited and you come back).
  const termRunning = termSession?.running ?? false;
  useEffect(() => {
    if (!termWs || termKey !== shellId(termWs) || termSession) return;
    if (bench?.shell(termWs, termPane)) setTermTick((n) => n + 1);
  }, [termWs, termKey, termSession]);
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
      termSession.write(data);
      return true;
    };
    setRawInput((data) => {
      if (uiRef.current.terminalScroll) patchUi({ terminalScroll: 0 });
      // Pastes arrive bracketed (klaud asks for it); hand them on bracketed only if the program wants that.
      const split = splitPaste(data, inPaste);
      inPaste = split.inPaste;
      for (const part of split.parts) {
        if (part.paste) termSession.paste(part.text);
        else if (!typed(part.text)) return;
      }
    });
    return () => setRawInput(undefined);
  }, [termFocused, termSession, setRawInput]);
  const termTabs: TerminalTabInfo[] = termWs
    ? termKeys
        .map((key) => ({ key, s: bench?.terminals?.get(key) }))
        .filter((t) => t.s || t.key === shellId(termWs))
        .map(({ key, s }) => ({ key, label: key === shellId(termWs) ? 'Shell' : key.endsWith(':setup') ? 'Setup' : 'Run', running: s?.running ?? false, ...(s?.exited ? { exitCode: s.exited.code } : {}) }))
    : [];
  const termProject = termWs ? state.projects.find((p) => p.workspaces.some((w) => w.id === termWs)) : undefined;
  const termBar = termWs && termKey ? terminalBarModel(termWs, termTabs, termKey, Math.max(1, g.mainWidth - 2), { hasRun: Boolean(termProject?.scripts?.run), hasSetup: Boolean(termProject?.scripts?.setup), focused: termFocused }) : undefined;


  return { termWs, termKey, termPane, termSession, termFocused, termBar };
}
