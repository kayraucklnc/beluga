import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { END_DIALOGUE_TOOL, TALK_READ_ONLY_REASON, talkReadOnly } from '../src/agent/dialogue-tools.js';
import { gateTool } from '../src/agent/tool-gate.js';
import { runToolSuites } from '../src/agent/run-tools.js';
import { ViewShelf } from '../src/agent/view-tools.js';
import type { AgentRunInput, RoomBridge } from '../src/agent/types.js';
import { Chair, type DialogueTurnRun, type DialogueTurnResult } from '../src/core/dialogues/chair.js';
import { DEFAULT_TURN_CAP, type Participant, createDialogue, turnDone } from '../src/core/dialogues/model.js';
import { dialogueBrief, speakerName, turnPrompt } from '../src/core/dialogues/prompt.js';

const claude: Participant = { agent: { runtime: 'claude', label: 'Claude' } };
const codex: Participant = { agent: { runtime: 'codex', label: 'Codex' } };

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-dlg-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A chair whose turns answer at once, each saying who spoke; `script` can end, spend or hang a turn. */
function chair(opts: { dir?: string; script?: (run: DialogueTurnRun) => Partial<DialogueTurnResult> | 'end' | 'hang' | Error } = {}) {
  const runs: DialogueTurnRun[] = [];
  let t = 1000;
  const c = new Chair({
    ...(opts.dir ? { dir: opts.dir } : {}),
    now: () => ++t,
    runTurn: async (run) => {
      runs.push(run);
      const step = opts.script?.(run);
      if (step instanceof Error) throw step;
      if (step === 'hang')
        return new Promise((_, reject) => run.input.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      if (step === 'end') run.input.dialogue.end('We agree');
      return { text: `${run.participant.agent.label} says turn ${run.turn}`, tokens: 100, ...(typeof step === 'object' ? step : {}) };
    },
  });
  return { c, runs };
}

describe('the dialogue state machine', () => {
  it('defaults to a 10-turn stretch, then pauses asking Continue?', async () => {
    const { c, runs } = chair();
    const d = c.start({ topic: 'tabs or spaces', participants: [claude, codex] });
    expect(d.turnCap).toBe(DEFAULT_TURN_CAP);
    await c.settled(d.id);
    const after = c.get(d.id)!;
    expect(after.status).toBe('paused');
    expect(after.note).toMatch(/continue\?/);
    expect(runs).toHaveLength(10);
    // Turns alternate and are labeled per agent.
    expect(after.turns.map((x) => x.by)).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
    expect(after.turns[1]!.text).toBe('Codex says turn 2');
  });

  it('continues for another stretch (a cap set at start)', async () => {
    const { c, runs } = chair();
    const d = c.start({ topic: 'x', participants: [claude, codex], turnCap: 2 });
    await c.settled(d.id);
    expect(c.get(d.id)!.status).toBe('paused');
    expect(() => c.start({ id: d.id, topic: 'x', participants: [claude, codex] })).toThrow();
    c.continue(d.id);
    await c.settled(d.id);
    expect(c.get(d.id)!.status).toBe('paused');
    expect(runs.map((r) => r.turn)).toEqual([1, 2, 3, 4]);
    c.continue(d.id, 1);
    await c.settled(d.id);
    expect(runs).toHaveLength(5);
  });

  it('stops instantly: the turn in flight is aborted and dropped', async () => {
    const { c, runs } = chair({ script: (run) => (run.turn === 2 ? 'hang' : {}) });
    const d = c.start({ topic: 'x', participants: [claude, codex] });
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toHaveLength(2);
    const stopped = c.stop(d.id, 'Kayra');
    expect(stopped.status).toBe('stopped');
    expect(runs[1]!.input.signal.aborted).toBe(true);
    await c.settled(d.id);
    expect(c.get(d.id)!.turns).toHaveLength(1);
    expect(c.get(d.id)!.note).toBe('Stopped by Kayra');
    expect(() => c.continue(d.id)).toThrow(/over/);
  });

  it('a late answer after Stop is dropped too', async () => {
    let release: (() => void) | undefined;
    const c = new Chair({
      runTurn: (run) =>
        run.turn === 1
          ? new Promise((resolve) => (release = () => resolve({ text: 'late', tokens: 5 })))
          : Promise.resolve({ text: 'x', tokens: 1 }),
    });
    const d = c.start({ topic: 'x', participants: [claude, codex] });
    c.stop(d.id);
    release?.();
    await c.settled(d.id);
    expect(c.get(d.id)!.turns).toHaveLength(0);
  });

  it('ends when an agent calls end_dialogue, keeping its last word', async () => {
    const { c, runs } = chair({ script: (run) => (run.turn === 3 ? 'end' : {}) });
    const d = c.start({ topic: 'x', participants: [claude, codex] });
    await c.settled(d.id);
    const after = c.get(d.id)!;
    expect(after.status).toBe('ended');
    expect(after.note).toBe('We agree');
    expect(after.turns).toHaveLength(3);
    expect(runs).toHaveLength(3);
  });

  it('halts at the token budget', async () => {
    const { c, runs } = chair({ script: () => ({ tokens: 400 }) });
    const d = c.start({ topic: 'x', participants: [claude, codex], budget: 1000 });
    await c.settled(d.id);
    const after = c.get(d.id)!;
    expect(after.status).toBe('budget');
    expect(after.used).toBe(1200);
    expect(runs).toHaveLength(3);
  });

  it('a turn that fails ends the dialogue with why', async () => {
    const { c } = chair({ script: (run) => (run.turn === 2 ? new Error('no Codex here') : {}) });
    const d = c.start({ topic: 'x', participants: [claude, codex] });
    await c.settled(d.id);
    expect(c.get(d.id)!.status).toBe('failed');
    expect(c.get(d.id)!.note).toMatch(/Turn 2.*no Codex here/);
  });

  it('a person interjecting lands as a turn the next agent reads, without counting toward the cap', async () => {
    const { c, runs } = chair({ script: (run) => (run.turn === 2 ? 'hang' : {}) });
    const d = c.start({ topic: 'x', participants: [claude, codex], turnCap: 2 });
    await new Promise((r) => setTimeout(r, 5));
    c.interject(d.id, 'Talk about cost too', 'Kayra');
    expect(c.get(d.id)!.turns.at(-1)).toMatchObject({ by: 'person', name: 'Kayra', n: 1 });
    // The next turn's prompt carries it.
    const next = turnPrompt(c.get(d.id)!);
    expect(next).toContain('Kayra (a person in the room)');
    expect(next).toContain('Talk about cost too');
    c.stop(d.id);
    expect(runs).toHaveLength(2);
  });

  it('cross-reference is three turns: A, B, A, then done', async () => {
    const { c, runs } = chair();
    const d = c.start({ topic: 'Is X true?', mode: 'cross-reference', participants: [claude, codex], turnCap: 10 });
    await c.settled(d.id);
    expect(c.get(d.id)!.status).toBe('ended');
    expect(runs.map((r) => r.speaker)).toEqual([0, 1, 0]);
  });

  it('two agents alike are told apart; the brief says the turn and the rules', () => {
    const d = createDialogue({ id: 'd', topic: 'x', participants: [claude, claude], budget: 500 }, 1);
    expect([speakerName(d, 0), speakerName(d, 1)]).toEqual(['Claude A', 'Claude B']);
    const brief = dialogueBrief(turnDone(d, { text: 'hi', tokens: 100 }, 2));
    expect(brief).toContain('You are Claude B');
    expect(brief).toContain('turn 2');
    expect(brief).toContain('400 tokens');
    expect(brief).toContain('end_dialogue');
    expect(brief).toContain('read-only');
  });
});

describe('talk mode is read-only', () => {
  const run = async (mode: 'talk' | 'work'): Promise<DialogueTurnRun> => {
    const { c, runs } = chair({ script: () => 'hang' });
    const d = c.start({ topic: 'x', mode, participants: [claude, codex], ...(mode === 'work' ? { worktree: '/w' } : {}) });
    await new Promise((r) => setTimeout(r, 5));
    c.stop(d.id);
    return runs[0]!;
  };
  const policy = { cwd: '/w', roots: ['/w'], autoEdit: true, scope: 'folder' as const };
  const gate = (turn: DialogueTurnRun, tool: string, input: Record<string, unknown>) =>
    gateTool(tool, input, { vetTool: turn.input.vetTool, canUseTool: async () => true }, policy);

  it('a write tool call is denied, even where it would be allowed', async () => {
    const turn = await run('talk');
    expect(await gate(turn, 'Write', { file_path: '/w/a.txt', content: 'x' })).toBe(TALK_READ_ONLY_REASON);
    expect(await gate(turn, 'Edit', { file_path: '/w/a.txt' })).toBe(TALK_READ_ONLY_REASON);
    expect(await gate(turn, 'Bash', { command: 'echo hi > a.txt' })).toBe(TALK_READ_ONLY_REASON);
    expect(await gate(turn, 'Bash', { command: 'rm -rf src' })).toBe(TALK_READ_ONLY_REASON);
    expect(await gate(turn, 'mcp__beluga__send_file', { peer: 'bob', path: '/w/a' })).toBe(TALK_READ_ONLY_REASON);
    // Looking is fine, and so is ending the dialogue.
    expect(await gate(turn, 'Read', { file_path: '/w/a.txt' })).toBeUndefined();
    expect(await gate(turn, 'Bash', { command: 'git log -5' })).toBeUndefined();
    expect(await gate(turn, END_DIALOGUE_TOOL, { reason: 'done' })).toBeUndefined();
  });

  it('work mode keeps its tools in its worktree', async () => {
    const turn = await run('work');
    expect(await gate(turn, 'Write', { file_path: '/w/a.txt', content: 'x' })).toBeUndefined();
    expect(await gate(turn, 'Bash', { command: 'npm test' })).toBeUndefined();
    expect(talkReadOnly('Write', {})).toBe(TALK_READ_ONLY_REASON);
  });

  it('end_dialogue is mounted on the room server only in a dialogue turn, and ends it', async () => {
    const turn = await run('talk');
    const bridge = { selfName: () => 'me', listPeers: () => [] } as unknown as RoomBridge;
    const names = (input: Partial<AgentRunInput>) => runToolSuites(input as AgentRunInput, bridge, new ViewShelf(), '/w').beluga!.tools.map((t) => t.name);
    expect(names({})).not.toContain('end_dialogue');
    expect(names({ dialogue: turn.input.dialogue })).toContain('end_dialogue');
    const tool = runToolSuites({ dialogue: turn.input.dialogue } as AgentRunInput, bridge, new ViewShelf(), '/w').beluga!.tools.find((t) => t.name === 'end_dialogue')!;
    const out = await tool.handler({ reason: 'settled' }, {});
    expect(out.content[0]).toMatchObject({ text: expect.stringMatching(/ends after this turn/) });
  });
});

describe('a dialogue survives a restart', () => {
  it('resumes at the turn that was in flight, with the right speaker', async () => {
    const dir = tmp();
    const first = chair({ dir, script: (run) => (run.turn === 3 ? 'hang' : {}) });
    const d = first.c.start({ topic: 'x', participants: [claude, codex], turnCap: 6 });
    await new Promise((r) => setTimeout(r, 5));
    expect(first.runs.map((r) => r.turn)).toEqual([1, 2, 3]);
    // The daemon goes away mid-turn 3.
    first.c.close();
    await first.c.settled(d.id);

    const second = chair({ dir });
    expect(second.c.get(d.id)!.turns).toHaveLength(2);
    expect(second.runs).toHaveLength(0);
    second.c.resume();
    await second.c.settled(d.id);
    expect(second.runs[0]).toMatchObject({ turn: 3, speaker: 0 });
    expect(second.runs.map((r) => r.turn)).toEqual([3, 4, 5, 6]);
    expect(second.c.get(d.id)!.status).toBe('paused');

    // Paused stays paused across another restart; a stopped one is never resumed.
    const third = chair({ dir });
    third.c.resume();
    expect(third.runs).toHaveLength(0);
    third.c.stop(d.id);
    const fourth = chair({ dir });
    fourth.c.resume();
    expect(fourth.c.get(d.id)!.status).toBe('stopped');
    expect(fourth.runs).toHaveLength(0);
  });
});
