import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { belugaHome } from '../home.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import type { DraftContext } from '../../agent/task-drafter.js';
import { findPr } from '../../workspaces/pr.js';
import { Board } from './board.js';
import { seedDemoBoard } from './demo.js';
import { attachBoard, detachBoard } from './registry.js';
import { BoardWork } from './work.js';
import { Plans } from '../plans/plans.js';
import { PlansWork } from '../plans/work.js';
import { attachPlans, detachPlans } from '../plans/registry.js';
import { seedDemoPlan } from '../plans/demo.js';
import { PlanDecisions } from '../plans/decisions.js';

/**
 * Start the board and plans for the daemon (the Mac app's Beluga): tasks in ~/.beluga/board.json,
 * moved by pull requests, kept true by Claude; plans in ~/.beluga/plans.json. The demo's board lives in a temporary
 * folder and starts with tasks to show.
 */

export interface BoardHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

export function launchBoard(host: BoardHost): () => void {
  const { session, store } = host;
  const dir = host.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-board-')) : belugaHome();
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
    // Tasks whose worktree went before their pull request merged still go Done (the demo has no GitHub).
    ...(host.demo
      ? {}
      : {
          findPr: async (dir: string, branch: string) => {
            const pr = await findPr(dir, branch);
            return pr && { number: pr.number, url: pr.url, state: pr.state, title: pr.title, draft: pr.draft, checks: pr.checks, ...(pr.review ? { review: pr.review } : {}) };
          },
        }),
  });
  attachBoard(session, work);
  // Plans: drafted in a conversation, approved onto the board, run milestone by milestone.
  const plans = new Plans({ store, dir, now: () => Date.now() - back });
  // Made after the plans' work (it moves the plan along), told by its forYou hook.
  let decisions: PlanDecisions | undefined;
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
    // The head Claude stopping a task's Claude (plan_stop_task).
    stopRun: (channel) => void session.host.stopRun(channel),
    // A milestone check you passed past: its run stops, so nothing the plan asks next waits behind it.
    cancel: (requestId) => void session.host.cancelRun(requestId, 'Stopped by Beluga: the milestone was passed without this check'),
    titlePlan: (goal) => session.titlePlan(goal),
    // Tasks only you can do came up: their decision cards (below) go up now.
    forYou: () => decisions?.sync(true),
  });
  attachPlans(session, planWork);
  // A plan task that's yours: a decision card in the plan's conversation, never a worktree.
  decisions = new PlanDecisions({
    store,
    plans,
    board: work,
    questions: session.questions,
    askClaude: (prompt, channel) => void session.askOwnClaude(prompt, channel, false, false),
    schedule: () => planWork.pilot.schedule(),
  });
  let stopSeed = (): void => undefined;
  if (host.demo && !board.list().length) {
    stopSeed = seedDemoBoard(store, work, (ms) => (back = ms), () => void seedDemoPlan(store, planWork, work, (ms) => (back = ms)).catch(() => undefined));
  }
  return () => {
    stopSeed();
    decisions?.stop();
    detachPlans(session);
    planWork.stop();
    detachBoard(session);
    work.stop();
    store.dispatch({ type: 'plans_off' });
    store.dispatch({ type: 'board_off' });
    if (host.demo) rmSync(dir, { recursive: true, force: true });
  };
}
