import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { klaudHome } from '../home.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import type { DraftContext } from '../../agent/task-drafter.js';
import { Board } from './board.js';
import { seedDemoBoard } from './demo.js';
import { attachBoard, detachBoard } from './registry.js';
import { BoardWork } from './work.js';
import { Plans } from '../plans/plans.js';
import { PlansWork } from '../plans/work.js';
import { attachPlans, detachPlans } from '../plans/registry.js';
import { seedDemoPlan } from '../plans/demo.js';

/**
 * Start the board and plans for the daemon (the Mac app's klaud): tasks in ~/.klaud/board.json,
 * moved by pull requests, kept true by Claude; plans in ~/.klaud/plans.json. The demo's board lives in a temporary
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
    ...(session.draftsTasks ? { draftTask: (text: string, ctx: DraftContext) => session.draftTask(text, ctx) } : {}),
  });
  attachBoard(session, work);
  // Plans: drafted in a conversation, approved onto the board, run milestone by milestone.
  const plans = new Plans({ store, dir, now: () => Date.now() - back });
  const planWork = new PlansWork({
    store,
    plans,
    board: work,
    ...(session.workspaces ? { controller: session.workspaces } : {}),
    askClaude: (prompt, channel, echo) => session.askOwnClaude(prompt, channel, false, echo),
    intend: (intent) => session.intend(intent),
    // A task whose Claude stopped: is its process there, and taking over to wake it.
    alive: (channel) => session.host.runningIn(channel),
    takeOver: (channel) => session.host.takeOver(channel),
    // The head Claude's steered messages go in the way Steer Now does (interrupting a long command or a dead run).
    promote: (requestId) => session.host.promote(requestId),
    titlePlan: (goal) => session.titlePlan(goal),
  });
  attachPlans(session, planWork);
  let stopSeed = (): void => undefined;
  if (host.demo && !board.list().length) {
    stopSeed = seedDemoBoard(store, work, (ms) => (back = ms), () => void seedDemoPlan(store, planWork, work, (ms) => (back = ms)).catch(() => undefined));
  }
  return () => {
    stopSeed();
    detachPlans(session);
    planWork.stop();
    detachBoard(session);
    work.stop();
    store.dispatch({ type: 'plans_off' });
    store.dispatch({ type: 'board_off' });
    if (host.demo) rmSync(dir, { recursive: true, force: true });
  };
}
