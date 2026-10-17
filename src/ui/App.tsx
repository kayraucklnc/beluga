import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';
import type { Session } from '../core/session.js';
import { anyActivity } from './banner.js';
import { ApprovalCard, approvalHeight } from './components/ApprovalCard.js';
import { ChatView, chatLines } from './components/ChatView.js';
import { Composer } from './components/Composer.js';
import { Header } from './components/Header.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { Sidebar } from './components/Sidebar.js';
import { Viewer } from './components/Viewer.js';
import { type Effect, type UiState, handleKey, initialUi } from './keymap.js';
import { suggest } from './suggest.js';

const TOAST_MS = 3500;
const FRAME_MS = 100;

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

export function App({ session }: { session: Session }) {
  const state = useSyncExternalStore(session.store.subscribe, session.store.getState);
  const [ui, setUiState] = useState(initialUi);
  // Keystrokes can arrive faster than React commits; always build on the latest state.
  const uiRef = useRef<UiState>(initialUi);
  const setUi = (next: UiState): void => {
    uiRef.current = next;
    setUiState(next);
  };
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const frame = useFrame(anyActivity(state));

  useEffect(() => {
    const toast = state.toast;
    if (!toast) return;
    const t = setTimeout(() => session.store.dispatch({ type: 'toast_clear', id: toast.id }), TOAST_MS);
    return () => clearTimeout(t);
  }, [state.toast, session]);

  const suggestions = ui.focus === 'chat' && !ui.suggestHidden ? suggest(ui.buffer, state.peers, session.selfId) : [];
  const sideWidth = Math.min(34, Math.max(24, Math.floor(columns * 0.22)));
  const viewerWidth = state.viewer ? Math.floor((columns - sideWidth) * 0.48) : 0;
  const chatWidth = columns - sideWidth - viewerWidth;
  const bottomHeight = 4 + suggestions.length + approvalHeight(state.approvals[0], columns);
  const bodyHeight = Math.max(8, rows - 1 - bottomHeight);
  const focus = ui.focus === 'viewer' && !state.viewer ? 'chat' : ui.focus;

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
        session.store.dispatch({ type: 'viewer_scroll', delta: effect.delta });
        return;
      case 'viewer_close':
        session.store.dispatch({ type: 'viewer_close' });
        return;
    }
  };

  useInput((input, key) => {
    const current = uiRef.current;
    const latest = session.store.getState();
    const total = chatLines(latest, chatWidth - 4, frame).length;
    const result = handleKey(current, input, key, {
      hasApproval: latest.approvals.length > 0,
      hasViewer: Boolean(latest.viewer),
      overlay: Boolean(latest.overlay),
      page: bodyHeight - 2,
      maxChatScroll: Math.max(0, total - (bodyHeight - 2)),
      suggestions: current.focus === 'chat' && !current.suggestHidden ? suggest(current.buffer, latest.peers, session.selfId) : [],
    });
    setUi(result.ui);
    if (result.effect) run(result.effect);
  });

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header state={state} width={columns} />
      <Box height={bodyHeight}>
        <Sidebar state={state} width={sideWidth} height={bodyHeight} focused={focus === 'files'} frame={frame} />
        {state.overlay === 'help' ? (
          <HelpOverlay width={columns - sideWidth} height={bodyHeight} scroll={ui.overlayScroll} />
        ) : (
          <>
            <ChatView state={state} width={chatWidth} height={bodyHeight} focused={focus === 'chat'} scroll={ui.chatScroll} frame={frame} />
            <Viewer state={state} width={viewerWidth} height={bodyHeight} focused={focus === 'viewer'} />
          </>
        )}
      </Box>
      <ApprovalCard approvals={state.approvals} width={columns} />
      <Composer
        width={columns}
        buffer={ui.buffer}
        cursor={ui.cursor}
        focus={focus}
        suggestions={suggestions}
        selected={Math.min(ui.selected, Math.max(0, suggestions.length - 1))}
        toast={state.toast}
      />
    </Box>
  );
}
