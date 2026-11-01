import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pretendSystem } from '../gateway/demo-system.js';
import { belugaHome } from '../home.js';
import { boardOf } from '../board/registry.js';
import { plansOf } from '../plans/registry.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import { MacAssistant } from './assistant.js';
import { attachAssistant, detachAssistant } from './registry.js';

/**
 * Start "Your Mac" for the daemon (the Mac app's Beluga): its folder in ~/.beluga/assistant, its
 * history loaded. The demo's lives in a temporary folder and looks at a pretend Mac.
 */
export function launchAssistant(host: { readonly session: Session; readonly store: Store; readonly demo: boolean }): () => void {
  const { session, store } = host;
  const dir = host.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-assistant-')) : path.join(belugaHome(), 'assistant');
  const assistant = new MacAssistant({
    store,
    dir,
    selfId: () => session.selfId,
    ...(host.demo ? { system: pretendSystem() } : {}),
    startWorktree: async (projectId, message, opts) => session.workspaces?.startWorktree(projectId, message, (p) => session.nameTask(p), { ...opts, quiet: true }),
    startTask: async (key) => {
      const board = boardOf(session);
      if (!board) throw new Error('Tasks need the Beluga app');
      return board.start(key, { claude: true, quiet: true });
    },
    startPlan: async (projectId, goal) => {
      const plans = plansOf(session);
      if (!plans) throw new Error('Plans need the Beluga app');
      return plans.create({ projectId, goal }, { quiet: true });
    },
    archiveWorktree: async (id) => {
      if (!session.workspaces) throw new Error('Archiving needs the Beluga app');
      return session.workspaces.archive(id);
    },
  });
  attachAssistant(session, assistant);
  return () => {
    detachAssistant(session);
    assistant.stop();
  };
}
