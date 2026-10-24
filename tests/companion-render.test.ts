import { describe, expect, it, vi } from 'vitest';
import { ProseView } from '../src/companion/protocol.js';
import { stripCode } from '../src/companion/strip.js';
import { blockOf, sourcesOf, viewFetch } from '../src/companion/view-fetch.js';
import { type Action, Store, initialState } from '../src/core/store.js';
import { parseGraph } from '../src/shared/graph-spec.js';
import { parseView } from '../src/shared/view-spec.js';

/** What Claude draws in a conversation goes to the phone to be drawn there too (BLG-68). */

const ME = 'me0000000000000000000000000000me';
const VIEW = JSON.stringify({ type: 'table', title: 'Orders', source: { kind: 'sqlite', path: '/Users/k/shop.db', query: 'select * from orders' }, actions: [{ label: 'Refunds', source: { kind: 'sqlite', path: '/Users/k/shop.db', query: 'select * from refunds' } }] });
const GRAPH = JSON.stringify({ title: 'Checkout', nodes: [{ id: 'app', label: 'App', type: 'client' }, { id: 'api', label: 'API' }], edges: [{ from: 'app', to: 'api', label: 'pays' }] });
const ANSWER = ['Here are the orders:', '', '```beluga-view', VIEW, '```', '', 'How it fits:', '```beluga-graph', GRAPH, '```', '', 'And the fix:', '```ts', 'export const x = 1;', '```'].join('\n');

function state(owner = ME) {
  const store = new Store(initialState('room'));
  const run = (a: Action): void => store.dispatch(a);
  run({ type: 'identity', selfId: ME, isHost: true, home: '/Users/k' });
  run({ type: 'agent_event', owner, requestId: 'r1', requester: ME, event: 'started', text: '', ts: 1, channel: 'ws:w1', itemId: 'i-r1' });
  run({ type: 'agent_event', owner, requestId: 'r1', requester: ME, event: 'text', text: ANSWER, ts: 2, channel: 'ws:w1', itemId: 'i-r1' });
  return store.getState();
}

describe('drawn blocks in prose', () => {
  it('go along with their JSON (read by the shared parsers); other code stays a chip', () => {
    const prose = ProseView.parse(stripCode(ANSWER));
    expect(prose.text).toContain('[[code:0]]');
    expect(prose.code.map((c) => [c.lang, c.block?.kind])).toEqual([
      ['beluga-view', 'view'],
      ['beluga-graph', 'graph'],
      ['ts', undefined],
    ]);
    expect(parseView(prose.code[0]!.block!.text).ok).toBe(true);
    expect(parseGraph(prose.code[1]!.block!.text).ok).toBe(true);
    expect(JSON.stringify(prose)).not.toContain('export const x');
  });
});

describe('a live view’s rows, through the Mac', () => {
  const query = { offset: 0, limit: 10 };

  it('runs a source the view names, in your own Claude’s answer, as view.fetch would', async () => {
    const fetch = vi.fn(async () => ({ rows: [{ id: 1 }], columns: ['id'], hasMore: false, at: 5 }));
    const st = state();
    expect(sourcesOf(blockOf(st, { topic: 'conv:ws:w1', turn: 'i-r1', block: 0 }).text)).toHaveLength(2);
    await expect(viewFetch(st, { topic: 'conv:ws:w1', turn: 'i-r1', block: 0, query, fresh: true }, fetch)).resolves.toMatchObject({ rows: [{ id: 1 }] });
    expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'sqlite', query: 'select * from orders' }), query, { fresh: true });
    // An action's source is one the view names.
    await viewFetch(st, { topic: 'conv:ws:w1', turn: 'i-r1', block: 0, query, source: { kind: 'sqlite', path: '/Users/k/shop.db', query: 'select * from refunds' } }, fetch);
    expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'select * from refunds' }), query, {});
  });

  it('never runs a source of the phone’s own, a graph, or a friend’s Claude’s view', async () => {
    const fetch = vi.fn();
    await expect(viewFetch(state(), { topic: 'conv:ws:w1', turn: 'i-r1', block: 0, query, source: { kind: 'command', command: 'cat ~/.ssh/id_ed25519' } }, fetch)).rejects.toThrow(/doesn’t name/);
    await expect(viewFetch(state(), { topic: 'conv:ws:w1', turn: 'i-r1', block: 1, query }, fetch)).rejects.toThrow(/isn’t a view/);
    await expect(viewFetch(state('bob00000000000000000000000000bob'), { topic: 'conv:ws:w1', turn: 'i-r1', block: 0, query }, fetch)).rejects.toThrow(/own Claude/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
