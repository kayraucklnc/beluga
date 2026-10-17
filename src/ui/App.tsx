import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Box, useApp, useInput, useStdout } from 'ink';
import type { Session } from '../core/session.js';
import type { AppState, Location, Policy } from '../core/store.js';
import { THEMES } from '../core/settings.js';
import { shareNameOf } from '../core/workspace-controller.js';
import type { FsEntry } from '../protocol.js';
import { anyActivity } from './banner.js';
import { ApprovalCard } from './components/ApprovalCard.js';
import { ChatView, chatLines } from './components/ChatView.js';
import { Composer } from './components/Composer.js';
import { FilesPanel } from './components/FilesPanel.js';
import { Header } from './components/Header.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { Menu } from './components/Menu.js';
import { ModelBlock } from './components/ModelBlock.js';
import { Panel } from './components/Panel.js';
import { Sidebar } from './components/Sidebar.js';
import { Viewer, viewerInner, viewerLegend, viewerLines } from './components/Viewer.js';
import { type Derived, derive } from './derive.js';
import { type Target, hitTest } from './hit.js';
import { type Effect, type UiState, handleKey, initialUi } from './keymap.js';
import { type MenuKind, menuSpec } from './menus.js';
import { MOUSE_OFF, MOUSE_ON, type MouseEvent } from './mouse.js';
import { openTarget, suggestionWindow } from './suggest.js';
import { applyTheme, theme } from './theme.js';
import { type UiAction, isCompacting, toggleProject } from './workspace-models.js';

const TOAST_MS = 3500;
const FRAME_MS = 100;
const WHEEL_LINES = 3;
const POLICY_BY_OPTION: Record<string, Policy> = { 'share-ask': 'ask', 'share-auto': 'auto', 'share-deny': 'deny' };
const POLICY_INDEX: Record<Policy, number> = { ask: 0, auto: 1, deny: 2 };

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
};

export interface AppProps {
  readonly session: Session;
  /** Show the welcome screen asking who may use your Claude. */
  readonly onboarding?: boolean;
  /** Subscribe to mouse events (clicks and wheel). Omit to run keyboard-only. */
  readonly subscribeMouse?: (listener: (e: MouseEvent) => void) => () => void;
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

export function App({ session, onboarding = false, subscribeMouse }: AppProps) {
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
    if (state.overlay !== 'settings' && state.overlay !== 'welcome') return;
    const kind = state.overlay;
    session.store.dispatch({ type: 'overlay', overlay: undefined });
    patchUi({ menu: { menu: { kind }, selected: kind === 'welcome' ? POLICY_INDEX[state.policy] : 0 } });
  }, [state.overlay]);

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
    switch (action.type) {
      case 'open_ws':
        ctl?.open(action.id, action.tab);
        if (action.tab === 'review') patchUi({ focus: 'main' });
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
      case 'project_menu':
        patchUi({ menu: { menu: { kind: 'project', id: action.id }, selected: 0 } });
        return;
      case 'archived_menu':
        patchUi({ menu: { menu: { kind: 'archived', id: action.id }, selected: 0 } });
        return;
      case 'none':
        return;
      case 'new_worktree':
        askForName('worktree', action.projectId);
        return;
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
        }
      }
    }
  };

  const runMenu = (menu: MenuKind, index: number): void => {
    const latest = session.store.getState();
    const option = menuSpec(latest, menu)?.options[index];
    if (!option) return;
    const peer = menu.kind === 'person' ? latest.peers[menu.index] : undefined;
    const policy = POLICY_BY_OPTION[option.id];
    if (policy) {
      session.setClaudeSharing(policy);
      const msg = { ask: "You'll approve each request for your Claude", auto: 'Everyone in the room can use your Claude', deny: 'Your Claude is private' };
      session.toast(msg[policy], 'success');
      return;
    }
    const reopen = (): void => patchUi({ menu: { menu, selected: index } });
    const confirmId = menu.kind === 'confirm' ? menu.id : undefined;
    const project = menu.kind === 'project' ? latest.projects.find((p) => p.id === menu.id) : undefined;
    const archived = menu.kind === 'archived' ? ctl?.manager.find(menu.id) : undefined;
    if (option.id.startsWith('p-group:') && project) {
      void ctl?.setGroup(project.id, option.id.slice('p-group:'.length));
      return;
    }
    switch (option.id) {
      case 'p-worktree':
        if (project) askForName('worktree', project.id);
        return;
      case 'p-chat':
        if (project) runUiAction({ type: 'new_chat', projectId: project.id });
        return;
      case 'p-main': {
        const main = project?.workspaces.find((w) => w.kind === 'main');
        if (main) ctl?.open(main.id);
        return;
      }
      case 'p-finder':
        if (project) openFolder(project.root);
        return;
      case 'p-newgroup':
        if (project) askForName('group', project.id);
        return;
      case 'p-ungroup':
        if (project) void ctl?.setGroup(project.id, undefined);
        return;
      case 'p-hide':
        if (project) void ctl?.hideProject(project.id);
        return;
      case 'a-restore':
        if (archived) void ctl?.restore(archived.id);
        return;
      case 'a-open':
        if (archived) ctl?.open(archived.id);
        return;
      case 'a-finder':
        if (archived) openFolder(archived.projectRoot || archived.path);
        return;
      case 'a-delete':
        if (archived) patchUi({ menu: { menu: { kind: 'confirm', action: 'delete', id: archived.id }, selected: 0 } });
        return;
      case 'confirm-archive':
      case 'confirm-archive-force':
        if (confirmId) void ctl?.archive(confirmId, option.id === 'confirm-archive-force');
        return;
      case 'confirm-commit-archive':
        if (confirmId) void ctl?.commit(confirmId).then(() => ctl.archive(confirmId));
        return;
      case 'confirm-delete':
        if (confirmId) void ctl?.remove(confirmId);
        return;
      case 'confirm-archive-env':
      case 'confirm-delete-env':
        if (confirmId && ctl) {
          ctl.applyEnvBack(confirmId);
          void (option.id === 'confirm-archive-env' ? ctl.archive(confirmId, true) : ctl.remove(confirmId));
        }
        return;
      case 'set-name':
        typeInto('/name ');
        return;
      case 'set-theme': {
        const next = THEMES[(THEMES.indexOf(latest.prefs.theme) + 1) % THEMES.length] ?? 'calm';
        applyTheme(next);
        session.setPrefs({ theme: next });
        reopen();
        return;
      }
      case 'set-policy': {
        const order = ['ask', 'auto', 'deny'] as const;
        session.setClaudeSharing(order[(order.indexOf(latest.policy) + 1) % order.length] ?? 'ask');
        reopen();
        return;
      }
      case 'set-mouse':
        write(latest.prefs.mouse ? MOUSE_OFF : MOUSE_ON);
        session.setPrefs({ mouse: !latest.prefs.mouse });
        reopen();
        return;
      case 'set-tunnel': {
        const order = ['auto', 'cloudflared', 'ngrok', 'none'] as const;
        session.setPrefs({ tunnel: order[(order.indexOf(latest.prefs.tunnel) + 1) % order.length] ?? 'auto' });
        reopen();
        return;
      }
      case 'size-in':
      case 'size-out':
      case 'size-reset':
        void session.zoom(option.id === 'size-in' ? 'in' : option.id === 'size-out' ? 'out' : 'reset');
        reopen();
        return;
      case 'settings':
        patchUi({ menu: { menu: { kind: 'settings' }, selected: 0 } });
        return;
      case 'close':
        return;
      case 'ask':
        typeInto(`@claude:${peer?.name ?? ''} `);
        return;
      case 'ask-self':
        typeInto('@claude ');
        return;
      case 'follow':
      case 'unfollow':
        session.follow(option.id === 'follow' ? peer?.name : undefined);
        return;
      case 'browse': {
        const share = peer?.shares[0];
        if (peer && share) void session.browseTo({ owner: peer.peerId, share: share.name, path: '' });
        session.store.dispatch({ type: 'view', view: { kind: 'files' } });
        patchUi({ focus: 'files' });
        return;
      }
      case 'fulltrust':
      case 'unfulltrust':
        if (peer) session.store.dispatch({ type: 'full_trust', peerId: peer.peerId, trusted: option.id === 'fulltrust' });
        session.toast(option.id === 'fulltrust' ? `${peer?.name} is fully trusted: their requests and actions run without asking` : `${peer?.name} needs approvals again`, 'success');
        return;
      case 'set-self-approval':
        session.setPrefs({ selfApproval: latest.prefs.selfApproval === 'ask' ? 'never' : 'ask' });
        reopen();
        return;
      case 'trust':
      case 'untrust':
        if (peer) session.store.dispatch({ type: 'trust', peerId: peer.peerId, trusted: option.id === 'trust' });
        session.toast(option.id === 'trust' ? `${peer?.name} can use your Claude without asking` : `${peer?.name} needs your approval again`, 'success');
        return;
      case 'access-full':
      case 'access-folder':
        if (peer) {
          session.setAccess(peer.peerId, option.id === 'access-full' ? 'full' : 'folder');
          session.toast(option.id === 'access-full' ? `${peer.name} can reach your whole computer` : `${peer.name} is limited to your shared folders`, 'success');
        }
        return;
      case 'invite':
        void session.copyInvite();
        return;
      case 'sharing':
        patchUi({ menu: { menu: { kind: 'welcome' }, selected: POLICY_INDEX[latest.policy] } });
        return;
    }
  };

  const submit = (text: string, urgent = false): void => {
    const latest = session.store.getState();
    if (latest.view.kind === 'draft' && ctl && !text.startsWith('/')) {
      void ctl.startChat(latest.view.projectId, text, latest.view.dir);
      return;
    }
    const pending = uiRef.current.pending;
    if (pending && ctl) {
      patchUi({ pending: undefined });
      if (pending.kind === 'group') void ctl.setGroup(pending.projectId, text);
      else void (pending.kind === 'worktree' ? ctl.newWorktree(pending.projectId, text) : ctl.newChat(pending.projectId, text));
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
      case 'cancel_draft': {
        const latest = session.store.getState();
        if (latest.view.kind === 'draft') session.store.dispatch({ type: 'view', view: latest.view.back });
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
    if (target.kind === 'viewer') scrollViewer(dir * WHEEL_LINES);
    else if (target.kind === 'file' || target.kind === 'files') session.store.dispatch({ type: 'browser_cursor', delta: dir });
    else if (target.kind === 'main' && latest.review) run({ type: 'review_scroll', delta: dir * WHEEL_LINES });
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
        mainFocusable: (latest.view.kind === 'workspace' && latest.view.tab === 'review') || latest.view.kind === 'overview',
        filesVisible: latest.view.kind === 'files' || (latest.view.kind === 'workspace' && latest.view.tab === 'files'),
        draft: latest.view.kind === 'draft',
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
        return <ChatView state={state} channel={d.channel} title={`Claude in ${ws.name}`} width={paneW} height={g.paneHeight} focused={d.focus === 'chat'} scroll={ui.chatScroll} frame={frame} />;
      }
      case 'draft': {
        const where = state.view.dir ?? state.projects.find((p) => p.id === (state.view as { projectId: string }).projectId)?.root ?? '';
        return <ChatView state={state} channel="draft" title={`New Claude chat · ${where.replace(os.homedir(), '~')}`} width={paneW} height={g.paneHeight} focused={d.focus === 'chat'} scroll={0} frame={frame} />;
      }
      default:
        return (
          <>
            <ChatView state={state} title="Group chat · everyone in the room" width={g.chatWidth} height={g.paneHeight} focused={d.focus === 'chat'} scroll={ui.chatScroll} frame={frame} />
            {viewer}
          </>
        );
    }
  };

  const placeholder = state.view.kind === 'draft'
    ? 'Ask Claude anything… your first message starts the chat · Esc to cancel'
    : ui.pending
    ? `Name for the new ${ui.pending.kind} in ${state.projects.find((p) => p.id === ui.pending?.projectId)?.name ?? 'the project'} · Enter to create · Esc to cancel`
    : d.workspace
      ? `Tell Claude what to do in ${d.workspace.name}…`
      : undefined;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header state={state} width={columns} />
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
              peopleCursor={ui.peopleCursor}
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
        accent={ui.pending ? theme.accent : undefined}
      />
    </Box>
  );
}
