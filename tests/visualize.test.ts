import { describe, expect, it } from 'vitest';
import { buildGraphAppend } from '../src/agent/graph-prompt.js';
import { createMockBackend } from '../src/agent/mock.js';
import type { RoomBridge } from '../src/agent/types.js';
import { COMMANDS, runCommand, visualizePrompt } from '../src/core/commands.js';
import type { Session } from '../src/core/session.js';
import { EDGE_KINDS, NODE_KINDS, parseGraph } from '../src/shared/graph-spec.js';

/** /visualize and what Claude is told about graphs. */

function fakeSession(shared?: { role: string }) {
  const said: Array<[string, string]> = [];
  const asked: Array<[string, string, boolean]> = [];
  const session = {
    store: { getState: () => ({ planMode: {} }) },
    sharing: { sharedFor: () => shared },
    workspaces: { ensureLoaded: (id: string) => void said.push([`(loaded ${id})`, '']) },
    sendChat: (text: string, _byAgent: boolean, channel: string) => void said.push([text, channel]),
    askOwnClaude: (prompt: string, channel: string, _urgent: boolean, echo: boolean) => void asked.push([prompt, channel, echo]),
  } as unknown as Session;
  return { session, said, asked };
}

describe('/visualize', () => {
  it('is a command with help text', () => {
    expect(COMMANDS.find((c) => c.name === 'visualize')).toMatchObject({ args: '[what]' });
  });

  it('shows what you asked in words and gives Claude the full ask', () => {
    const { session, said, asked } = fakeSession();
    runCommand(session, 'visualize', ['how', 'auth', 'works'], 'ws:1');
    expect(said).toEqual([
      ['(loaded 1)', ''],
      ['Visualize how auth works', 'ws:1'],
    ]);
    expect(asked).toHaveLength(1);
    expect(asked[0]![0]).toContain('Visualize how auth works as an interactive graph');
    expect(asked[0]![0]).toContain('klaud-graph');
    expect(asked[0]!.slice(1)).toEqual(['ws:1', false]);
  });

  it('with nothing named, draws this conversation (or the project)', () => {
    const { session, said, asked } = fakeSession();
    runCommand(session, 'graph', [], 'room');
    expect(said[0]![0]).toBe('Visualize this');
    expect(asked[0]![0]).toContain("what we are working on in this conversation");
  });

  it("says nothing in a workspace you can only follow (askOwnClaude explains why)", () => {
    const { session, said, asked } = fakeSession({ role: 'watch' });
    runCommand(session, 'visualize', ['x'], 'ws:theirs');
    expect(said).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it('the demo Claude answers with a graph that draws cleanly', async () => {
    const answer = await createMockBackend({} as RoomBridge, 0).run({
      prompt: visualizePrompt('how a payment goes through'),
      requesterName: 'kay',
      viaAgent: false,
      context: [],
      scope: 'folder',
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onFileTouched: () => undefined,
      canUseTool: async () => true,
    });
    const block = /```klaud-graph\n([\s\S]*?)```/.exec(answer)?.[1];
    const parsed = parseGraph(block ?? '');
    expect(parsed.ok && parsed.warnings).toEqual([]);
    if (parsed.ok) expect(parsed.graph.steps.length).toBeGreaterThan(2);
  });
});

describe('graph instructions', () => {
  it('name the fence, every node and line kind, and say never to give coordinates', () => {
    const text = buildGraphAppend();
    expect(text).toContain('```klaud-graph');
    for (const k of [...NODE_KINDS, ...EDGE_KINDS]) expect(text).toContain(k);
    expect(text).toMatch(/never give\s+coordinates/);
  });

  it("their example is a graph that parses", () => {
    const example = /```klaud-graph\n([\s\S]*?)```/.exec(buildGraphAppend())?.[1] ?? '';
    const parsed = parseGraph(example);
    expect(parsed.ok && parsed.warnings).toEqual([]);
  });
});
