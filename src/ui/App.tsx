import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, useApp, useInput, usePaste, useStdout } from 'ink';
import type { BelugaClient } from '../ipc/client.js';
import { type AppState, type Location, peerName } from '../core/store.js';
import { shareNameOf } from '../core/workspace-controller.js';
import { localDirKey } from '../core/local.js';
import { anyActivity } from './banner.js';
import { ApprovalCard } from './components/ApprovalCard.js';
import { chatLines } from './components/ChatView.js';
import { Composer } from './components/Composer.js';
import { MainPane } from './components/MainPane.js';
import { isLeaveKey } from '../terminal/index.js';
import { shellId } from '../core/workbench.js';
import { ModelBlock } from './components/ModelBlock.js';
import { Panel } from './components/Panel.js';
import { Sidebar } from './components/Sidebar.js';
import { Viewer, viewerInner, viewerLegend, viewerLines } from './components/Viewer.js';
import { type Derived, derive } from './derive.js';
import { type Target, hitTest, offsetZones } from './hit.js';
import { type Effect, type UiState, handleKey, initialUi, insertText } from './keymap.js';
import { type MenuKind } from './menus.js';
import { type MenuContext, POLICY_INDEX, runMenu as runMenuOption } from './menu-actions.js';
import { answerByNumber, currentQuestion } from './collab-actions.js';
import type { MouseEvent } from './mouse.js';
import { localDirOf, openTarget, suggestionWindow } from './suggest.js';
import { theme } from './theme.js';
import { type UiAction, isCompacting, stepTab, topTabs } from './workspace-models.js';
import { type UiActionContext, runUiActionWith } from './ui-actions.js';
import { useTerminalPane } from './use-terminal.js';
import { expandOutgoing, pasteClipboardImage, pasteDroppedImages } from './attach-actions.js';
import { openLink } from './link-actions.js';
import { submitTyped } from './submit.js';
import { setLinkEnv } from './links.js';
import { openInvite, projectInView } from './invite-actions.js';

const TOAST_MS = 3500;
const FRAME_MS = 100;
const WHEEL_LINES = 3;
/** Wheel and pointer moves are batched into one update per this many ms (~60fps). */
const MOUSE_FRAME_MS = 16;

/** What each bottom-bar button does, shown while hovering it. */
const BUTTON_HINTS: Record<string, string> = {
  ask: 'Mention a Claude: yours, a friend’s, or everyone’s',
  commands: 'See every command',
  projects: 'Jump to your projects and chats on the left',
  invite: 'Invite someone to one project or the whole room (as host: they knock first)',
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
  queue: 'Your Claude is busy: this waits its turn, then runs',
  'send-now': 'Interrupt your Claude and send this right away (Option+Enter)',
  'queued-now': 'Stop the current task and run your waiting message now',
  'queued-cancel': 'Drop your waiting message before it starts',
};

/** Shown while hovering the box you type in. */
const COMPOSER_HINT = 'Enter sends · Ctrl+J new line · ⌥⌫ deletes a word (hold ⌫ to speed up) · ⌥←→ moves by word';

export interface AppProps {
  /** Beluga, in this process or in the daemon. */
  readonly client: BelugaClient;
  /** Show the welcome screen asking who may use your Claude. */
  readonly onboarding?: boolean;
  /** Subscribe to mouse events (clicks and wheel). Omit to run keyboard-only. */
  readonly subscribeMouse?: (listener: (e: MouseEvent) => void) => () => void;
  /** Send keyboard input straight to a function (the built-in terminal) instead of Ink; undefined gives it back. */
  readonly setRawInput?: (sink: ((data: string) => void) | undefined) => void;
  /** Receive pastes before they're typed (image paths and empty pastes become image chips). */
  readonly setPasteHandler?: (fn: ((text: string) => boolean) | undefined) => void;
  /** When the latest keyboard chunk arrived (keys from one chunk share it); defaults to the clock. */
  readonly inputTime?: () => number;
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

const isWorking = (state: AppState): boolean => anyActivity(state) || isCompacting(state) || state.transfers.some((t) => t.status === 'active');

export function App({ client, onboarding = false, subscribeMouse, setRawInput, setPasteHandler, inputTime }: AppProps) {
  const { api, store } = client;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const toast = (text: string, level?: 'info' | 'success' | 'warn' | 'error'): void => store.dispatch({ type: 'toast', text, ...(level ? { level } : {}) });
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
  // Paths in your messages (and your Claude's) in the room are relative to this project and your shares.
  setLinkEnv({ roots: () => [client.launchDir, ...store.getState().myShares.map((s) => s.root)] });
  const attachCtx = { client, uiRef, patchUi };
  useEffect(() => {
    setPasteHandler?.((text) => {
      if (!text.trim()) {
        if (uiRef.current.focus === 'chat') void pasteClipboardImage(attachCtx, true);
        return true;
      }
      return pasteDroppedImages(attachCtx, text);
    });
    return () => setPasteHandler?.(undefined);
  }, []);

  // Mouse position for hover feedback; only re-render when what's under the pointer changes.
  const [hover, setHover] = useState<{ x: number; y: number; alt?: boolean } | undefined>(undefined);
  const hoverKey = useRef('');
  const view = (s: AppState = state, u: UiState = ui): Derived =>
    derive({ state: s, ui: u, selfId: s.selfId, columns, rows, frame, listLocalDirs: (dir) => s.dirCache[localDirKey(dir)] ?? [], hover });
  const d = view();
  const g = d.geometry;

  useEffect(() => {
    const toast = state.toast;
    if (!toast) return;
    const t = setTimeout(() => store.dispatch({ type: 'toast_clear', id: toast.id }), TOAST_MS);
    return () => clearTimeout(t);
  }, [state.toast, store]);

  // /settings opens the settings menu; inviting for the first time asks who may use your Claude.
  useEffect(() => {
    if (state.overlay === 'clear') {
      store.dispatch({ type: 'overlay', overlay: undefined });
      patchUi({ menu: { menu: { kind: 'clear', channel: view().channel, host: state.isHost }, selected: 0 } });
      return;
    }
    const overlay = state.overlay;
    if (overlay === 'model' || overlay === 'inbox' || overlay === 'templates' || overlay === 'handoff') {
      store.dispatch({ type: 'overlay', overlay: undefined });
      const channel = view().channel;
      const wsId = state.view.kind === 'workspace' ? state.view.id : undefined;
      if (overlay === 'model') patchUi({ menu: { menu: { kind: 'model', ...(channel === 'room' || channel === 'draft' ? {} : { channel }) }, selected: 0 } });
      else if (overlay === 'inbox') patchUi({ menu: { menu: { kind: 'inbox' }, selected: 0 } });
      else if (overlay === 'templates') patchUi({ menu: { menu: { kind: 'templates' }, selected: 0 } });
      else if (wsId) patchUi({ menu: { menu: { kind: 'handoff', id: wsId }, selected: 0 } });
      return;
    }
    if (overlay !== 'settings' && overlay !== 'welcome') return;
    store.dispatch({ type: 'overlay', overlay: undefined });
    patchUi({ menu: { menu: { kind: overlay }, selected: overlay === 'welcome' ? POLICY_INDEX[state.policy] : 0 } });
  }, [state.overlay]);

  // Search as you type, when the Search tab is open.
  const searchQuery = state.view.kind === 'search' && !ui.buffer.startsWith('/') ? ui.buffer : undefined;
  useEffect(() => {
    if (searchQuery === undefined) return;
    const t = setTimeout(() => void api.workbench.search(searchQuery), 120);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // ---- the built-in terminal
  const { termPane, termSession, termFocused, termBar, termKey, termDir } = useTerminalPane({ client, state, ui, uiRef, patchUi, focus: d.focus, geometry: g, setRawInput, onTabStep: (delta) => runUiAction({ type: 'view', view: { kind: stepTab(store.getState(), delta) } }) });

  // Opening a file (yourself) moves you into the viewer so its controls are right there.
  const openedKey = state.viewer && !state.viewer.by ? `${state.viewer.owner}:${state.viewer.share}/${state.viewer.path}` : undefined;
  useEffect(() => {
    if (openedKey) patchUi({ focus: 'viewer' });
  }, [openedKey]);

  // A workspace's Files tab browses its folder.
  const filesFor = state.view.kind === 'workspace' && state.view.tab === 'files' ? state.view.id : undefined;
  useEffect(() => {
    if (filesFor) void api.files.browseTo({ owner: store.getState().selfId, share: shareNameOf(filesFor), path: '' });
  }, [filesFor]);

  // Fetch folder contents as you type a path after /open or /get.
  useEffect(() => {
    const target = openTarget(ui.buffer, state.peers);
    if (target) void api.files.loadDir(target);
  }, [ui.buffer, state.peers, client]);

  // List folders on this computer as you type a path after /project add.
  const localDir = localDirOf(ui.buffer);
  useEffect(() => {
    if (localDir !== undefined) void api.local.listDirs(localDir);
  }, [localDir, client]);

  const selectedFile = (): Location | undefined => {
    const latest = store.getState();
    if (uiRef.current.focus === 'viewer' && latest.viewer) return latest.viewer;
    const row = latest.browser.rows[latest.browser.cursor];
    return row && row.target !== 'up' && !row.dir ? row.target : undefined;
  };

  const scrollViewer = (delta: number): void => {
    const latest = store.getState();
    if (!latest.viewer) return;
    const dd = view(latest, uiRef.current);
    // Fullscreen draws the viewer across the whole body, so measure with those sizes.
    const full = uiRef.current.viewerFull && dd.focus === 'viewer';
    const w = full ? dd.geometry.columns : dd.geometry.viewerWidth;
    const h = full ? dd.geometry.bodyHeight : dd.geometry.paneHeight;
    const total = viewerLines(latest.viewer, w, uiRef.current.viewerRaw, h).length;
    store.dispatch({ type: 'viewer_scroll', delta, max: Math.max(0, total - viewerInner(h)) });
  };

  const typeInto = (buffer: string): void => patchUi({ focus: 'chat', buffer, cursor: buffer.length, suggestHidden: false, selected: 0 });

  const askForName = (kind: 'worktree' | 'chat' | 'group', projectId: string): void => {
    const project = store.getState().projects.find((p) => p.id === projectId);
    patchUi({ focus: 'chat', buffer: '', cursor: 0, pending: { kind, projectId } });
    const where = project?.root ? ` in ${project.name}` : '';
    toast(kind === 'group' ? `Type a name for the new group, then Enter` : `Type a name for the new ${kind}${where}, then Enter`);
  };

  const openFolder = (dir: string): void => void api.local.openFolder(dir);

  const toggle = (key: string): void => {
    const collapsed = uiRef.current.collapsed;
    patchUi({ collapsed: collapsed.includes(key) ? collapsed.filter((c) => c !== key) : [...collapsed, key] });
  };

  const uiCtx: UiActionContext = {
    openLink: (link) => openLink({ client, patchUi, run: (a) => runUiAction(a) }, link),
    pasteImage: () => void pasteClipboardImage(attachCtx),
    client,
    patchUi,
    uiRef,
    toggle,
    typeInto,
    menuCtx: () => menuCtx,
    runMenu: (m, i) => runMenu(m, i),
  };
  const runUiAction = (action: UiAction): void => runUiActionWith(uiCtx, action);

  const menuCtx: MenuContext = { client, patchUi, typeInto: (b) => typeInto(b), askForName: (k, p) => askForName(k, p), openFolder: (dir) => openFolder(dir), runUiAction: (a) => runUiAction(a), write };
  const runMenu = (menu: MenuKind, index: number): void => runMenuOption(menuCtx, menu, index);

  const submit = (typed: string, urgent = false): void =>
    submitTyped({ client, ui: () => uiRef.current, patchUi, runUiAction: (a) => runUiAction(a), expand: (t) => expandOutgoing(client, t) }, typed, urgent);

  const run = (effect: Effect): void => {
    switch (effect.type) {
      case 'submit':
        submit(effect.text, effect.urgent);
        return;
      case 'quit':
        exit();
        void api.session.quit();
        return;
      case 'toast':
        toast(effect.text);
        return;
      case 'approve': {
        const first = store.getState().approvals[0];
        if (first) void api.host.answerApproval(effect.answer, first.id);
        return;
      }
      case 'close_overlay':
        store.dispatch({ type: 'overlay', overlay: undefined });
        return;
      case 'browser_move':
        store.dispatch({ type: 'browser_cursor', delta: effect.delta });
        return;
      case 'browser_enter':
        void api.files.enter(store.getState().browser.cursor);
        return;
      case 'browser_up':
        void api.files.up();
        return;
      case 'viewer_scroll':
        scrollViewer(effect.delta);
        return;
      case 'viewer_close':
        void api.files.closeViewer();
        return;
      case 'download': {
        const file = selectedFile();
        if (file) void api.files.download(file);
        else toast('Select a file to download first', 'warn');
        return;
      }
      case 'menu_select':
        runMenu(effect.menu, effect.index);
        return;
      case 'zoom':
        void api.session.zoom(effect.dir);
        return;
      case 'ui_action':
        runUiAction(effect.action);
        return;
      case 'review_move': {
        const latest = store.getState();
        const review = latest.review;
        const count = review?.data?.files.length ?? 0;
        const index = Math.max(0, Math.min(count - 1, (review?.selected ?? 0) + effect.delta));
        if (review && count) void (latest.view.kind === 'shared' ? api.diff.select(index) : api.workspaces.selectFile(index));
        return;
      }
      case 'tab_jump': {
        const tab = topTabs(store.getState())[effect.index];
        if (tab) runUiAction({ type: 'view', view: { kind: tab.kind } });
        return;
      }
      case 'tab_step':
        runUiAction({ type: 'view', view: { kind: stepTab(store.getState(), effect.delta) } });
        return;
      case 'search_move': {
        const search = store.getState().search;
        if (search.hits.length) store.dispatch({ type: 'search_cursor', cursor: search.cursor + effect.delta });
        return;
      }
      case 'toggle_plan': {
        const channel = view(store.getState(), uiRef.current).channel;
        if (channel === 'draft') return;
        void api.session.setPlanMode(channel, !store.getState().planMode[channel]);
        return;
      }
      case 'question_number': {
        const q = store.getState().questions[0];
        if (q) answerByNumber(client, q, effect.n);
        return;
      }
      case 'cancel_draft': {
        const latest = store.getState();
        if (latest.view.kind === 'draft' || latest.view.kind === 'draft_worktree') store.dispatch({ type: 'view', view: latest.view.back });
        return;
      }
      case 'review_scroll': {
        if (store.getState().view.kind === 'overview') {
          patchUi({ overviewScroll: Math.max(0, uiRef.current.overviewScroll + effect.delta) });
          return;
        }
        if (store.getState().review) store.dispatch({ type: 'review_scroll', delta: effect.delta });
        return;
      }
    }
  };

  const runAction = (id: string): void => {
    const current = uiRef.current;
    const latest = store.getState();
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
        store.dispatch({ type: 'view', view: { kind: 'overview' } });
        return;
      case 'review':
        if (latest.view.kind === 'workspace') runUiAction({ type: 'open_ws', id: latest.view.id, tab: 'review' });
        return;
      case 'review-claude':
        if (latest.view.kind === 'workspace') void api.workspaces.askClaudeToReview(latest.view.id);
        return;
      case 'terminal':
        if (latest.view.kind === 'workspace') runUiAction({ type: 'open_ws', id: latest.view.id, tab: 'terminal' });
        else runUiAction({ type: 'view', view: { kind: 'terminal' } });
        return;
      case 'templates':
        patchUi({ menu: { menu: { kind: 'templates' }, selected: 0 } });
        return;
      case 'open-hit':
        if (latest.search.hits.length) runUiAction({ type: 'search_hit', index: latest.search.cursor });
        return;
      case 'refresh-usage':
        void api.workbench.measureDisk().then(() => toast('Measured again', 'success'));
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
        void api.files.enter(latest.browser.cursor);
        return;
      case 'up':
        void api.files.up();
        return;
      case 'close':
        void api.files.closeViewer();
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
        // Hosting: the Invite flow (one project or everything). In someone else's room: pass on its link.
        if (latest.self?.host) openInvite(menuCtx, projectInView(client));
        else void api.session.copyInvite();
        return;
      case 'clear':
        patchUi({ menu: { menu: { kind: 'clear', channel: view(latest, current).channel, host: latest.isHost }, selected: 0 } });
        return;
      case 'share-folder':
        patchUi({ menu: { menu: { kind: 'share_folder', launchDir: client.launchDir, mine: latest.myShares }, selected: 0 } });
        return;
      case 'help':
        store.dispatch({ type: 'overlay', overlay: 'help' });
        return;
      case 'settings':
        patchUi({ menu: { menu: { kind: 'settings' }, selected: 0 } });
        return;
      case 'queue':
      case 'send-now': {
        const text = current.buffer.trim();
        if (!text) return;
        patchUi({ buffer: '', cursor: 0, historyIndex: -1, chatScroll: 0, history: [...current.history, text].slice(-200) });
        submit(text, id === 'send-now');
        return;
      }
      case 'queued-now':
      case 'queued-cancel': {
        const next = view(latest, current).queuedIds[0];
        if (next === undefined) return toast('Nothing of yours is waiting here');
        // Steering says itself why when it can't (see AgentHost.promote).
        if (id === 'queued-now') return void api.host.promote(next);
        void api.host.cancelQueued(next).then((ok) => {
          if (!ok) toast('Nothing of yours is waiting here');
        });
        return;
      }
    }
  };

  const onClick = (target: Target): void => {
    const current = uiRef.current;
    switch (target.kind) {
      case 'zone':
        if (target.disabled) toast(target.hint ?? 'Not available right now');
        else runUiAction(target.action);
        return;
      case 'person':
        patchUi({ focus: 'people', peopleCursor: target.index, menu: { menu: { kind: 'person', index: target.index }, selected: 0 } });
        return;
      case 'file': {
        const latest = store.getState();
        store.dispatch({ type: 'browser_cursor', delta: target.index - latest.browser.cursor });
        patchUi({ focus: 'files' });
        void api.files.enter(target.index);
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
      case 'terminal': {
        const latest = store.getState();
        const wsId = latest.view.kind === 'workspace' ? latest.view.id : undefined;
        const key = uiRef.current.termKey;
        const running = (k: string): boolean => k in latest.terminals && !(k in latest.termExits);
        // An exited shell starts again when you click it.
        if (wsId && (!key || key === shellId(wsId)) && !running(shellId(wsId))) void api.terminals.shell(wsId, termPane);
        if (latest.view.kind === 'terminal' && termKey && !termSession?.running) void api.terminals.global(termKey, termDir, termPane);
        patchUi({ focus: 'terminal' });
        return;
      }
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
        const all = view(store.getState(), current).suggestions;
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
      case 'approval': {
        const first = store.getState().approvals[0];
        if (first) void api.host.answerApproval(target.answer, first.id);
        return;
      }
      case 'action':
      case 'viewer_action':
        runAction(target.id);
        return;
      case 'none':
        return;
    }
  };

  /** `dir` is how many wheel notches, signed (positive scrolls down); fast scrolling batches several. */
  const onWheel = (target: Target, dir: number): void => {
    const current = uiRef.current;
    const latest = store.getState();
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
      if (total) store.dispatch({ type: 'search_cursor', cursor: latest.search.cursor + dir });
      return;
    }
    if (target.kind === 'main' && latest.view.kind === 'usage') {
      patchUi({ overviewScroll: Math.max(0, current.overviewScroll + dir * WHEEL_LINES) });
      return;
    }
    if (target.kind === 'viewer') scrollViewer(dir * WHEEL_LINES);
    else if (target.kind === 'file' || target.kind === 'files') store.dispatch({ type: 'browser_cursor', delta: dir });
    else if (target.kind === 'chat' && latest.view.kind === 'shared' && latest.view.tab === 'terminal') {
      const max = view(latest, current).shellMaxScroll;
      patchUi({ chatScroll: Math.min(max, Math.max(0, current.chatScroll - dir * WHEEL_LINES)) });
    }
    else if (target.kind === 'main' && latest.review && (latest.view.kind === 'workspace' || latest.view.kind === 'shared')) run({ type: 'review_scroll', delta: dir * WHEEL_LINES });
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
      toast(`Something went wrong (${label}): ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  // Mouse: clicks act on what's under the pointer, the wheel scrolls it.
  // Wheel and pointer moves arrive far faster than the screen can redraw, so they're
  // batched and applied once per frame, hit-tested against what's currently drawn.
  const drawn = useRef(d);
  drawn.current = d;
  const pendingMouse = useRef<{ wheel?: { target: Target; key: string; steps: number }; move?: MouseEvent; timer?: NodeJS.Timeout }>({});
  const targetAt = (e: MouseEvent, dd: Derived = drawn.current): Target => {
    const latest = store.getState();
    return hitTest(dd.geometry, e.x, e.y, {
      state: latest,
      menu: dd.menu,
      suggestionCount: suggestionWindow(dd.suggestions.length, uiRef.current.selected).rows,
      buttons: dd.buttons,
      approvalDetailLines: dd.approvalDetailLines,
      viewerLegend: latest.viewer ? viewerLegend(latest.viewer, uiRef.current.viewerFull, uiRef.current.viewerRaw) : undefined,
      // The terminal's bar (its shells, Run, +) is drawn by the pane itself, right at its top.
      zones: termBar && !dd.menu ? [...dd.zones, ...offsetZones(termBar.zones, dd.geometry.mainX + 1, dd.geometry.paneTop)] : dd.zones,
    });
  };
  const flushMouse = (): void => {
    const pending = pendingMouse.current;
    const { wheel, move } = pending;
    if (pending.timer) clearTimeout(pending.timer);
    pendingMouse.current = {};
    if (wheel && wheel.steps !== 0) onWheel(wheel.target, wheel.steps);
    if (move) {
      const key = JSON.stringify(targetAt(move)) + (move.alt ? '⌥' : '');
      if (key !== hoverKey.current) {
        hoverKey.current = key;
        setHover({ x: move.x, y: move.y, ...(move.alt ? { alt: true } : {}) });
      }
    }
  };
  const queueMouse = (e: MouseEvent): void => {
    const pending = pendingMouse.current;
    if (e.button === 'move') pendingMouse.current = { ...pending, move: e };
    else {
      const target = targetAt(e);
      const key = JSON.stringify(target);
      // Scrolling something else: finish the earlier scroll first.
      if (pending.wheel && pending.wheel.key !== key) flushMouse();
      const current = pendingMouse.current;
      const steps = (current.wheel?.steps ?? 0) + (e.button === 'wheelDown' ? 1 : -1);
      pendingMouse.current = { ...current, wheel: { target, key, steps } };
    }
    if (!pendingMouse.current.timer) pendingMouse.current = { ...pendingMouse.current, timer: setTimeout(() => safely('mouse', flushMouse), MOUSE_FRAME_MS) };
  };
  useEffect(() => () => clearTimeout(pendingMouse.current.timer), []);
  useEffect(() => {
    if (!subscribeMouse) return;
    return subscribeMouse((e) =>
      safely('mouse', () => {
        if (e.button === 'move' || e.button === 'wheelUp' || e.button === 'wheelDown') {
          queueMouse(e);
          return;
        }
        // Clicks act right away, on up-to-date layout (after any scroll still waiting).
        if (e.button !== 'left' || e.kind !== 'press') return;
        flushMouse();
        onClick(targetAt(e, view(store.getState(), uiRef.current)));
      }),
    );
  });

  useInput((input, key) =>
    safely('key', () => {
      const current = uiRef.current;
      const latest = store.getState();
      const dd = view(latest, current);
      const total = chatLines(latest, dd.geometry.chatWidth - 4, frame, dd.channel).length;
      // No raw keyboard here (e.g. a test): translate Ink's keys for the terminal instead.
      if (dd.focus === 'terminal' && termSession) {
        if (isLeaveKey(input, key)) patchUi({ focus: 'chat' });
        else termSession.writeKey(input, key);
        return;
      }
      // Ctrl+V attaches the image on the clipboard.
      if (dd.focus === 'chat' && key.ctrl && input === 'v') {
        void pasteClipboardImage(attachCtx);
        return;
      }
      const result = handleKey({ ...current, focus: dd.focus }, input, key, {
        hasApproval: latest.approvals.length > 0,
        hasViewer: dd.geometry.viewerWidth > 0,
        overlay: Boolean(latest.overlay),
        page: dd.geometry.paneHeight - 2,
        // A shared workspace's Terminal tab scrolls its own output, not the chat.
        maxChatScroll: latest.view.kind === 'shared' && latest.view.tab === 'terminal' ? dd.shellMaxScroll : Math.max(0, total - (dd.geometry.paneHeight - 2)),
        suggestions: dd.suggestions,
        peopleCount: latest.peers.length,
        menuSize: dd.menu?.options.length ?? 0,
        projectItems: dd.projectItems,
        headerItems: dd.headerItems,
        mainFocusable: (latest.view.kind === 'workspace' && latest.view.tab === 'review') || (latest.view.kind === 'shared' && latest.view.tab === 'diff') || latest.view.kind === 'overview' || latest.view.kind === 'usage',
        searching: latest.view.kind === 'search',
        terminalVisible: latest.view.kind === 'terminal' || (latest.view.kind === 'workspace' && latest.view.tab === 'terminal'),
        filesVisible: latest.view.kind === 'files' || ((latest.view.kind === 'workspace' || latest.view.kind === 'shared') && latest.view.tab === 'files'),
        draft: latest.view.kind === 'draft' || latest.view.kind === 'draft_worktree',
        headerStart: dd.headerStart,
        planId: dd.planId,
        planMaxScroll: dd.planMaxScroll,
        questionOptions: latest.questions[0]?.channel === dd.channel ? (currentQuestion(latest.questions[0])?.options.length ?? 0) : 0,
        composerWidth: dd.composerWidth,
        now: inputTime?.() || Date.now(),
      });
      setUi(result.ui);
      if (result.effect) run(result.effect);
    }),
  );

  // Pasted text (bracketed paste) keeps its line breaks and is never sent by itself.
  usePaste((text) =>
    safely('paste', () => {
      const current = uiRef.current;
      if (current.menu) return;
      // A name or command prompt is one line: pasted line breaks become spaces there.
      setUi(insertText({ ...current, focus: 'chat' }, current.pending ? text.replace(/\r?\n/g, ' ') : text));
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
  const hoverComposer = hover && hover.y >= g.composerTop && hover.y < g.composerTop + g.composerHeight;
  const hoveredButtonHint = hoveredButton ? BUTTON_HINTS[hoveredButton] : hoverComposer ? COMPOSER_HINT : undefined;
  const barHint = hover && termBar && hover.y === g.paneTop ? termBar.zones.find((z) => hover.x >= z.x0 + g.mainX + 1 && hover.x <= z.x1 + g.mainX + 1)?.hint : undefined;
  const sideFocus = d.focus === 'projects' || d.focus === 'people' ? d.focus : 'other';
  const activeTransfer = [...state.transfers].reverse().find((t) => t.status === 'active');
  const paneW = g.mainWidth;
  const placeholder = state.questions[0] && state.questions[0].channel === d.channel
    ? state.questions[0].question.kind === 'plan'
      ? 'Approve the plan above, or type what to change and press Enter'
      : 'Type your own answer and press Enter, or pick an option above'
    : state.view.kind === 'draft'
    ? 'Ask Claude anything… your first message starts the chat · Esc to cancel'
    : state.view.kind === 'draft_worktree'
    ? 'Describe the task… Enter creates the worktree and starts Claude · Esc to cancel'
    : ui.pending?.kind === 'peer_run'
    ? `Command to run on ${peerName(state, ui.pending.peerId ?? '')}'s computer (no input; output shows here) · Enter to run · Esc to cancel`
    : ui.pending
    ? `Name for the new ${ui.pending.kind} in ${state.projects.find((p) => p.id === ui.pending?.projectId)?.name ?? 'the project'} · Enter to create · Esc to cancel`
    : d.workspace
      ? `Tell Claude what to do in ${d.workspace.name}…`
      : d.shared && state.view.kind === 'shared' && state.view.tab === 'terminal'
      ? 'Type a command: ls, cd <folder>, cat <file>, tree, find <name>, grep <text>, help · Tab completes'
      : d.shared && state.view.kind === 'shared' && state.view.tab === 'chat' && d.shared.role === 'view'
      ? `You're watching ${d.shared.name} (read-only). Browse it in Files or Terminal above`
      : state.view.kind === 'room' && state.peers.length <= 1
        ? 'Talk to your Claude…  @workspace reaches the Claude working there, / for commands'
        : undefined;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box paddingX={1} height={1}>
        <ModelBlock lines={d.topBar.lines} height={1} />
      </Box>
      <Box height={g.bodyHeight}>
        {d.planFull ? (
          <Panel title="Claude's plan" right="Esc closes · Ctrl+F" width={columns} height={g.bodyHeight} focused>
            <ModelBlock lines={d.planFull.lines} height={g.bodyHeight - 2} />
          </Panel>
        ) : fullscreen ? (
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
              <Box paddingX={1} height={1} flexDirection="column">
                <ModelBlock lines={d.tabs.lines} height={1} />
              </Box>
              {d.header && !(d.menu && ui.menu) ? (
                <Box paddingX={1} height={3} flexDirection="column">
                  <ModelBlock lines={d.header.lines} height={3} />
                </Box>
              ) : null}
              <Box>
                <MainPane state={state} d={d} ui={ui} frame={frame} terminal={{ session: termSession, bar: termBar, focused: termFocused }} />
              </Box>
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
        hint={d.hint ?? barHint ?? hoveredButtonHint}
        hoveredButton={hoveredButton}
        transfer={activeTransfer}
        placeholder={placeholder}
        right={d.composerRight}
        idleHint={d.focus === 'terminal' ? 'Click here (or Ctrl+]) to talk to Claude again' : undefined}
        accent={ui.pending ? theme.accent : undefined}
        lines={g.composerLines}
        wrapWidth={d.composerWidth}
      />
    </Box>
  );
}
