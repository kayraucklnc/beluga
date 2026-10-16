import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';
import type { Session } from '../core/session.js';
import { approvalLines, renderLog } from './format.js';
import { type Effect, type UiState, handleKey, initialUi } from './keymap.js';
import { ApprovalBar, ChatPane, FilesPane, Header, Prompt, StatusLine, ViewerPane } from './panes.js';

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

  const firstApproval = state.approvals[0];
  const approvalHeight = firstApproval ? 4 + approvalLines(firstApproval.detail, columns - 4).length : 0;
  const bodyHeight = Math.max(8, rows - 3 - approvalHeight);
  const filesWidth = Math.min(34, Math.max(20, Math.floor(columns * 0.22)));
  const viewerWidth = state.viewer ? Math.floor((columns - filesWidth) * 0.5) : 0;
  const chatWidth = columns - filesWidth - viewerWidth;
  const pane = ui.pane === 'viewer' && !state.viewer ? 'chat' : ui.pane;

  const run = (effect: Effect): void => {
    switch (effect.type) {
      case 'submit':
        session.submit(effect.text);
        return;
      case 'quit':
        exit();
        session.quit();
        return;
      case 'approve':
        session.answerApproval(effect.answer);
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
    const chatLines = renderLog(state.log, chatWidth - 4, state.self?.peerId).length;
    const result = handleKey({ ...current, pane: current.pane === 'viewer' && !state.viewer ? 'chat' : current.pane }, input, key, {
      hasApproval: state.approvals.length > 0,
      hasViewer: Boolean(state.viewer),
      page: bodyHeight - 2,
      maxChatScroll: Math.max(0, chatLines - (bodyHeight - 2)),
    });
    setUi(result.ui);
    if (result.effect) run(result.effect);
  });

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header state={state} />
      <Box height={bodyHeight}>
        <FilesPane state={state} active={pane === 'files'} width={filesWidth} height={bodyHeight} />
        <ChatPane state={state} active={pane === 'chat'} width={chatWidth} height={bodyHeight} scroll={ui.chatScroll} />
        <ViewerPane state={state} active={pane === 'viewer'} width={viewerWidth} height={bodyHeight} />
      </Box>
      <ApprovalBar approvals={state.approvals} width={columns} />
      <StatusLine mode={ui.mode} pane={pane} state={state} />
      <Prompt mode={ui.mode} buffer={ui.buffer} cursor={ui.cursor} />
    </Box>
  );
}
