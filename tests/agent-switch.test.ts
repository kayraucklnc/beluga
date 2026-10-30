import { describe, expect, it } from 'vitest';
import { type AgentSwitchDeps, needsHandoff, switchAgent, transcriptOf } from '../src/core/agent-switch.js';
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
    expect(h.calls).toEqual(['ask:default', 'set:codex:gpt-5']);
    expect(h.said).toEqual([{ text: "Handed off from Claude to Codex, with Claude's note on where things stand.", level: 'info' }]);
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
    expect(h.said[0]).toMatchObject({ level: 'warn' });
    expect(h.said[0]?.text).toMatch(/Claude left no note, so Codex starts with the recent conversation/);
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
    expect(back.calls).toEqual(['set:default:']);
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
