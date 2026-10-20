import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { klaudHome } from '../home.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import { Board } from './board.js';
import { seedDemoBoard } from './demo.js';
import { attachBoard, detachBoard } from './registry.js';
import { BoardWork } from './work.js';

/**
 * Start the board for the daemon (the Mac app's klaud): tasks in ~/.klaud/board.json, opened by
 * worktrees, moved by pull requests, kept true by Claude. The demo's board lives in a temporary
 * folder and starts with tasks to show.
 */

export interface BoardHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

export function launchBoard(host: BoardHost): () => void {
  const { session, store } = host;
  const dir = host.demo ? mkdtempSync(path.join(os.tmpdir(), 'klaud-demo-board-')) : klaudHome();
  // The demo's tasks are made "in the past", so their history reads like a real one.
  let back = 0;
  const board = new Board({
    store,
    dir,
    projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name,
    now: () => Date.now() - back,
  });
  const work = new BoardWork({
    store,
    board,
    ...(session.workspaces ? { controller: session.workspaces } : {}),
    selfId: () => session.selfId,
    selfName: () => store.getState().self?.name ?? store.getState().network.self?.name ?? 'You',
    askClaude: (prompt, channel) => session.askOwnClaude(prompt, channel),
  });
  attachBoard(session, work);
  let stopSeed = (): void => undefined;
  if (host.demo && !board.list().length) stopSeed = seedDemoBoard(store, work, (ms) => (back = ms));
  return () => {
    stopSeed();
    detachBoard(session);
    work.stop();
    store.dispatch({ type: 'board_off' });
    if (host.demo) rmSync(dir, { recursive: true, force: true });
  };
}
