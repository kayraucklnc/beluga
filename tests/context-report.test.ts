import { describe, expect, it } from 'vitest';
import { ContextReport, breakdownReader, isCompactCommand, readBreakdown } from '../src/agent/context-report.js';

type Sent = { kind: 'context' | 'compact'; data: Record<string, unknown> };

function report(model?: string) {
  const sent: Sent[] = [];
  const r = new ContextReport((kind, text) => sent.push({ kind, data: JSON.parse(text) as Record<string, unknown> }), model);
  return { r, sent };
}

const assistant = (input: number, cacheRead: number, cacheWrite: number, parent: string | null = null) => ({
  type: 'assistant' as const,
  parent_tool_use_id: parent,
  message: { usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 9_999 } },
});

describe('the live context report', () => {
  it('updates on every response with what the model saw (input + cache), once per change', () => {
    const { r, sent } = report('claude-opus-5-5');
    r.observe(assistant(1_000, 40_000, 2_000));
    r.observe(assistant(1_000, 40_000, 2_000)); // the same response's next block
    r.observe(assistant(800, 50_000, 1_200));
    r.observe(assistant(5_000, 0, 0, 'toolu_sub')); // a sub-agent's turn isn't this conversation's window
    expect(sent).toEqual([
      { kind: 'context', data: { used: 43_000, window: 200_000, model: 'claude-opus-5-5' } },
      { kind: 'context', data: { used: 52_000, window: 200_000, model: 'claude-opus-5-5' } },
    ]);
    expect(r.tokens).toBe(52_000);
  });

  it('uses the long window for a [1m] model as soon as the session starts, and the reported one at the end', async () => {
    const { r, sent } = report();
    r.observe({ type: 'system', subtype: 'init', model: 'claude-opus-5-5[1m]' });
    r.observe(assistant(2_000, 300_000, 0));
    expect(sent.at(-1)!.data).toMatchObject({ used: 302_000, window: 1_000_000 });
    await r.result({ 'claude-opus-5-5': { contextWindow: 1_000_000 }, 'claude-haiku-5-5': { contextWindow: 200_000 } });
    expect(sent.at(-1)!.data).toMatchObject({ used: 302_000, window: 1_000_000 });
  });

  it('adds where the tokens come from when the run ends, if Claude Code can say', async () => {
    const { r, sent } = report();
    r.observe(assistant(0, 90_000, 10_000));
    await r.result({ m: { contextWindow: 200_000 } }, async () => ({ categories: [{ name: 'System prompt', tokens: 10_000, kind: 'used' }, { name: 'Messages', tokens: 90_000, kind: 'used' }], messageBreakdown: { toolResultTokens: 40_000 } }));
    expect(sent.at(-1)!.data).toMatchObject({ used: 100_000, breakdown: { conversation: 50_000, tools: 40_000, system: 10_000 } });
  });

  it('says nothing at the end of a run that saw no usage', async () => {
    const { r, sent } = report();
    await r.result(undefined);
    expect(sent).toEqual([]);
  });

  it('shows Claude Code compacting on its own, then the compaction with the summary from its hook', () => {
    const { r, sent } = report();
    r.observe(assistant(0, 170_000, 0));
    r.observe({ type: 'system', subtype: 'status', status: 'compacting' });
    r.observe({ type: 'system', subtype: 'status', status: 'compacting' }); // said once
    expect(sent.at(-1)).toEqual({ kind: 'context', data: { compacting: true, window: 200_000, used: 170_000 } });
    r.observe({ type: 'system', subtype: 'compact_boundary', uuid: 'b-1', compact_metadata: { trigger: 'auto', pre_tokens: 170_000, post_tokens: 22_000 } });
    expect(sent.at(-1)).toEqual({ kind: 'compact', data: { pre: 170_000, post: 22_000, trigger: 'auto', key: 'b-1', window: 200_000 } });
    r.summary('## Summary\nKept the plan.');
    r.summary('a second summary for the same compaction is ignored');
    expect(sent.at(-1)).toEqual({ kind: 'compact', data: { key: 'b-1', summary: '## Summary\nKept the plan.' } });
    expect(sent.filter((x) => x.kind === 'compact')).toHaveLength(2);
    expect(r.tokens).toBe(22_000);
  });

  it('pairs a summary that arrives before its boundary, or in Claude Code’s continuation message', () => {
    const early = report();
    early.r.summary('Early summary');
    early.r.observe({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 100_000 } });
    expect(early.sent).toEqual([{ kind: 'compact', data: { pre: 100_000, post: 0, trigger: 'manual', key: 'c1', window: 200_000, summary: 'Early summary' } }]);

    const later = report();
    later.r.observe({ type: 'system', subtype: 'compact_boundary', uuid: 'b-2', compact_metadata: { trigger: 'manual', pre_tokens: 90_000, post_tokens: 9_000 } });
    later.r.observe({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'This session is being continued from a previous conversation. Summary: …' }] } });
    later.r.observe({ type: 'user', parent_tool_use_id: null, message: { content: 'an ordinary message' } });
    expect(later.sent.at(-1)).toEqual({ kind: 'compact', data: { key: 'b-2', summary: 'This session is being continued from a previous conversation. Summary: …' } });
    expect(later.sent).toHaveLength(2);
  });

  it('clears "compacting" when Claude Code says the compaction failed', () => {
    const { r, sent } = report();
    r.observe({ type: 'system', subtype: 'status', status: 'compacting' });
    r.observe({ type: 'system', subtype: 'status', status: null, compact_result: 'failed' });
    expect(sent.at(-1)).toEqual({ kind: 'context', data: { compacting: false, window: 200_000 } });
  });
});

describe('compaction helpers', () => {
  it('recognizes /compact so it goes to Claude Code as a command, not wrapped as a request', () => {
    expect(isCompactCommand('/compact')).toBe(true);
    expect(isCompactCommand('  /compact keep the plan')).toBe(true);
    expect(isCompactCommand('/compactify')).toBe(false);
    expect(isCompactCommand('please /compact')).toBe(false);
  });

  it('reads the breakdown briefly, and gives up quietly when it fails or isn’t there', async () => {
    expect(await readBreakdown(async () => { throw new Error('no'); }, 1000)).toBeUndefined();
    expect(breakdownReader({})).toBeUndefined();
    const calls: unknown[] = [];
    const reader = breakdownReader({ getContextUsage: async (opts: unknown) => (calls.push(opts), { categories: [] }) });
    expect(await reader!()).toEqual({ categories: [] });
    expect(calls).toEqual([{ detail: 'summary' }]);
  });
});
