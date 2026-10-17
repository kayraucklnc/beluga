import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';
import type { Session } from '../core/session.js';
import type { AppState, Location, Policy } from '../core/store.js';
import { actionButtons } from './actions.js';
import { anyActivity } from './banner.js';
import { ApprovalCard } from './components/ApprovalCard.js';
import { ChatView, chatLines } from './components/ChatView.js';
import { Composer } from './components/Composer.js';
import { Header } from './components/Header.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { Menu } from './components/Menu.js';
import { Sidebar } from './components/Sidebar.js';
import { Viewer, viewerLegend, viewerLines } from './components/Viewer.js';
import { approvalLines } from './format.js';
import { type Target, hitTest } from './hit.js';
import { type Effect, type UiState, handleKey, initialUi } from './keymap.js';
import { computeLayout } from './layout.js';
import { type MenuKind, menuSpec } from './menus.js';
import type { MouseEvent } from './mouse.js';
import { type Suggestion, openTarget, suggest } from './suggest.js';

const TOAST_MS = 3500;
const FRAME_MS = 100;
const WHEEL_LINES = 3;
const POLICY_BY_OPTION: Record<string, Policy> = { 'share-ask': 'ask', 'share-auto': 'auto', 'share-deny': 'deny' };
const POLICY_INDEX: Record<Policy, number> = { ask: 0, auto: 1, deny: 2 };

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

function suggestionsFor(ui: UiState, state: AppState, selfId: string): Suggestion[] {
  if (ui.focus !== 'chat' || ui.suggestHidden || ui.menu) return [];
  return suggest(ui.buffer, { peers: state.peers, selfId, dirCache: state.dirCache });
}

/** Everything derived from state + UI that both rendering and mouse handling need. */
function derive(state: AppState, ui: UiState, selfId: string, columns: number, rows: number) {
  const suggestions = suggestionsFor(ui, state, selfId);
  const focus = ui.focus === 'viewer' && !state.viewer ? 'chat' : ui.focus;
  const approval = state.approvals[0];
  const geometry = computeLayout({
    columns,
    rows,
    peopleCount: state.peers.length,
    hasViewer: Boolean(state.viewer),
    suggestionCount: suggestions.length,
    approvalDetail: approval?.detail,
    viewerFull: ui.viewerFull && focus === 'viewer',
  });
  const menu = ui.menu ? menuSpec(state, ui.menu.menu) : undefined;
  const buttons = actionButtons(focus, state, suggestions.length > 0, { full: ui.viewerFull, raw: ui.viewerRaw });
  const approvalDetailLines = approval ? approvalLines(approval.detail, columns - 4).length : 0;
  return { suggestions, focus, geometry, menu, buttons, approvalDetailLines };
}

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
  const { columns, rows } = useTerminalSize();
  const frame = useFrame(anyActivity(state) || state.transfers.some((t) => t.status === 'active'));
  const view = derive(state, ui, session.selfId, columns, rows);
  const g = view.geometry;

  useEffect(() => {
    const toast = state.toast;
    if (!toast) return;
    const t = setTimeout(() => session.store.dispatch({ type: 'toast_clear', id: toast.id }), TOAST_MS);
    return () => clearTimeout(t);
  }, [state.toast, session]);

  // Opening a file (yourself) moves you into the viewer so its controls are right there.
  // Files opened by someone you follow don't steal focus.
  const openedKey = state.viewer && !state.viewer.by ? `${state.viewer.owner}:${state.viewer.share}/${state.viewer.path}` : undefined;
  useEffect(() => {
    if (openedKey) patchUi({ focus: 'viewer' });
  }, [openedKey]);

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

  /** Scroll the viewer, bounded by what it actually renders (wrapped Markdown can be longer than the source). */
  const scrollViewer = (delta: number): void => {
    const latest = session.store.getState();
    if (!latest.viewer) return;
    const d = derive(latest, uiRef.current, session.selfId, columns, rows);
    const total = viewerLines(latest.viewer, d.geometry.viewerWidth, uiRef.current.viewerRaw).length;
    session.store.dispatch({ type: 'viewer_scroll', delta, max: Math.max(0, total - (d.geometry.bodyHeight - 3)) });
  };

  const typeInto = (buffer: string): void => patchUi({ focus: 'chat', buffer, cursor: buffer.length, suggestHidden: false, selected: 0 });

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
    switch (option.id) {
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
        patchUi({ focus: 'files' });
        return;
      }
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

  const run = (effect: Effect): void => {
    switch (effect.type) {
      case 'submit':
        session.submit(effect.text);
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
    }
  };

  const runAction = (id: string): void => {
    const current = uiRef.current;
    switch (id) {
      case 'accept': {
        const pick = derive(session.store.getState(), current, session.selfId, columns, rows).suggestions[current.selected];
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
      case 'people':
        patchUi({ focus: 'people' });
        return;
      case 'menu':
        patchUi({ menu: { menu: { kind: 'person', index: current.peopleCursor }, selected: 0 } });
        return;
      case 'chat':
        patchUi({ focus: 'chat' });
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
    }
  };

  const onClick = (target: Target): void => {
    const current = uiRef.current;
    switch (target.kind) {
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
        const pick = derive(session.store.getState(), current, session.selfId, columns, rows).suggestions[target.index];
        if (!pick) return;
        if (pick.enter === 'submit') {
          patchUi({ buffer: '', cursor: 0, history: [...current.history, pick.value] });
          session.submit(pick.value);
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
    if (target.kind === 'viewer') scrollViewer(dir * WHEEL_LINES);
    else if (target.kind === 'file' || target.kind === 'files') session.store.dispatch({ type: 'browser_cursor', delta: dir });
    else if (target.kind === 'chat') {
      const latest = session.store.getState();
      const d = derive(latest, current, session.selfId, columns, rows);
      const total = chatLines(latest, d.geometry.chatWidth - 4, frame).length;
      const max = Math.max(0, total - (d.geometry.bodyHeight - 2));
      patchUi({ chatScroll: Math.min(max, Math.max(0, current.chatScroll - dir * WHEEL_LINES)) });
    }
  };

  // Mouse: clicks act on what's under the pointer, the wheel scrolls it.
  useEffect(() => {
    if (!subscribeMouse) return;
    return subscribeMouse((e) => {
      const latest = session.store.getState();
      const d = derive(latest, uiRef.current, session.selfId, columns, rows);
      const target = hitTest(d.geometry, e.x, e.y, {
        state: latest,
        menu: d.menu,
        suggestionCount: d.suggestions.length,
        buttons: d.buttons,
        approvalDetailLines: d.approvalDetailLines,
        viewerLegend: latest.viewer ? viewerLegend(latest.viewer, uiRef.current.viewerFull, uiRef.current.viewerRaw) : undefined,
      });
      if (e.button === 'wheelUp' || e.button === 'wheelDown') onWheel(target, e.button === 'wheelDown' ? 1 : -1);
      else if (e.button === 'left' && e.kind === 'press') onClick(target);
    });
  });

  useInput((input, key) => {
    const current = uiRef.current;
    const latest = session.store.getState();
    const d = derive(latest, current, session.selfId, columns, rows);
    const total = chatLines(latest, d.geometry.chatWidth - 4, frame).length;
    const result = handleKey(current, input, key, {
      hasApproval: latest.approvals.length > 0,
      hasViewer: Boolean(latest.viewer),
      overlay: Boolean(latest.overlay),
      page: d.geometry.bodyHeight - 2,
      maxChatScroll: Math.max(0, total - (d.geometry.bodyHeight - 2)),
      suggestions: d.suggestions,
      peopleCount: latest.peers.length,
      menuSize: d.menu?.options.length ?? 0,
    });
    setUi(result.ui);
    if (result.effect) run(result.effect);
  });

  const mainWidth = columns - g.sideWidth;
  const sideFocus = view.focus === 'people' || view.focus === 'files' ? view.focus : 'other';
  const fullscreen = g.sideWidth === 0;
  const activeTransfer = [...state.transfers].reverse().find((t) => t.status === 'active');
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
          peopleHeight={g.peopleHeight}
          filesHeight={g.filesHeight}
          focus={sideFocus}
          peopleCursor={ui.peopleCursor}
          frame={frame}
        />
        {view.menu && ui.menu ? (
          <Menu spec={view.menu} selected={ui.menu.selected} width={mainWidth} height={g.bodyHeight} />
        ) : state.overlay === 'help' ? (
          <HelpOverlay width={mainWidth} height={g.bodyHeight} scroll={ui.overlayScroll} />
        ) : (
          <>
            <ChatView state={state} width={g.chatWidth} height={g.bodyHeight} focused={view.focus === 'chat'} scroll={ui.chatScroll} frame={frame} />
            <Viewer state={state} width={g.viewerWidth} height={g.bodyHeight} focused={view.focus === 'viewer'} raw={ui.viewerRaw} full={false} />
          </>
        )}
          </>
        )}
      </Box>
      <ApprovalCard approvals={state.approvals} width={columns} />
      <Composer
        width={columns}
        buffer={ui.buffer}
        cursor={ui.cursor}
        focus={view.focus}
        suggestions={view.suggestions}
        selected={Math.min(ui.selected, Math.max(0, view.suggestions.length - 1))}
        buttons={view.buttons}
        toast={state.toast}
        transfer={activeTransfer}
      />
    </Box>
  );
}
