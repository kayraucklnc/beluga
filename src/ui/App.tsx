import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Box, useApp, useInput, useStdout } from 'ink';
import type { Session } from '../core/session.js';
import { type AppState, type Location, channelOf } from '../core/store.js';
import { THEMES } from '../core/settings.js';
import { shareNameOf } from '../core/workspace-controller.js';
import type { FsEntry } from '../protocol.js';
import { anyActivity } from './banner.js';
import { ApprovalCard } from './components/ApprovalCard.js';
import { ChatView, chatLines } from './components/ChatView.js';
import { Composer } from './components/Composer.js';
import { FilesPanel } from './components/FilesPanel.js';
import { TerminalView, terminalSize } from './components/TerminalView.js';
import { isLeaveChord, isLeaveKey, type TerminalSession } from '../terminal/index.js';
import { runId, setupId, shellId } from '../core/workbench.js';
import { terminalBarModel, type TerminalTabInfo } from './work-models.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { Menu } from './components/Menu.js';
import { ModelBlock } from './components/ModelBlock.js';
import { Panel } from './components/Panel.js';
import { Sidebar } from './components/Sidebar.js';
import { Viewer, viewerInner, viewerLegend, viewerLines } from './components/Viewer.js';
import { type Derived, derive } from './derive.js';
import { type Target, hitTest } from './hit.js';
import { type Effect, type UiState, handleKey, initialUi } from './keymap.js';
import { type MenuKind } from './menus.js';
import { type MenuContext, POLICY_INDEX, runMenu as runMenuOption } from './menu-actions.js';
import { answerByNumber, answerTyped, currentQuestion, runCollabUiAction } from './collab-actions.js';
import { MOUSE_OFF, MOUSE_ON, type MouseEvent } from './mouse.js';
import { openTarget, suggestionWindow } from './suggest.js';
import { applyTheme, theme } from './theme.js';
import { type UiAction, isCompacting, toggleProject } from './workspace-models.js';

const TOAST_MS = 3500;
const FRAME_MS = 100;
const WHEEL_LINES = 3;

/** What each bottom-bar button does, shown while hovering it. */
const BUTTON_HINTS: Record<string, string> = {
  ask: 'Mention a Claude: yours, a friend’s, or everyone’s',
  commands: 'See every command',
  projects: 'Jump to your projects and chats on the left',
  invite: 'Open a secure link for friends and copy it',
  settings: 'Name, theme, text size, mouse and sharing',
  help: 'Keys and commands',
  review: 'See exactly what changed in this workspace',
  actions: 'Use Review, Commit, Merge and more from the keyboard (← → then Enter)',
  overview: 'Every worktree and chat at a glance',
  chat: 'Back to typing',
  clear: 'Clear this conversation (you choose: just you, everyone, or a fresh start)',
  'share-folder': 'Share a folder with everyone, or just one person',
  terminal: "A real shell in this workspace's folder",
  templates: 'Start from a ready-made task, or save your own',
  'open-hit': 'Open the highlighted conversation',
  'refresh-usage': 'Measure disk space again',
};

export interface AppProps {
  readonly session: Session;
  /** Show the welcome screen asking who may use your Claude. */
  readonly onboarding?: boolean;
  /** Subscribe to mouse events (clicks and wheel). Omit to run keyboard-only. */
  readonly subscribeMouse?: (listener: (e: MouseEvent) => void) => () => void;
  /** Send keyboard input straight to a function (the built-in terminal) instead of Ink; undefined gives it back. */
  readonly setRawInput?: (sink: ((data: string) => void) | undefined) => void;
}

function useTerminalSize(): { columns: number; rows: number } {
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const read = () => ({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

/** Advance a frame counter while something is animating (spinners, timers). */
function useFrame(active: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(t);
  }, [active]);
  return frame;
}

/** Folders on this computer, for "/project add" completion (size 1 = git project). */
function listLocalDirs(dir: string): FsEntry[] {
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        let git = false;
        try {
          git = statSync(path.join(abs, d.name, '.git')).isDirectory();
        } catch {
          git = false;
        }
        return { name: d.name, dir: true, size: git ? 1 : 0 };
      })
      .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

const isWorking = (state: AppState): boolean => anyActivity(state) || isCompacting(state) || state.transfers.some((t) => t.status === 'active');

export function App({ session, onboarding = false, subscribeMouse, setRawInput }: AppProps) {
  const state = useSyncExternalStore(session.store.subscribe, session.store.getState);
  const [startUi] = useState<UiState>(() =>
    onboarding ? { ...initialUi, menu: { menu: { kind: 'welcome' }, selected: POLICY_INDEX[state.policy] } } : initialUi,
  );
  const [ui, setUiState] = useState(startUi);
  // Keystrokes can arrive faster than React commits; always build on the latest state.
  const uiRef = useRef<UiState>(startUi);
  const setUi = (next: UiState): void => {
    uiRef.current = next;
    setUiState(next);
  };
  const patchUi = (patch: Partial<UiState>): void => setUi({ ...uiRef.current, ...patch });
  const { exit } = useApp();
  const { write } = useStdout();
  const { columns, rows } = useTerminalSize();
  const frame = useFrame(isWorking(state));
  const ctl = session.workspaces;

  // Mouse position for hover feedback; only re-render when what's under the pointer changes.
  const [hover, setHover] = useState<{ x: number; y: number } | undefined>(undefined);
  const hoverKey = useRef('');
  const view = (s: AppState = state, u: UiState = ui): Derived => derive({ state: s, ui: u, selfId: session.selfId, columns, rows, frame, listLocalDirs, hover });
  const d = view();
  const g = d.geometry;

  useEffect(() => {
    const toast = state.toast;
    if (!toast) return;
    const t = setTimeout(() => session.store.dispatch({ type: 'toast_clear', id: toast.id }), TOAST_MS);
    return () => clearTimeout(t);
  }, [state.toast, session]);

  // /settings opens the settings menu; inviting for the first time asks who may use your Claude.
  useEffect(() => {
    if (state.overlay === 'clear') {
      session.store.dispatch({ type: 'overlay', overlay: undefined });
      patchUi({ menu: { menu: { kind: 'clear', channel: view().channel, host: session.isHost }, selected: 0 } });
      return;
    }
    const overlay = state.overlay;
    if (overlay === 'model' || overlay === 'inbox' || overlay === 'templates' || overlay === 'handoff') {
      session.store.dispatch({ type: 'overlay', overlay: undefined });
      const channel = view().channel;
      const wsId = state.view.kind === 'workspace' ? state.view.id : undefined;
      if (overlay === 'model') patchUi({ menu: { menu: { kind: 'model', ...(channel === 'room' || channel === 'draft' ? {} : { channel }) }, selected: 0 } });
      else if (overlay === 'inbox') patchUi({ menu: { menu: { kind: 'inbox' }, selected: 0 } });
      else if (overlay === 'templates') patchUi({ menu: { menu: { kind: 'templates' }, selected: 0 } });
      else if (wsId) patchUi({ menu: { menu: { kind: 'handoff', id: wsId }, selected: 0 } });
      return;
    }
    if (overlay !== 'settings' && overlay !== 'welcome') return;
    session.store.dispatch({ type: 'overlay', overlay: undefined });
    patchUi({ menu: { menu: { kind: overlay }, selected: overlay === 'welcome' ? POLICY_INDEX[state.policy] : 0 } });
  }, [state.overlay]);

  // Search as you type, when the Search tab is open.
  const searchQuery = state.view.kind === 'search' && !ui.buffer.startsWith('/') ? ui.buffer : undefined;
  useEffect(() => {
    if (searchQuery === undefined) return;
    const t = setTimeout(() => session.workbench?.search(searchQuery), 120);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // ---- the built-in terminal
  const bench = session.workbench;
  const termWs = state.view.kind === 'workspace' && state.view.tab === 'terminal' ? state.view.id : undefined;
  const termKeys = termWs ? [shellId(termWs), setupId(termWs), runId(termWs)] : [];
  const termKey = termWs ? (ui.termKey && termKeys.includes(ui.termKey) && bench?.terminals?.get(ui.termKey) ? ui.termKey : shellId(termWs)) : undefined;
  const termPane = terminalSize(g.mainWidth, g.paneHeight);
  const termSession: TerminalSession | undefined = termKey ? bench?.terminals?.get(termKey) : undefined;
  const [, setTermTick] = useState(0);
  // The shell starts the first time you open the Terminal tab (or after it exited and you come back).
  useEffect(() => {
    if (!termWs || termKey !== shellId(termWs) || (termSession && termSession.running)) return;
    if (bench?.shell(termWs, termPane)) setTermTick((n) => n + 1);
  }, [termWs, termKey, termSession]);
  useEffect(() => {
    if (!termSession) return;
    return termSession.onChange(() => setTermTick((n) => n + 1));
  }, [termSession]);
  useEffect(() => {
    termSession?.resize(termPane.cols, termPane.rows);
  }, [termSession, termPane.cols, termPane.rows]);
  // While the terminal is focused, every key goes to it (Ctrl+] gives the keyboard back).
  const termFocused = d.focus === 'terminal' && Boolean(termSession);
  useEffect(() => {
    if (!setRawInput) return;
    if (!termFocused || !termSession) {
      setRawInput(undefined);
      return;
    }
    setRawInput((data) => {
      if (isLeaveChord(data)) {
        patchUi({ focus: 'chat' });
        return;
      }
      if (uiRef.current.terminalScroll) patchUi({ terminalScroll: 0 });
      termSession.write(data);
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

  // Opening a file (yourself) moves you into the viewer so its controls are right there.
  const openedKey = state.viewer && !state.viewer.by ? `${state.viewer.owner}:${state.viewer.share}/${state.viewer.path}` : undefined;
  useEffect(() => {
    if (openedKey) patchUi({ focus: 'viewer' });
  }, [openedKey]);

  // A workspace's Files tab browses its folder.
  const filesFor = state.view.kind === 'workspace' && state.view.tab === 'files' ? state.view.id : undefined;
  useEffect(() => {
    if (filesFor) void session.browseTo({ owner: session.selfId, share: shareNameOf(filesFor), path: '' });
  }, [filesFor]);

  // Fetch folder contents as you type a path after /open or /get.
  useEffect(() => {
    const target = openTarget(ui.buffer, state.peers);
    if (target) void session.loadDir(target);
  }, [ui.buffer, state.peers, session]);

  const selectedFile = (): Location | undefined => {
    const latest = session.store.getState();
    if (uiRef.current.focus === 'viewer' && latest.viewer) return latest.viewer;
    const row = latest.browser.rows[latest.browser.cursor];
    return row && row.target !== 'up' && !row.dir ? row.target : undefined;
  };

  const scrollViewer = (delta: number): void => {
    const latest = session.store.getState();
    if (!latest.viewer) return;
    const dd = view(latest, uiRef.current);
    // Fullscreen draws the viewer across the whole body, so measure with those sizes.
    const full = uiRef.current.viewerFull && dd.focus === 'viewer';
    const w = full ? dd.geometry.columns : dd.geometry.viewerWidth;
    const h = full ? dd.geometry.bodyHeight : dd.geometry.paneHeight;
    const total = viewerLines(latest.viewer, w, uiRef.current.viewerRaw, h).length;
    session.store.dispatch({ type: 'viewer_scroll', delta, max: Math.max(0, total - viewerInner(h)) });
  };

  const typeInto = (buffer: string): void => patchUi({ focus: 'chat', buffer, cursor: buffer.length, suggestHidden: false, selected: 0 });

  const askForName = (kind: 'worktree' | 'chat' | 'group', projectId: string): void => {
    const project = session.store.getState().projects.find((p) => p.id === projectId);
    patchUi({ focus: 'chat', buffer: '', cursor: 0, pending: { kind, projectId } });
    const where = project?.root ? ` in ${project.name}` : '';
    session.toast(kind === 'group' ? `Type a name for the new group, then Enter` : `Type a name for the new ${kind}${where}, then Enter`);
  };

  const openFolder = (dir: string): void => {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [dir], { stdio: 'ignore', detached: true }).unref();
  };

  const toggle = (key: string): void => {
    const collapsed = uiRef.current.collapsed;
    patchUi({ collapsed: collapsed.includes(key) ? collapsed.filter((c) => c !== key) : [...collapsed, key] });
  };

  const runUiAction = (action: UiAction): void => {
    if (runCollabUiAction(menuCtx, action)) return;
    switch (action.type) {
      case 'open_ws':
        ctl?.open(action.id, action.tab);
        // Opening a view puts you inside it: the file list, the diff, the terminal, or the chat.
        patchUi(action.tab === 'review' ? { focus: 'main', entered: true } : action.tab === 'files' ? { focus: 'files', entered: true } : action.tab === 'terminal' ? { focus: 'terminal', terminalScroll: 0 } : { focus: 'chat', entered: false });
        return;
      case 'inbox':
        patchUi({ menu: { menu: { kind: 'inbox' }, selected: 0 } });
        return;
      case 'model_menu':
        patchUi({ menu: { menu: { kind: 'model', ...(action.channel === 'room' ? {} : { channel: action.channel }) }, selected: 0 } });
        return;
      case 'templates_menu':
        patchUi({ menu: { menu: { kind: 'templates', manage: true }, selected: 0 } });
        return;
      case 'template': {
        const t = session.store.getState().templates.find((x) => x.id === action.id);
        if (t) runMenu({ kind: 'templates' }, session.store.getState().templates.indexOf(t));
        return;
      }
      case 'trust':
        session.people.setTrust(action.peerId, action.level);
        return;
      case 'trust_later':
        session.people.dismissPrompt(action.peerId);
        return;
      case 'search_hit':
        session.store.dispatch({ type: 'search', search: { cursor: action.index } });
        bench?.openHit(action.index);
        patchUi({ focus: 'chat', buffer: '', cursor: 0 });
        return;
      case 'term_tab':
        patchUi({ termKey: action.key, terminalScroll: 0, focus: 'terminal' });
        return;
      case 'toggle_project': {
        const latest = session.store.getState();
        const project = latest.projects.find((p) => p.id === action.id);
        if (project) patchUi({ collapsed: toggleProject(latest, project, uiRef.current.collapsed) });
        return;
      }
      case 'toggle_group':
        toggle(`group:${action.name}`);
        return;
      case 'toggle_archive':
        toggle(`archive:${action.projectId}`);
        return;
      case 'toggle_fold':
        toggle(action.key);
        return;
      case 'agents_menu':
        patchUi({ menu: { menu: { kind: 'agents', projectId: action.projectId }, selected: 0 } });
        return;
      case 'project_menu':
        patchUi({ menu: { menu: { kind: 'project', id: action.id }, selected: 0 } });
        return;
      case 'archived_menu':
        patchUi({ menu: { menu: { kind: 'archived', id: action.id }, selected: 0 } });
        return;
      case 'none':
        return;
      case 'new_worktree': {
        // Like a new chat: describe the task, and a small model names the worktree from it.
        const latest = session.store.getState();
        const back = latest.view.kind === 'draft' || latest.view.kind === 'draft_worktree' ? latest.view.back : latest.view;
        session.store.dispatch({ type: 'view', view: { kind: 'draft_worktree', projectId: action.projectId, back } });
        patchUi({ focus: 'chat', buffer: '', cursor: 0 });
        return;
      }
      case 'new_chat': {
        // An empty chat opens right away; it's only created when you send the first message.
        const latest = session.store.getState();
        const back = latest.view.kind === 'draft' ? latest.view.back : latest.view;
        const dir = action.projectId === 'chats' ? session.launchDir : undefined;
        session.store.dispatch({ type: 'view', view: { kind: 'draft', projectId: action.projectId, dir, back } });
        patchUi({ focus: 'chat', buffer: '', cursor: 0 });
        return;
      }
      case 'add_project':
        typeInto('/project add ~/');
        return;
      case 'view':
        session.store.dispatch({ type: 'view', view: action.view });
        if (action.view.kind === 'files') {
          session.store.dispatch({ type: 'browser_cursor', delta: -10_000 });
          patchUi({ focus: 'files', entered: true });
        } else patchUi({ focus: action.view.kind === 'overview' ? 'main' : 'chat', entered: action.view.kind === 'overview' });
        return;
      case 'close_tab':
        session.store.dispatch({ type: 'close_tab', id: action.id });
        return;
      case 'review_file':
        void ctl?.selectFile(action.index);
        patchUi({ focus: 'main' });
        return;
      case 'ws': {
        const ws = ctl?.manager.find(action.id);
        if (!ctl || !ws) return;
        switch (action.action) {
          case 'merge':
            void ctl.merge(ws.id);
            return;
          case 'commit':
            void ctl.commit(ws.id);
            return;
          case 'fork':
            ctl.open(ws.id);
            typeInto(`/fork ${ws.name}-2`);
            return;
          case 'finder':
            ctl.openInFinder(ws.id);
            return;
          case 'archive':
          case 'delete':
            ctl.prepareRemoval(ws.id);
            patchUi({ menu: { menu: { kind: 'confirm', action: action.action, id: ws.id }, selected: 0 } });
            return;
          case 'restore':
            void ctl.restore(ws.id);
            return;
          case 'review_claude':
            ctl.askClaudeToReview(ws.id);
            return;
          case 'merge_claude':
            ctl.askClaudeToMerge(ws.id);
            return;
          case 'compact':
            ctl.compact(ws.id);
            return;
          case 'pr':
            patchUi({ menu: { menu: { kind: 'pr', id: ws.id }, selected: 0 } });
            void bench?.refreshPrs(ws.id);
            return;
          case 'run':
            bench?.run(ws.id);
            ctl.open(ws.id, 'terminal');
            patchUi({ termKey: runId(ws.id), terminalScroll: 0, focus: 'terminal' });
            return;
          case 'stop_run':
            bench?.stopRun(ws.id);
            return;
          case 'setup':
            bench?.runSetup(ws.id);
            ctl.open(ws.id, 'terminal');
            patchUi({ termKey: setupId(ws.id), terminalScroll: 0 });
            return;
          case 'handoff':
            patchUi({ menu: { menu: { kind: 'handoff', id: ws.id }, selected: 0 } });
            return;
        }
      }
    }
  };

  const menuCtx: MenuContext = { session, patchUi, typeInto: (b) => typeInto(b), askForName: (k, p) => askForName(k, p), openFolder: (dir) => openFolder(dir), runUiAction: (a) => runUiAction(a), write };
  const runMenu = (menu: MenuKind, index: number): void => runMenuOption(menuCtx, menu, index);

  const submit = (text: string, urgent = false): void => {
    const latest = session.store.getState();
    // While Claude waits on a question in this conversation, what you type here is your answer.
    const question = latest.questions[0];
    if (question && question.channel === channelOf(latest.view) && !text.startsWith('/')) {
      answerTyped(session, question, text);
      return;
    }
    // An empty Enter in a pending prompt (e.g. clearing a setup command) still counts.
    if (latest.view.kind === 'draft' && ctl && !text.startsWith('/')) {
      void ctl.startChat(latest.view.projectId, text, latest.view.dir);
      return;
    }
    if (latest.view.kind === 'draft_worktree' && ctl && !text.startsWith('/')) {
      void ctl.startWorktree(latest.view.projectId, text, (prompt) => session.nameTask(prompt));
      return;
    }
    const pending = uiRef.current.pending;
    if (pending && ctl) {
      patchUi({ pending: undefined });
      if (pending.kind === 'group') void ctl.setGroup(pending.projectId, text);
      else if (pending.kind === 'setup' || pending.kind === 'run') bench?.setScript(pending.projectId, pending.kind, text);
      else if (pending.kind === 'remote' && pending.peerId) void session.remote.requestWorktree(pending.peerId, pending.projectId, text, latest.planMode.room === true);
      else void (pending.kind === 'worktree' ? ctl.newWorktree(pending.projectId, text) : ctl.newChat(pending.projectId, text));
      return;
    }
    // In Search, Enter opens the highlighted result.
    if (latest.view.kind === 'search' && !text.startsWith('/')) {
      if (latest.search.hits.length) runUiAction({ type: 'search_hit', index: latest.search.cursor });
      return;
    }
    session.submit(text, urgent);
  };

  const run = (effect: Effect): void => {
    switch (effect.type) {
      case 'submit':
        submit(effect.text, effect.urgent);
        return;
      case 'quit':
        exit();
        session.quit();
        return;
      case 'toast':
        session.toast(effect.text);
        return;
      case 'approve':
        session.answerApproval(effect.answer);
        return;
      case 'close_overlay':
        session.store.dispatch({ type: 'overlay', overlay: undefined });
        return;
      case 'browser_move':
        session.store.dispatch({ type: 'browser_cursor', delta: effect.delta });
        return;
      case 'browser_enter':
        void session.browserEnter();
        return;
      case 'browser_up':
        void session.browserUp();
        return;
      case 'viewer_scroll':
        scrollViewer(effect.delta);
        return;
      case 'viewer_close':
        session.store.dispatch({ type: 'viewer_close' });
        return;
      case 'download': {
        const file = selectedFile();
        if (file) void session.download(file);
        else session.toast('Select a file to download first', 'warn');
        return;
      }
      case 'menu_select':
        runMenu(effect.menu, effect.index);
        return;
      case 'zoom':
        void session.zoom(effect.dir);
        return;
      case 'ui_action':
        runUiAction(effect.action);
        return;
      case 'review_move': {
        const review = session.store.getState().review;
        const count = review?.data?.files.length ?? 0;
        if (review && count) void ctl?.selectFile(Math.max(0, Math.min(count - 1, review.selected + effect.delta)));
        return;
      }
      case 'search_move': {
        const search = session.store.getState().search;
        if (search.hits.length) session.store.dispatch({ type: 'search', search: { cursor: Math.max(0, Math.min(search.hits.length - 1, search.cursor + effect.delta)) } });
        return;
      }
      case 'toggle_plan': {
        const channel = view(session.store.getState(), uiRef.current).channel;
        if (channel === 'draft') return;
        session.setPlanMode(channel, !session.store.getState().planMode[channel]);
        return;
      }
      case 'question_number': {
        const q = session.store.getState().questions[0];
        if (q) answerByNumber(session, q, effect.n);
        return;
      }
      case 'cancel_draft': {
        const latest = session.store.getState();
        if (latest.view.kind === 'draft' || latest.view.kind === 'draft_worktree') session.store.dispatch({ type: 'view', view: latest.view.back });
        return;
      }
      case 'review_scroll': {
        if (session.store.getState().view.kind === 'overview') {
          patchUi({ overviewScroll: Math.max(0, uiRef.current.overviewScroll + effect.delta) });
          return;
        }
        const review = session.store.getState().review;
        if (review) session.store.dispatch({ type: 'review', review: { ...review, diffScroll: Math.max(0, review.diffScroll + effect.delta) } });
        return;
      }
    }
  };

  const runAction = (id: string): void => {
    const current = uiRef.current;
    const latest = session.store.getState();
    switch (id) {
      case 'accept': {
        const pick = view(latest, current).suggestions[current.selected];
        if (pick) patchUi({ buffer: pick.value, cursor: pick.value.length, selected: 0 });
        return;
      }
      case 'hide':
        patchUi({ suggestHidden: true });
        return;
      case 'ask':
        typeInto('@');
        return;
      case 'commands':
        typeInto('/');
        return;
      case 'projects':
        patchUi({ focus: 'projects' });
        return;
      case 'actions':
        patchUi({ focus: 'header', headerCursor: 0 });
        return;
      case 'people':
        patchUi({ focus: 'people' });
        return;
      case 'overview':
        session.store.dispatch({ type: 'view', view: { kind: 'overview' } });
        return;
      case 'review':
        if (latest.view.kind === 'workspace') runUiAction({ type: 'open_ws', id: latest.view.id, tab: 'review' });
        return;
      case 'review-claude':
        if (latest.view.kind === 'workspace') ctl?.askClaudeToReview(latest.view.id);
        return;
      case 'terminal':
        if (latest.view.kind === 'workspace') runUiAction({ type: 'open_ws', id: latest.view.id, tab: 'terminal' });
        return;
      case 'templates':
        patchUi({ menu: { menu: { kind: 'templates' }, selected: 0 } });
        return;
      case 'open-hit':
        if (latest.search.hits.length) runUiAction({ type: 'search_hit', index: latest.search.cursor });
        return;
      case 'refresh-usage':
        void bench?.measureDisk().then(() => session.toast('Measured again', 'success'));
        return;
      case 'open-project-item': {
        const item = view(latest, current).projectItems[current.projectsCursor];
        if (item) runUiAction(item);
        return;
      }
      case 'menu':
        patchUi({ menu: { menu: { kind: 'person', index: current.peopleCursor }, selected: 0 } });
        return;
      case 'chat':
        patchUi({ focus: 'chat', viewerFull: false });
        return;
      case 'open':
        void session.browserEnter();
        return;
      case 'up':
        void session.browserUp();
        return;
      case 'close':
        session.store.dispatch({ type: 'viewer_close' });
        patchUi({ focus: 'chat', viewerFull: false });
        return;
      case 'fullscreen':
        patchUi({ focus: 'viewer', viewerFull: !current.viewerFull });
        return;
      case 'raw':
        patchUi({ viewerRaw: !current.viewerRaw });
        return;
      case 'download':
        run({ type: 'download' });
        return;
      case 'invite':
        void session.copyInvite();
        return;
      case 'clear':
        patchUi({ menu: { menu: { kind: 'clear', channel: view(latest, current).channel, host: session.isHost }, selected: 0 } });
        return;
      case 'share-folder':
        patchUi({ menu: { menu: { kind: 'share_folder', launchDir: session.launchDir, mine: session.myShares }, selected: 0 } });
        return;
      case 'help':
        session.store.dispatch({ type: 'overlay', overlay: 'help' });
        return;
      case 'settings':
        patchUi({ menu: { menu: { kind: 'settings' }, selected: 0 } });
        return;
    }
  };

  const onClick = (target: Target): void => {
    const current = uiRef.current;
    switch (target.kind) {
      case 'zone':
        if (target.disabled) session.toast(target.hint ?? 'Not available right now');
        else runUiAction(target.action);
        return;
      case 'person':
        patchUi({ focus: 'people', peopleCursor: target.index, menu: { menu: { kind: 'person', index: target.index }, selected: 0 } });
        return;
      case 'file': {
        const latest = session.store.getState();
        session.store.dispatch({ type: 'browser_cursor', delta: target.index - latest.browser.cursor });
        patchUi({ focus: 'files' });
        void session.browserEnter();
        return;
      }
      case 'files':
        patchUi({ focus: 'files' });
        return;
      case 'projects':
        patchUi({ focus: 'projects' });
        return;
      case 'main':
        patchUi({ focus: 'main' });
        return;
      case 'terminal':
        patchUi({ focus: 'terminal' });
        return;
      case 'chat':
      case 'composer':
        patchUi({ focus: 'chat' });
        return;
      case 'viewer':
        patchUi({ focus: 'viewer' });
        return;
      case 'menu':
        if (current.menu) {
          const menu = current.menu.menu;
          patchUi({ menu: undefined });
          runMenu(menu, target.index);
        }
        return;
      case 'suggestion': {
        const all = view(session.store.getState(), current).suggestions;
        const pick = all[suggestionWindow(all.length, current.selected).start + target.index];
        if (!pick) return;
        if (pick.enter === 'submit') {
          patchUi({ buffer: '', cursor: 0, history: [...current.history, pick.value] });
          submit(pick.value);
        } else {
          typeInto(pick.value);
        }
        return;
      }
      case 'approval':
        session.answerApproval(target.answer);
        return;
      case 'action':
      case 'viewer_action':
        runAction(target.id);
        return;
      case 'none':
        return;
    }
  };

  const onWheel = (target: Target, dir: 1 | -1): void => {
    const current = uiRef.current;
    const latest = session.store.getState();
    if (target.kind === 'suggestion') {
      const total = view(latest, current).suggestions.length;
      patchUi({ selected: Math.max(0, Math.min(total - 1, current.selected + dir)) });
      return;
    }
    if (target.kind === 'terminal') {
      const max = termSession?.snapshot().scrollback ?? 0;
      patchUi({ terminalScroll: Math.min(max, Math.max(0, (current.terminalScroll ?? 0) - dir * WHEEL_LINES)) });
      return;
    }
    if (target.kind === 'main' && latest.view.kind === 'search') {
      const total = latest.search.hits.length;
      if (total) session.store.dispatch({ type: 'search', search: { cursor: Math.max(0, Math.min(total - 1, latest.search.cursor + dir)) } });
      return;
    }
    if (target.kind === 'main' && latest.view.kind === 'usage') {
      patchUi({ overviewScroll: Math.max(0, current.overviewScroll + dir * WHEEL_LINES) });
      return;
    }
    if (target.kind === 'viewer') scrollViewer(dir * WHEEL_LINES);
    else if (target.kind === 'file' || target.kind === 'files') session.store.dispatch({ type: 'browser_cursor', delta: dir });
    else if (target.kind === 'main' && latest.review && latest.view.kind === 'workspace') run({ type: 'review_scroll', delta: dir * WHEEL_LINES });
    else if (target.kind === 'main' && latest.view.kind === 'overview') {
      const max = Math.max(0, (view(latest, current).overview?.lines.length ?? 0) - 4);
      patchUi({ overviewScroll: Math.min(max, Math.max(0, current.overviewScroll + dir * WHEEL_LINES)) });
    }
    else if (target.kind === 'chat') {
      const dd = view(latest, current);
      const total = chatLines(latest, dd.geometry.chatWidth - 4, frame, dd.channel).length;
      const max = Math.max(0, total - (dd.geometry.paneHeight - 2));
      patchUi({ chatScroll: Math.min(max, Math.max(0, current.chatScroll - dir * WHEEL_LINES)) });
    }
  };

  /** A bug in one handler should show a notice, never take the whole room down. */
  const safely = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      session.toast(`Something went wrong (${label}): ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  // Mouse: clicks act on what's under the pointer, the wheel scrolls it.
  useEffect(() => {
    if (!subscribeMouse) return;
    return subscribeMouse((e) =>
      safely('mouse', () => {
        const latest = session.store.getState();
        const dd = view(latest, uiRef.current);
        const target = hitTest(dd.geometry, e.x, e.y, {
          state: latest,
          menu: dd.menu,
          suggestionCount: suggestionWindow(dd.suggestions.length, uiRef.current.selected).rows,
          buttons: dd.buttons,
          approvalDetailLines: dd.approvalDetailLines,
          viewerLegend: latest.viewer ? viewerLegend(latest.viewer, uiRef.current.viewerFull, uiRef.current.viewerRaw) : undefined,
          zones: dd.zones,
        });
        if (e.button === 'move') {
          const key = JSON.stringify(target);
          if (key !== hoverKey.current) {
            hoverKey.current = key;
            setHover({ x: e.x, y: e.y });
          }
          return;
        }
        if (e.button === 'wheelUp' || e.button === 'wheelDown') onWheel(target, e.button === 'wheelDown' ? 1 : -1);
        else if (e.button === 'left' && e.kind === 'press') onClick(target);
      }),
    );
  });

  useInput((input, key) =>
    safely('key', () => {
      const current = uiRef.current;
      const latest = session.store.getState();
      const dd = view(latest, current);
      const total = chatLines(latest, dd.geometry.chatWidth - 4, frame, dd.channel).length;
      // No raw keyboard here (e.g. a test): translate Ink's keys for the terminal instead.
      if (dd.focus === 'terminal' && termSession) {
        if (isLeaveKey(input, key)) patchUi({ focus: 'chat' });
        else termSession.writeKey(input, key);
        return;
      }
      const result = handleKey({ ...current, focus: dd.focus }, input, key, {
        hasApproval: latest.approvals.length > 0,
        hasViewer: dd.geometry.viewerWidth > 0,
        overlay: Boolean(latest.overlay),
        page: dd.geometry.paneHeight - 2,
        maxChatScroll: Math.max(0, total - (dd.geometry.paneHeight - 2)),
        suggestions: dd.suggestions,
        peopleCount: latest.peers.length,
        menuSize: dd.menu?.options.length ?? 0,
        projectItems: dd.projectItems,
        headerItems: dd.headerItems,
        mainFocusable: (latest.view.kind === 'workspace' && latest.view.tab === 'review') || latest.view.kind === 'overview' || latest.view.kind === 'usage',
        searching: latest.view.kind === 'search',
        terminalVisible: latest.view.kind === 'workspace' && latest.view.tab === 'terminal',
        filesVisible: latest.view.kind === 'files' || (latest.view.kind === 'workspace' && latest.view.tab === 'files'),
        draft: latest.view.kind === 'draft' || latest.view.kind === 'draft_worktree',
        headerStart: dd.headerStart,
        questionOptions: latest.questions[0]?.channel === dd.channel ? (currentQuestion(latest.questions[0])?.options.length ?? 0) : 0,
      });
      setUi(result.ui);
      if (result.effect) run(result.effect);
    }),
  );

  const fullscreen = g.sideWidth === 0;
  // Hovered button in the bottom bar (highlighted, with its description).
  const hoveredButton =
    hover && hover.y === g.actionBarY
      ? (() => {
          const t = hitTest(g, hover.x, hover.y, { state, suggestionCount: d.suggestions.length, buttons: d.buttons, approvalDetailLines: d.approvalDetailLines });
          return t.kind === 'action' ? t.id : undefined;
        })()
      : undefined;
  const hoveredButtonHint = hoveredButton ? BUTTON_HINTS[hoveredButton] : undefined;
  const sideFocus = d.focus === 'projects' || d.focus === 'people' ? d.focus : 'other';
  const activeTransfer = [...state.transfers].reverse().find((t) => t.status === 'active');
  const paneW = g.mainWidth;
  const mainContent = (): React.ReactNode => {
    if (d.menu && ui.menu) return <Menu spec={d.menu} selected={ui.menu.selected} width={paneW} height={g.bodyHeight - 2} />;
    if (state.overlay === 'help') return <HelpOverlay width={paneW} height={g.paneHeight} scroll={ui.overlayScroll} />;
    const viewer = <Viewer state={state} width={g.viewerWidth} height={g.paneHeight} focused={d.focus === 'viewer'} raw={ui.viewerRaw} full={false} />;
    switch (state.view.kind) {
      case 'files':
        return (
          <>
            <FilesPanel state={state} width={g.chatWidth} height={g.paneHeight} focused={d.focus === 'files'} />
            {viewer}
          </>
        );
      case 'overview':
        return (
          <Panel title="Overview" right="every workspace at a glance" width={paneW} height={g.paneHeight} focused={d.focus === 'main'}>
            <ModelBlock lines={d.overview?.lines ?? []} height={g.paneHeight - 2} scroll={d.overviewScroll} />
          </Panel>
        );
      case 'search':
        return (
          <Panel title="Search" right="type below · ↑↓ choose · Enter opens" width={paneW} height={g.paneHeight} focused={d.focus === 'main' || d.focus === 'chat'}>
            <ModelBlock lines={d.pane?.lines ?? []} height={g.paneHeight - 2} scroll={d.paneScroll} />
          </Panel>
        );
      case 'usage':
        return (
          <Panel title="Usage" right="disk space and Claude tokens per workspace" width={paneW} height={g.paneHeight} focused={d.focus === 'main'}>
            <ModelBlock lines={d.pane?.lines ?? []} height={g.paneHeight - 2} scroll={d.paneScroll} />
          </Panel>
        );
      case 'workspace': {
        const ws = d.workspace;
        if (!ws) return <Panel title="Workspace" width={paneW} height={g.paneHeight}>{null}</Panel>;
        if (state.view.tab === 'review') {
          return (
            <Panel title="Review" right="Ask Claude to review · Merge in the bar above" width={paneW} height={g.paneHeight} focused={d.focus === 'main'}>
              <ModelBlock lines={d.review?.lines ?? []} height={g.paneHeight - 2} />
            </Panel>
          );
        }
        if (state.view.tab === 'files') {
          return (
            <>
              <FilesPanel state={state} width={g.chatWidth} height={g.paneHeight} focused={d.focus === 'files'} title={`${ws.name} files`} />
              {viewer}
            </>
          );
        }
        if (state.view.tab === 'terminal' && termBar) {
          return <TerminalView session={termSession} bar={termBar} width={paneW} height={g.paneHeight} focused={termFocused} scroll={ui.terminalScroll ?? 0} title={`${ws.name} terminal`} />;
        }
        return <ChatView state={state} channel={d.channel} title={`Claude in ${ws.name}`} width={paneW} height={g.paneHeight} focused={d.focus === 'chat'} scroll={ui.chatScroll} frame={frame} />;
      }
      case 'shared': {
        const w = d.shared;
        if (!w) return <Panel title="Shared workspace" width={paneW} height={g.paneHeight}>{null}</Panel>;
        if (state.view.tab === 'files') {
          return (
            <>
              <FilesPanel state={state} width={g.chatWidth} height={g.paneHeight} focused={d.focus === 'files'} title={`${w.name} files`} />
              {viewer}
            </>
          );
        }
        return <ChatView state={state} channel={d.channel} title={`${w.name} · with ${state.peers.find((p) => p.peerId === w.owner)?.name ?? 'owner'}'s Claude`} width={paneW} height={g.paneHeight} focused={d.focus === 'chat'} scroll={ui.chatScroll} frame={frame} />;
      }
      case 'draft_worktree': {
        const project = state.projects.find((p) => p.id === (state.view as { projectId: string }).projectId);
        return (
          <Panel title={`New worktree in ${project?.name ?? 'project'} · from the latest origin`} width={paneW} height={g.paneHeight} focused={d.focus === 'chat'}>
            <ModelBlock lines={d.pane?.lines ?? []} height={g.paneHeight - 2} scroll={d.paneScroll} />
          </Panel>
        );
      }
      case 'draft': {
        const where = state.view.dir ?? state.projects.find((p) => p.id === (state.view as { projectId: string }).projectId)?.root ?? '';
        return (
          <Panel title={`New Claude chat · ${where.replace(os.homedir(), '~')}`} width={paneW} height={g.paneHeight} focused={d.focus === 'chat'}>
            <ModelBlock lines={d.pane?.lines ?? []} height={g.paneHeight - 2} scroll={d.paneScroll} />
          </Panel>
        );
      }
      default:
        return (
          <>
            <ChatView state={state} title={state.peers.length > 1 ? 'Group chat · everyone in the room' : 'Chat · you and your Claude'} width={g.chatWidth} height={g.paneHeight} focused={d.focus === 'chat'} scroll={ui.chatScroll} frame={frame} />
            {viewer}
          </>
        );
    }
  };

  const placeholder = state.questions[0] && state.questions[0].channel === d.channel
    ? state.questions[0].question.kind === 'plan'
      ? 'Approve the plan above, or type what to change and press Enter'
      : 'Type your own answer and press Enter, or pick an option above'
    : state.view.kind === 'draft'
    ? 'Ask Claude anything… your first message starts the chat · Esc to cancel'
    : state.view.kind === 'draft_worktree'
    ? 'Describe the task… Enter creates the worktree and starts Claude · Esc to cancel'
    : ui.pending
    ? `Name for the new ${ui.pending.kind} in ${state.projects.find((p) => p.id === ui.pending?.projectId)?.name ?? 'the project'} · Enter to create · Esc to cancel`
    : d.workspace
      ? `Tell Claude what to do in ${d.workspace.name}…`
      : state.view.kind === 'room' && state.peers.length <= 1
        ? 'Talk to your Claude…  @workspace reaches the Claude working there, / for commands'
        : undefined;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box paddingX={1} height={1}>
        <ModelBlock lines={d.topBar.lines} height={1} />
      </Box>
      <Box height={g.bodyHeight}>
        {fullscreen ? (
          <Viewer state={state} width={columns} height={g.bodyHeight} focused raw={ui.viewerRaw} full />
        ) : (
          <>
            <Sidebar
              state={state}
              width={g.sideWidth}
              projectsHeight={g.projectsHeight}
              peopleHeight={g.peopleHeight}
              projects={d.projects}
              projectsScroll={d.projectsScroll}
              projectsCursorRow={d.projectsCursorRow}
              focus={sideFocus}
              peopleCursor={ui.entered ? ui.peopleCursor : -1}
              frame={frame}
            />
            <Box flexDirection="column" width={paneW}>
              <Box paddingX={1} height={2} flexDirection="column">
                <ModelBlock lines={d.tabs.lines} height={2} />
              </Box>
              {d.header && !(d.menu && ui.menu) ? (
                <Box paddingX={1} height={3} flexDirection="column">
                  <ModelBlock lines={d.header.lines} height={3} />
                </Box>
              ) : null}
              <Box>{mainContent()}</Box>
            </Box>
          </>
        )}
      </Box>
      <ApprovalCard approvals={state.approvals} width={columns} />
      {d.question ? (
        <Box borderStyle="round" borderColor={theme.info} paddingX={1} width={columns} flexDirection="column">
          <ModelBlock lines={d.question.lines} height={d.question.lines.length} />
        </Box>
      ) : null}
      <Composer
        width={columns}
        buffer={ui.buffer}
        cursor={ui.cursor}
        focus={d.focus}
        suggestions={d.suggestions}
        selected={Math.min(ui.selected, Math.max(0, d.suggestions.length - 1))}
        buttons={d.buttons}
        toast={state.toast}
        hint={d.hint ?? hoveredButtonHint}
        hoveredButton={hoveredButton}
        transfer={activeTransfer}
        placeholder={placeholder}
        right={d.composerRight}
        accent={ui.pending ? theme.accent : undefined}
      />
    </Box>
  );
}
