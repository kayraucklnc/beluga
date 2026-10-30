import { describe, expect, it } from 'vitest';
import type { DialogueTurnRun } from '../src/core/dialogues/chair.js';
import { Dialogues } from '../src/core/dialogues/service.js';
import { capsOf, modeOf, parseDialogueStart } from '../src/core/dialogues/start.js';
import { dialogueHeader } from '../src/core/dialogues/view.js';
import { Store, initialState } from '../src/core/store.js';
import type { AgentRef } from '../src/protocol.js';

const CLAUDE: AgentRef = { runtime: 'claude', label: 'Claude' };
const CODEX: AgentRef = { runtime: 'codex', label: 'Codex' };
const MINE = [CLAUDE, CODEX];

describe('starting a dialogue from the composer', () => {
  it('reads two @my: agents and a verb, with caps', () => {
    expect(parseDialogueStart('@my:claude @my:codex talk about tabs vs spaces, 6 turns', MINE)).toEqual({ kind: 'proposal', participants: [{ agent: CLAUDE }, { agent: CODEX }], topic: 'tabs vs spaces', mode: 'talk', turnCap: 6 });
    expect(parseDialogueStart('/dialogue claude codex cross-reference each other on is P=NP likely?, 20k tokens', MINE)).toMatchObject({ mode: 'cross-reference', topic: 'is P=NP likely?', budget: 20_000 });
    expect(parseDialogueStart('/dialogue @my:Codex @my:Claude work on the flaky login test', MINE)).toMatchObject({ mode: 'work', topic: 'the flaky login test', participants: [{ agent: CODEX }, { agent: CLAUDE }] });
  });

  it('leaves everything else alone, and says what is wrong with a bad start', () => {
    expect(parseDialogueStart('@my:claude fix the build', MINE)).toBeUndefined();
    expect(parseDialogueStart('talk about it', MINE)).toBeUndefined();
    expect(parseDialogueStart('@my:claude @my:gemini talk about x', MINE)).toEqual({ kind: 'error', message: 'You have no agent named “gemini”' });
    expect(parseDialogueStart('/dialogue claude', MINE)).toMatchObject({ kind: 'error' });
    expect(parseDialogueStart('@my:claude @my:codex 6 turns', MINE)).toMatchObject({ kind: 'error' });
  });

  it('caps and modes read the ways people say them', () => {
    expect(capsOf('x for 4 turns, budget 1.5m tokens')).toEqual({ rest: 'x', turnCap: 4, budget: 1_500_000 });
    expect(modeOf('you two, discuss: the plan')).toEqual({ mode: 'talk', topic: 'the plan' });
    expect(modeOf('the plan')).toEqual({ mode: 'talk', topic: 'the plan' });
  });
});

describe('the room thread', () => {
  function setup(answer: (run: DialogueTurnRun) => Promise<{ text: string; tokens: number }> = async (run) => ({ text: `${run.participant.agent.label} turn ${run.turn}`, tokens: 10 })) {
    const store = new Store(initialState('room'));
    store.dispatch({ type: 'identity', selfId: 'me', isHost: true, home: '/h' });
    const toasts: string[] = [];
    const runs: DialogueTurnRun[] = [];
    const d = new Dialogues({ store, selfId: () => 'me', selfName: () => 'Kayra', myAgents: () => MINE, toast: (t) => toasts.push(t), runTurn: (run) => (runs.push(run), answer(run)) });
    return { store, d, toasts, runs };
  }

  it('proposes first (caps shown), runs once confirmed, and posts each turn labeled with its agent', async () => {
    const { store, d, runs } = setup();
    expect(d.fromComposer('@my:claude @my:codex talk about naming, 6 turns', 'room')).toBe(true);
    const [dlg] = Object.values(store.getState().dialogues);
    expect(dlg).toMatchObject({ status: 'proposed', turnCap: 6, channel: 'room', startedBy: 'Kayra' });
    expect(dialogueHeader(dlg!)).toMatchObject({ progress: 'Up to 6 turns, then Continue?', actions: ['start', 'cancel'] });
    expect(store.getState().log.find((l) => l.type === 'system' && l.dialogue?.id === dlg!.id)).toBeTruthy();
    expect(runs).toHaveLength(0);
    // Only one at a time in a conversation.
    expect(d.fromComposer('@my:claude @my:codex talk about more', 'room')).toBe(true);
    expect(Object.keys(store.getState().dialogues)).toHaveLength(1);

    d.confirm(dlg!.id, { turnCap: 2, budget: 5000 });
    await d.chair.settled(dlg!.id);
    const after = store.getState().dialogues[dlg!.id]!;
    expect(after).toMatchObject({ status: 'paused', budget: 5000, pauseAt: 2 });
    const turns = store.getState().log.filter((l) => l.type === 'chat' && l.dialogue?.id === dlg!.id);
    expect(turns.map((t) => t.type === 'chat' && [t.name, t.agent?.label, t.dialogue?.turn, t.text])).toEqual([
      ["room's Claude", 'Claude', 1, 'Claude turn 1'],
      ["room's Codex", 'Codex', 2, 'Codex turn 2'],
    ].map(([, label, turn, text]) => [expect.stringContaining(String(label)), label, turn, text]));
    expect(dialogueHeader(after)).toMatchObject({ status: 'Paused after 2 turns: continue?', actions: ['continue', 'stop'], budget: '5k tokens left' });
  });

  it('what you type lands as a turn the next agent reads, and Stop ends it with a line', async () => {
    let release: (() => void) | undefined;
    const { store, d, runs } = setup((run) => (run.turn === 1 ? new Promise((resolve) => (release = () => resolve({ text: 'first', tokens: 1 }))) : new Promise(() => undefined)));
    d.fromComposer('/dialogue claude codex talk about caching', 'ws:w1');
    const id = Object.keys(store.getState().dialogues)[0]!;
    d.confirm(id);
    expect(d.fromComposer('think about cost too', 'ws:w1')).toBe(true);
    // Other conversations and commands aren't touched.
    expect(d.fromComposer('hello', 'room')).toBe(false);
    expect(d.fromComposer('/review', 'ws:w1')).toBe(false);
    release?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(runs[1]!.input.prompt).toContain('Kayra (a person in the room)');
    expect(runs[1]!.input.prompt).toContain('think about cost too');
    const you = store.getState().log.find((l) => l.type === 'chat' && l.dialogue?.turn === 0);
    expect(you).toMatchObject({ byAgent: false, text: 'think about cost too' });

    expect(d.fromComposer('/dialogue stop', 'ws:w1')).toBe(true);
    expect(runs[1]!.input.signal.aborted).toBe(true);
    expect(store.getState().dialogues[id]!.status).toBe('stopped');
    expect(store.getState().log.at(-1)).toMatchObject({ type: 'system', text: 'Dialogue stopped after 1 turn: Stopped by Kayra' });
    // Over: the composer talks to the agent again.
    expect(d.fromComposer('thanks', 'ws:w1')).toBe(false);
  });

  it('a bad start is said, not sent', () => {
    const { d, toasts } = setup();
    expect(d.fromComposer('@my:claude @my:llama talk about x', 'room')).toBe(true);
    expect(toasts).toEqual(['You have no agent named “llama”']);
  });
});
