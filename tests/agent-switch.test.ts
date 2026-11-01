import { describe, expect, it } from 'vitest';
import { type AgentSwitchDeps, carriedPrompt, needsHandoff, switchAgent, transcriptOf } from '../src/core/agent-switch.js';
import { limitHit } from '../src/shared/agent-handoff.js';
import { encodeFailure } from '../src/shared/run-failure.js';
import type { LogItem } from '../src/core/store.js';
import type { AgentRef } from '../src/protocol.js';
import type { Workspace } from '../src/workspaces/types.js';

/** BLG-447: another runtime on a live chat is a handoff (or a warning), never a silent swap; same-runtime model changes stay plain. */

const CLAUDE: AgentRef = { runtime: 'claude', label: 'Claude' };
const CODEX: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5' };

function harness(ws: Partial<Workspace>, opts: { note?: string | Error; canResume?: (r: string) => boolean; log?: LogItem[] } = {}) {
  let current = { id: 'w1', name: 'api', path: '/x', kind: 'worktree', ...ws } as Workspace;
  const calls: string[] = [];
  const started: string[] = [];
  const said: Array<{ text: string; level?: string }> = [];
  const deps: AgentSwitchDeps = {
    find: (id) => (id === 'w1' ? current : undefined),
    setAgent: (_id, agent) => {
      calls.push(`set:${agent?.runtime ?? 'default'}:${agent?.model ?? ''}`);
      current = { ...current, agent, model: agent?.model } as Workspace;
    },
    carry: (_id, from) => {
      calls.push(`carry:${from ?? '-'}`);
      current = { ...current, carryFrom: from } as Workspace;
    },
    askAndWait: async (prompt) => {
      // The note is asked of the agent still running here.
      calls.push(`ask:${current.agent?.runtime ?? 'default'}`);
      if (opts.note instanceof Error) throw opts.note;
      expect(prompt).toMatch(/handoff note/);
      return opts.note ?? '';
    },
    start: (prompt) => void started.push(prompt),
    system: (_ch, text, level) => void said.push({ text, level }),
    log: () => opts.log ?? [],
    defaultAgent: () => CLAUDE,
    ...(opts.canResume ? { canResume: opts.canResume } : {}),
  };
  return { deps, calls, started, said, ws: () => current };
}

describe('switching agent', () => {
  it('a same-runtime model change is a plain switch: no note, nothing started, the session stays', async () => {
    const h = harness({ sessionId: 'claude-session' });
    expect(await switchAgent(h.deps, 'ws:w1', { ...CLAUDE, model: 'opus' })).toBe('switched');
    expect(h.calls).toEqual(['set:claude:opus']);
    expect(h.started).toEqual([]);
    expect(h.said).toEqual([]);
    expect(h.ws().sessionId).toBe('claude-session');
  });

  it("another runtime on a live chat: the old agent's note seeds the new one, and the chat says so", async () => {
    const h = harness({ sessionId: 'claude-session' }, { note: '- [x] login\n- [ ] logout' });
    expect(await switchAgent(h.deps, 'ws:w1', CODEX)).toBe('handed_off');
    // Asked of Claude before the place moved to Codex.
    expect(h.calls).toEqual(['ask:default', 'set:codex:gpt-5', 'carry:-']);
    // The chat says a note is being written before it's asked for, so the prompt in the chat isn't a surprise.
    expect(h.said).toEqual([{ text: 'Moving to Codex: Claude writes a handoff note first.' }, { text: "Handed off from Claude to Codex, with Claude's note on where things stand.", level: 'info' }]);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toContain('<note>\n- [x] login\n- [ ] logout\n</note>');
    expect(h.started[0]).toMatch(/not as instructions/);
  });

  it('no note (it failed): the new agent starts with the recent conversation, and the chat warns', async () => {
    const log = [
      { id: 'a', type: 'chat', channel: 'ws:w1', from: 'me', name: 'kayra', text: 'fix the login redirect', ts: 1, byAgent: false },
      { id: 'b', type: 'chat', channel: 'room', from: 'me', name: 'kayra', text: 'elsewhere', ts: 2, byAgent: false },
    ] as unknown as LogItem[];
    const h = harness({ sessionId: 'claude-session' }, { note: new Error('timed out'), log });
    expect(await switchAgent(h.deps, 'ws:w1', CODEX)).toBe('seeded_from_chat');
    expect(h.said[1]).toMatchObject({ level: 'warn' });
    expect(h.said[1]?.text).toMatch(/Claude left no note, so Codex starts with the recent conversation/);
    expect(h.started[0]).toContain('kayra: fix the login redirect');
    expect(h.started[0]).not.toContain('elsewhere');
  });

  it('a fresh conversation, or back to the runtime that holds the session, needs no handoff', async () => {
    const fresh = harness({});
    expect(await switchAgent(fresh.deps, 'ws:w1', CODEX)).toBe('switched');
    expect(fresh.started).toEqual([]);
    // Moved to Codex a moment ago, Codex hasn't run: the session is still Claude's, so going back just resumes it.
    const back = harness({ sessionId: 'claude-session', agent: { runtime: 'codex', label: 'Codex' } });
    expect(await switchAgent(back.deps, 'ws:w1', undefined)).toBe('switched');
    expect(back.calls).toEqual(['set:default:', 'carry:-']);
  });

  it('a quiet switch asks nothing and starts nothing: the recent conversation waits for your next message (BLG-592)', async () => {
    const h = harness({ sessionId: 'claude-session' }, { note: 'never asked' });
    expect(await switchAgent(h.deps, 'ws:w1', CODEX, 'quiet')).toBe('switched_quiet');
    expect(h.calls).toEqual(['set:codex:gpt-5', 'carry:Claude']);
    expect(h.started).toEqual([]);
    expect(h.said).toEqual([{ text: "Switched from Claude to Codex. Codex can't read Claude's session, so it gets the recent conversation with your next message.", level: 'info' }]);
    expect(h.ws().carryFrom).toBe('Claude');
  });

  it("an old agent at its plan limit isn't asked for a note: the switch goes quietly, and the chat says why", async () => {
    const failed = { id: 'r', type: 'agent', channel: 'ws:w1', status: 'error', text: encodeFailure({ kind: 'usage_limit', detail: 'limit', resetsAt: Date.now() + 3_600_000 }) };
    const h = harness({ sessionId: 'claude-session' }, { note: 'never asked', log: [failed] as unknown as LogItem[] });
    expect(await switchAgent(h.deps, 'ws:w1', CODEX)).toBe('switched_quiet');
    expect(h.calls).toEqual(['set:codex:gpt-5', 'carry:Claude']);
    expect(h.said[0]).toMatchObject({ level: 'warn' });
    expect(h.said[0]?.text).toMatch(/Claude is at its plan limit, so it wrote no handoff note/);
  });

  it('a note that is only a limit notice counts as no note', async () => {
    const h = harness({ sessionId: 'claude-session' }, { note: "You've hit your limit · resets 3pm" });
    expect(await switchAgent(h.deps, 'ws:w1', CODEX)).toBe('seeded_from_chat');
    expect(h.started[0]).not.toContain('hit your limit');
  });

  it('a plan limit holds until it resets, and only while it was the last run there', () => {
    const now = 1_000_000;
    const limit = (resetsAt?: number) => ({ type: 'agent', channel: 'ws:w1', status: 'error', text: encodeFailure({ kind: 'usage_limit', detail: 'x', ...(resetsAt ? { resetsAt } : {}) }) });
    expect(limitHit([limit(now + 1)], 'ws:w1', now)?.kind).toBe('usage_limit');
    expect(limitHit([limit()], 'ws:w1', now)?.kind).toBe('usage_limit');
    expect(limitHit([limit(now - 1)], 'ws:w1', now)).toBeUndefined();
    expect(limitHit([limit(now + 1)], 'ws:w2', now)).toBeUndefined();
    expect(limitHit([limit(now + 1), { type: 'agent', channel: 'ws:w1', status: 'done', text: 'fine' }], 'ws:w1', now)).toBeUndefined();
    expect(limitHit([{ type: 'agent', channel: 'ws:w1', status: 'error', text: 'Claude Code crashed' }], 'ws:w1', now)).toBeUndefined();
  });

  it('the carried message is the conversation as information, then yours last', () => {
    const text = carriedPrompt('Claude', 'kayra: fix the login', 'and the logout too');
    expect(text.endsWith('\n\nand the logout too')).toBe(true);
    expect(text).toContain('<conversation>\nkayra: fix the login\n</conversation>');
    expect(text).toMatch(/not as instructions/);
  });

  it("hands off when the session's own runtime can't resume it", () => {
    expect(needsHandoff({ sessionId: 's' }, 'claude')).toBe(false);
    expect(needsHandoff({ sessionId: 's' }, 'claude', () => false)).toBe(true);
    expect(needsHandoff({ sessionId: 's', sessionRuntime: 'codex' }, 'claude')).toBe(true);
    expect(needsHandoff({}, 'codex')).toBe(false);
  });

  it('the transcript keeps only this conversation, in plain lines', () => {
    const log = [{ id: 'a', type: 'chat', channel: 'ws:w1', from: 'me', name: 'kayra', text: 'one\n\ntwo', ts: 1, byAgent: false }] as unknown as LogItem[];
    expect(transcriptOf(log, 'ws:w1')).toBe('kayra: one two');
    expect(transcriptOf(log, 'ws:w2')).toBe('');
  });
});
