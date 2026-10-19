import { describe, expect, it } from 'vitest';
import { looksUnfinished, parseGraph } from '../src/shared/graph-spec.js';

const ok = (text: string) => {
  const r = parseGraph(text);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe('parseGraph', () => {
  it('reads a small graph and fills in the defaults', () => {
    const { graph, warnings } = ok(JSON.stringify({ nodes: [{ id: 'a', label: 'App' }, { id: 'b', label: 'API', type: 'service' }], edges: [{ from: 'a', to: 'b', label: 'POST /login' }] }));
    expect(warnings).toEqual([]);
    expect(graph.direction).toBe('right');
    expect(graph.nodes.map((n) => n.type)).toEqual(['service', 'service']);
    expect(graph.edges).toEqual([{ id: 'a->b', from: 'a', to: 'b', label: 'POST /login', kind: 'flow' }]);
    expect(graph.steps).toEqual([]);
  });

  it('reads near-miss kinds kindly', () => {
    const { graph } = ok(
      JSON.stringify({
        direction: 'TD',
        nodes: [
          { id: 'db', label: 'Postgres', type: 'DB' },
          { id: 'u', label: 'You', type: 'user' },
          { id: 'x', label: '?', type: 'spaceship' },
        ],
        edges: [{ source: 'u', target: 'db', kind: 'event' }],
      }),
    );
    expect(graph.direction).toBe('down');
    expect(graph.nodes.map((n) => n.type)).toEqual(['database', 'actor', 'service']);
    expect(graph.edges[0]).toMatchObject({ from: 'u', to: 'db', kind: 'async' });
  });

  it('drops edges to missing nodes and duplicate nodes, with warnings', () => {
    const { graph, warnings } = ok(
      JSON.stringify({
        nodes: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'A again' },
        ],
        edges: [
          { from: 'a', to: 'nope' },
          { from: 'a', to: 'a' },
          { from: 'a', to: 'a' },
        ],
      }),
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges.map((e) => e.id)).toEqual(['a->a', 'a->a#2']);
    expect(warnings).toHaveLength(2);
  });

  it('keeps nodes in groups, but not in non-groups or loops', () => {
    const { graph, warnings } = ok(
      JSON.stringify({
        nodes: [
          { id: 'g1', label: 'Cloud', type: 'group' },
          { id: 'g2', label: 'VPC', type: 'group', group: 'g1' },
          { id: 'api', label: 'API', group: 'g2' },
          { id: 'web', label: 'Web', group: 'api' },
          { id: 'g3', label: 'Loop', type: 'group', group: 'g4' },
          { id: 'g4', label: 'Loop 2', type: 'group', group: 'g3' },
        ],
      }),
    );
    const groupOf = Object.fromEntries(graph.nodes.map((n) => [n.id, n.group]));
    expect(groupOf).toMatchObject({ g2: 'g1', api: 'g2', web: undefined });
    expect([groupOf.g3, groupOf.g4].filter(Boolean)).toHaveLength(0);
    expect(warnings.length).toBe(3);
  });

  it('keeps only real ids in a walkthrough step', () => {
    const { graph } = ok(JSON.stringify({ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ id: 'ab', from: 'a', to: 'b' }], steps: [{ title: 'Start', focus: ['a', 'ab', 'ghost'] }] }));
    expect(graph.steps[0]?.focus).toEqual(['a', 'ab']);
  });

  it('says where a schema mistake is', () => {
    const r = parseGraph(JSON.stringify({ nodes: [{ id: 'a' }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^nodes\[0\]\.label/);
  });

  it('fails a graph with no nodes or an empty id', () => {
    expect(parseGraph('{"nodes": []}').ok).toBe(false);
    expect(parseGraph('{"nodes": [{"id": "  ", "label": "x"}]}').ok).toBe(false);
  });

  it('cleans ids the same way everywhere, so references still match', () => {
    const { graph, warnings } = ok(
      JSON.stringify({
        nodes: [
          { id: 'Auth Service', label: 'Auth' },
          { id: 'user@db', label: 'Users' },
        ],
        edges: [{ from: 'Auth Service', to: 'user@db' }],
        steps: [{ title: 'Look', focus: ['Auth Service', 'Auth-Service->user-db'] }],
      }),
    );
    expect(warnings).toEqual([]);
    expect(graph.nodes.map((n) => n.id)).toEqual(['Auth-Service', 'user-db']);
    expect(graph.edges[0]).toMatchObject({ id: 'Auth-Service->user-db', from: 'Auth-Service', to: 'user-db' });
    expect(graph.steps[0]?.focus).toEqual(['Auth-Service', 'Auth-Service->user-db']);
  });

  it('cuts text that is too long instead of failing', () => {
    const { graph } = ok(JSON.stringify({ title: 'T'.repeat(300), nodes: [{ id: 'a', label: 'L'.repeat(200), sublabel: 's'.repeat(500), links: Array.from({ length: 12 }, (_, i) => ({ label: `l${i}`, href: '/x' })) }] }));
    expect(graph.title).toHaveLength(120);
    expect(graph.title?.endsWith('…')).toBe(true);
    expect(graph.nodes[0]?.label).toHaveLength(80);
    expect(graph.nodes[0]?.sublabel).toHaveLength(120);
    expect(graph.nodes[0]?.links).toHaveLength(8);
  });

  it("never takes an object's own machinery for a kind", () => {
    const { graph } = ok(JSON.stringify({ direction: 'constructor', nodes: [{ id: 'a', label: 'A', type: '__proto__' }, { id: 'b', label: 'B', type: 'toString' }], edges: [{ from: 'a', to: 'b', kind: 'constructor' }] }));
    expect(graph.direction).toBe('right');
    expect(graph.nodes.map((n) => n.type)).toEqual(['service', 'service']);
    expect(graph.edges[0]?.kind).toBe('flow');
  });

  it('tells a block still being written from broken JSON', () => {
    const unfinished = parseGraph('{"nodes": [{"id": "a", "label": "A"');
    expect(unfinished).toMatchObject({ ok: false, incomplete: true });
    const broken = parseGraph('{"nodes": [}');
    expect(broken).toMatchObject({ ok: false, incomplete: false });
  });
});

describe('looksUnfinished', () => {
  it('counts brackets outside strings only', () => {
    expect(looksUnfinished('{"a": "}"')).toBe(true);
    expect(looksUnfinished('{"a": "{"}')).toBe(false);
    expect(looksUnfinished('{"a": "x\\"')).toBe(true);
  });
});
