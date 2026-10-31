import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { type Actor, actorName } from '../src/core/board/model.js';
import { BoardWork } from '../src/core/board/work.js';
import { ActorSchema } from '../src/core/team/protocol.js';
import { Store, initialState } from '../src/core/store.js';
import { LinkMessage } from '../src/net/mesh/wire.js';
import { initialNetwork, reduceNetwork } from '../src/core/network-store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import type { AgentRef } from '../src/protocol.js';

/**
 * BLG-498: activity says which agent did it, so screens show the real agent's mark (Codex's, a
 * local model's), not Claude's for everyone. Older entries and older Macs leave it out: Claude.
 */

const CODEX: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5' };
const LOCAL: AgentRef = { runtime: 'local', label: 'Local model' };

const ws = (id: string, projectId: string, name: string, agent?: AgentRef): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind: 'worktree', projectRoot: '/tmp/p', branch: `beluga/${name}`, createdAt: 0, external: false, ...(agent ? { agent } : {}) }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });

function setup() {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api', [ws('w1', 'api', 'add-auth', CODEX), ws('w2', 'api', 'docs')])] });
  const board = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name });
  const work = new BoardWork({ store, board, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
  const issue = board.create({ projectId: 'api', title: 'Auth', status: 'in_progress' }, work.me());
  board.linkWorktree(issue.key, 'w1', { branch: 'beluga/add-auth', name: 'add-auth' }, work.me());
  return { store, board, work, issue };
}

describe('the board records which agent did it (BLG-498)', () => {
  it('a run’s tools write as the conversation’s agent: its workspace’s pick, else your default', () => {
    const { board, work, issue } = setup();
    work.forRun('ws:w1', 'p-me')!.tools!.note(issue.key, 'Codex was here');
    work.forRun('ws:w2', 'p-me')!.tools!.note(issue.key, 'and the default agent');
    const notes = board.get(issue.id)!.activity.filter((a) => a.kind === 'note');
    expect(notes.map((a) => a.by)).toEqual([
      { kind: 'claude', owner: 'p-me', ownerName: 'Kay', agent: CODEX },
      { kind: 'claude', owner: 'p-me', ownerName: 'Kay', agent: { runtime: 'claude', label: 'Claude' } },
    ]);
    expect(work.myClaude('ws:w1')).toMatchObject({ agent: CODEX });
    expect(work.myClaude()).toMatchObject({ agent: { runtime: 'claude' } });
  });

  it('names the agent it recorded; an older entry (no agent) reads as Claude', () => {
    const codex: Actor = { kind: 'claude', owner: 'p-me', ownerName: 'Kay', agent: CODEX };
    const theirs: Actor = { kind: 'claude', owner: 'p-mia', ownerName: 'Mia', agent: LOCAL };
    const old: Actor = { kind: 'claude', owner: 'p-mia', ownerName: 'Mia' };
    expect([actorName(codex, 'p-me'), actorName(theirs, 'p-me'), actorName(old, 'p-me')]).toEqual(['Your Codex', "Mia's Local model", "Mia's Claude"]);
  });

  it('teammates’ boards carry it; an older Mac’s line has none, and a bad one is dropped, not the line', () => {
    const peer = 'a'.repeat(32);
    expect(ActorSchema.parse({ kind: 'claude', owner: peer, ownerName: 'Mia', agent: CODEX })).toEqual({ kind: 'claude', owner: peer, ownerName: 'Mia', agent: CODEX });
    expect(ActorSchema.parse({ kind: 'claude', owner: peer, ownerName: 'Mia' })).toEqual({ kind: 'claude', owner: peer, ownerName: 'Mia' });
    expect(ActorSchema.parse({ kind: 'claude', owner: peer, ownerName: 'Mia', agent: { runtime: 'NOT OK' } })).toEqual({ kind: 'claude', owner: peer, ownerName: 'Mia' });
  });
});

describe('“answering…” says which agent (BLG-498)', () => {
  it('the live frame carries the agent; an older Mac’s has none', () => {
    expect(LinkMessage.parse({ t: 'live', for: 'm1', state: 'thinking', agent: CODEX })).toMatchObject({ agent: CODEX });
    expect(LinkMessage.parse({ t: 'live', for: 'm1', state: 'thinking' })).not.toHaveProperty('agent');
  });

  it('the store keeps it on the live row', () => {
    const next = reduceNetwork(initialNetwork, { type: 'net_live', conversation: 'dm:x', state: 'thinking', live: { peerId: 'p-mia', name: 'Mia', for: 'm1', since: 1, agent: LOCAL } });
    expect(next.network.live?.['dm:x']).toEqual([{ peerId: 'p-mia', name: 'Mia', for: 'm1', since: 1, agent: LOCAL }]);
  });
});
