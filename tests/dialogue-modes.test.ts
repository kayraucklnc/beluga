import { describe, expect, it } from 'vitest';
import { WORK_OUTSIDE_REASON } from '../src/agent/dialogue-tools.js';
import type { DialogueTurnRun } from '../src/core/dialogues/chair.js';
import { createDialogue } from '../src/core/dialogues/model.js';
import { Dialogues } from '../src/core/dialogues/service.js';
import { Store, initialState } from '../src/core/store.js';
import type { AgentRef } from '../src/protocol.js';

const CLAUDE: AgentRef = { runtime: 'claude', label: 'Claude' };
const CODEX: AgentRef = { runtime: 'codex', label: 'Codex' };

function setup(answers: Record<number, string> = {}) {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'identity', selfId: 'me', isHost: true, home: '/h' });
  const runs: DialogueTurnRun[] = [];
  const toasts: string[] = [];
  const d = new Dialogues({
    store,
    selfId: () => 'me',
    selfName: () => 'Kayra',
    myAgents: () => [CLAUDE, CODEX],
    toast: (t) => toasts.push(t),
    worktreeOf: (channel) => (channel === 'ws:wt1' ? '/projects/app/.wt/fix-login' : undefined),
    runTurn: async (run) => {
      runs.push(run);
      return { text: answers[run.turn] ?? `turn ${run.turn}`, tokens: 10 };
    },
  });
  return { store, d, runs, toasts };
}

describe('cross-reference', () => {
  it('"cross-reference each other" yields A answers, B critiques with sources, A reconciles, and keeps the reconciled answer', async () => {
    const { store, d, runs } = setup({ 1: 'Yes, since 2019 [1].', 2: 'Source [1] says 2021, not 2019.', 3: 'Yes, since 2021 (corrected after the critique).' });
    d.fromComposer('@my:claude @my:codex you two, cross-reference each other on: has X been true since 2019?', 'room');
    const id = Object.keys(store.getState().dialogues)[0]!;
    expect(store.getState().dialogues[id]).toMatchObject({ mode: 'cross-reference', turnCap: 3, status: 'proposed' });
    d.confirm(id, { turnCap: 10 });
    await d.chair.settled(id);

    expect(runs.map((r) => [r.turn, r.participant.agent.label])).toEqual([[1, 'Claude'], [2, 'Codex'], [3, 'Claude']]);
    expect(runs[0]!.input.dialogue.brief).toMatch(/answer the question fully.*give sources/s);
    expect(runs[1]!.input.dialogue.brief).toMatch(/critique the answer above.*cite them/s);
    expect(runs[2]!.input.dialogue.brief).toMatch(/reconcile.*final answer/s);
    expect(runs[1]!.input.prompt).toContain('Yes, since 2019 [1].');
    expect(runs[2]!.input.prompt).toContain('Source [1] says 2021');
    expect(runs[2]!.input.prompt).toMatch(/Reconcile: the final answer\.$/);
    // Read-only, all three turns.
    for (const r of runs) expect(r.input.vetTool?.('Write', { file_path: '/tmp/x' })).toBeTruthy();

    const done = store.getState().dialogues[id]!;
    expect(done).toMatchObject({ status: 'ended', result: 'Yes, since 2021 (corrected after the critique).' });
    expect(store.getState().log.at(-1)).toMatchObject({ type: 'system', text: expect.stringContaining('Cross-reference done') });
  });

  it('is between exactly two agents', () => {
    expect(() => createDialogue({ id: 'x', topic: 't', mode: 'cross-reference', participants: [{ agent: CLAUDE }, { agent: CODEX }, { agent: CLAUDE }] }, 1)).toThrow(/two agents/);
  });
});

describe('work', () => {
  it('runs in exactly one worktree: its conversation’s, with the commit rules’ env', async () => {
    const { store, d, runs, toasts } = setup();
    // Not in a worktree: refused, said.
    d.fromComposer('/dialogue claude codex work on the flaky login test, 2 turns', 'room');
    expect(toasts.at(-1)).toMatch(/one worktree/);
    expect(Object.keys(store.getState().dialogues)).toHaveLength(0);

    d.fromComposer('/dialogue claude codex work on the flaky login test, 2 turns', 'ws:wt1');
    const id = Object.keys(store.getState().dialogues)[0]!;
    expect(store.getState().dialogues[id]).toMatchObject({ mode: 'work', worktree: '/projects/app/.wt/fix-login' });
    d.confirm(id);
    await d.chair.settled(id);
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      expect(r.input.scope).toBe('folder');
      expect(r.input.env).toMatchObject({ BELUGA_WORKTREE: '/projects/app/.wt/fix-login', KLAUD_WORKTREE: '/projects/app/.wt/fix-login' });
      expect(r.input.vetTool?.('Edit', { file_path: '/projects/app/.wt/fix-login/src/login.ts' })).toBeUndefined();
      expect(r.input.vetTool?.('Write', { file_path: 'src/new.ts' })).toBeUndefined();
      expect(r.input.vetTool?.('Write', { file_path: '/projects/app/src/login.ts' })).toBe(WORK_OUTSIDE_REASON);
      expect(r.input.vetTool?.('Edit', { file_path: '/projects/app/.wt/fix-login/../other/x.ts' })).toBe(WORK_OUTSIDE_REASON);
      expect(r.input.vetTool?.('Bash', { command: 'npm test' })).toBeUndefined();
      expect(r.input.dialogue.brief).toContain('in /projects/app/.wt/fix-login only, with the usual commit rules');
    }
  });
});
