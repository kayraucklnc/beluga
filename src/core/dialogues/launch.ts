import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { belugaHome } from '../home.js';
import type { AgentRef } from '../../protocol.js';
import { runtimeFor } from '../../agent/runtime/registry.js';
import type { AgentPlace } from '../../agent/types.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import { attachDialogues, detachDialogues } from './registry.js';
import { Dialogues } from './service.js';

export interface DialoguesHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

/** Runtimes a dialogue can name besides your default agent (when this Beluga has them). */
const KNOWN_RUNTIMES = ['claude', 'codex', 'local'];

/** Your agents: the default one, then every other runtime this Beluga can run. */
export function myAgents(own: AgentRef): AgentRef[] {
  const others = KNOWN_RUNTIMES.filter((id) => id !== own.runtime).flatMap((id) => {
    const rt = runtimeFor(id);
    return rt ? [{ runtime: rt.id, label: rt.label }] : [];
  });
  return [own, ...others];
}

/**
 * A dialogue turn's place: the conversation's folder (a worktree's code to read, or to work in),
 * never its own conversation (a dialogue's turns carry their own transcript, not the chat's session).
 */
function turnPlace(place: AgentPlace | undefined): AgentPlace | undefined {
  if (!place) return undefined;
  const { resume: _r, forkSession: _f, ...rest } = place;
  return { ...rest, onSession: () => undefined };
}

/** Dialogues between your agents (core/dialogues): the chair, saved beside plans, and its room thread. */
export function launchDialogues(host: DialoguesHost): () => void {
  const { session, store } = host;
  const dir = host.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-dialogues-')) : belugaHome();
  const own = (): AgentRef => session.agentRef;
  const dialogues = new Dialogues({
    store,
    dir,
    selfId: () => session.selfId,
    selfName: () => store.getState().self?.name ?? store.getState().network.self?.name ?? 'You',
    myAgents: () => (host.demo ? [own(), { runtime: 'codex', label: 'Codex' }] : myAgents(own())),
    toast: (text, level) => session.toast(text, level ?? 'info'),
    runTurn: async (run) => {
      const runtime = run.participant.agent.runtime;
      const backend = session.backendFor(runtime);
      if (!backend) throw new Error(`${run.participant.agent.label} can't run on this Mac`);
      const channel = run.dialogue.channel ?? 'room';
      const place = channel === 'room' ? undefined : turnPlace(session.workspaces?.place(channel));
      return session.host.runDialogueTurn(channel, backend, run.input, { ...(place ? { place } : {}), defaultModel: runtime === own().runtime });
    },
  });
  attachDialogues(session, dialogues);
  return () => {
    dialogues.chair.close();
    detachDialogues(session);
  };
}
