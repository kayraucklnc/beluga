import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { COMPANION_API } from '../src/ipc/companion-api.js';
import { PLANS_API } from '../src/ipc/plans-api.js';
import type { AgentRef } from '../src/protocol.js';
import { agentChoices, agentForChoice } from '../src/ui/agent-choice.js';
import type { Project } from '../src/workspaces/types.js';

/** BLG-498: a new task or plan from the phone says who works it (none: your default agent). */

const CODEX: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5.5' };
const project = (id: string, name: string): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces: [] });

describe('a new task’s agent from the phone', () => {
  it('companion.addTask takes `agent` for the whole message, never inside one of its drafts', () => {
    const args = COMPANION_API['companion.addTask'].args;
    const draft = { projectId: 'p1', title: 'Retry webhooks', goal: '', acceptance: [], labels: [] };
    expect(args.parse([{ ...draft, agent: CODEX }])[0].agent).toEqual(CODEX);
    expect(args.parse([draft])[0].agent).toBeUndefined();
    expect(args.safeParse([{ ...draft, more: [{ title: 'b', goal: '', acceptance: [], labels: [], agent: CODEX }] }]).success).toBe(false);
  });

  it('every task it adds is worked by that agent; without one, your default', () => {
    const store = new Store(initialState('room'));
    store.dispatch({ type: 'projects', projects: [project('api', 'bob-api')] });
    const board = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name });
    const controller = { onWorktree: () => () => undefined } as unknown as WorkspaceController;
    const work = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
    const made = work.addDraft('api', { title: 'Checkout', goal: 'e', acceptance: [], labels: [], epic: true, more: [{ title: 'Card form', goal: 'c', acceptance: [], labels: [] }] }, CODEX);
    expect(made.map((i) => i.agent)).toEqual([CODEX, CODEX]);
    expect(work.addDraft('api', { title: 'Plain', goal: '', acceptance: [], labels: [] })[0]!.agent).toBeUndefined();
  });

  it('plans.create already takes it (the phone’s Advanced plan)', () => {
    expect(PLANS_API['plans.create'].args.parse([{ projectId: 'api', goal: 'g', agent: CODEX }])[0].agent).toEqual(CODEX);
  });

  it('the phone’s list from a picker: each runtime and its models, back to the agent it stands for', () => {
    const runtimes = [
      { id: 'claude', label: 'Claude', available: true, models: [{ value: '', label: 'Default', description: '' }, { value: 'opus', label: 'Opus', description: '' }] },
      { id: 'codex', label: 'Codex', available: true, models: [{ value: 'gpt-5.5', label: 'GPT-5.5', description: '' }] },
      { id: 'local', label: 'Local model', available: false, why: 'No local model endpoint is set' },
    ];
    const options = agentChoices(runtimes, runtimes[0]!.models ?? []);
    expect(options.map((o) => o.label)).toEqual(['Claude', 'Claude · Opus', 'Codex', 'Codex · GPT-5.5', 'Local model']);
    expect(options.at(-1)).toMatchObject({ disabled: true, why: 'No local model endpoint is set' });
    expect(agentForChoice('codex:gpt-5.5', runtimes)).toEqual(CODEX);
  });
});
