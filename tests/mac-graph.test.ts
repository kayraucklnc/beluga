import { describe, expect, it } from 'vitest';
import { type Graph, parseGraph } from '../src/shared/graph-spec.js';
import { MOCK_GRAPH_ANSWER } from '../src/agent/mock-graphs.js';
import {
  INLINE_MAX_HEIGHT,
  bestLayout,
  connections,
  elkGraph,
  fitZoom,
  fittedHeight,
  handleSides,
  inlineAspect,
  inlineHeight,
  linkGoal,
  longestMiddle,
  midpoint,
  neighborhood,
  nodeBoxes,
  parentsFirst,
  placeLabels,
  placesOf,
  roundedPath,
  routesOf,
  shape,
  stepFocus,
  turned,
} from '../packages/mac/src/components/graph/graph-model.js';
import { layout } from '../packages/mac/src/components/graph/layout.js';

/** Drawing a beluga-graph: the layout request and answer, what lights up, and how tall it sits. */

const graphOf = (json: unknown): Graph => {
  const r = parseGraph(JSON.stringify(json));
  if (!r.ok) throw new Error(r.error);
  return r.graph;
};

const small = graphOf({
  nodes: [
    { id: 'web', type: 'client', label: 'Web' },
    { id: 'g', type: 'group', label: 'Backend' },
    { id: 'api', label: 'API', group: 'g' },
    { id: 'db', type: 'database', label: 'DB', group: 'g' },
    { id: 'note', type: 'note', label: 'Slow' },
  ],
  edges: [
    { from: 'web', to: 'api', label: 'POST /x', kind: 'call' },
    { from: 'api', to: 'db', kind: 'data' },
    { from: 'note', to: 'db', kind: 'depends' },
  ],
  steps: [{ title: 'Ask', focus: ['web', 'api'] }, { title: 'Store', focus: ['api->db'] }],
});

const demo = (): Graph => {
  const json = /```beluga-graph\n([\s\S]*?)```/.exec(MOCK_GRAPH_ANSWER)?.[1] ?? '';
  const r = parseGraph(json);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
};

describe('graph layout request', () => {
  it('nests groups, sizes nodes and labels, and wraps only when asked', () => {
    const elk = elkGraph(small, new Map([['api', { width: 200, height: 60 }]]));
    expect(elk.layoutOptions?.['elk.direction']).toBe('RIGHT');
    expect(elk.children?.map((c) => c.id)).toEqual(['web', 'g', 'note']);
    const group = elk.children?.find((c) => c.id === 'g');
    expect(group?.children?.map((c) => [c.id, c.width])).toEqual([
      ['api', 200],
      ['db', 180],
    ]);
    expect(elk.edges?.[0]?.labels?.[0]).toMatchObject({ text: 'POST /x', height: 20 });
    expect(elk.layoutOptions?.['elk.layered.wrapping.strategy']).toBeUndefined();
    expect(elkGraph(small, new Map(), 'down', 2).layoutOptions).toMatchObject({ 'elk.direction': 'DOWN', 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.aspectRatio': '2.00' });
  });

  it('makes room for labels between layers only across (down, a label sits on its line)', () => {
    expect(elkGraph(small, new Map(), 'right').edges?.[0]?.labels).toHaveLength(1);
    expect(elkGraph(small, new Map(), 'down').edges?.[0]?.labels).toBeUndefined();
    expect(elkGraph(small, new Map(), 'up').edges?.[0]?.labels).toBeUndefined();
  });

  it('draws an empty group as a box, and uses the quicker placement for busy graphs', () => {
    const lone = graphOf({ nodes: [{ id: 'g', type: 'group', label: 'Empty' }] });
    expect(elkGraph(lone, new Map()).children?.[0]).toEqual({ id: 'g', width: 220, height: 96 });
    expect(elkGraph(small, new Map()).layoutOptions?.['elk.layered.nodePlacement.strategy']).toBe('NETWORK_SIMPLEX');
    const busy = graphOf({ nodes: Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, label: 'n' })), edges: Array.from({ length: 80 }, (_, i) => ({ from: `n${i % 20}`, to: `n${(i * 7) % 20}` })) });
    expect(elkGraph(busy, new Map()).layoutOptions?.['elk.layered.nodePlacement.strategy']).toBe('BRANDES_KOEPF');
  });

  it('turns lines to the sides that suit the direction', () => {
    expect(handleSides('right')).toEqual({ source: 'right', target: 'left' });
    expect(handleSides('down')).toEqual({ source: 'bottom', target: 'top' });
    expect(handleSides('left')).toEqual({ source: 'left', target: 'right' });
    expect(handleSides('up')).toEqual({ source: 'top', target: 'bottom' });
  });

  it('puts groups before what is in them', () => {
    const g = graphOf({ nodes: [{ id: 'a', label: 'A', group: 'inner' }, { id: 'inner', type: 'group', label: 'I', group: 'outer' }, { id: 'outer', type: 'group', label: 'O' }] });
    expect(parentsFirst(g.nodes).map((n) => n.id)).toEqual(['outer', 'inner', 'a']);
  });
});

describe('ELK answer', () => {
  it('reads places relative to their group and routes in graph coordinates', () => {
    const out = {
      id: 'root',
      children: [{ id: 'a', x: 10, y: 20, width: 100, height: 40 }, { id: 'G', x: 200, y: 10, width: 300, height: 120, children: [{ id: 'b', x: 20, y: 40, width: 100, height: 40 }] }],
      edges: [
        { id: 'ab', container: 'root', sections: [{ startPoint: { x: 110, y: 40 }, endPoint: { x: 220, y: 70 }, bendPoints: [{ x: 160, y: 40 }, { x: 160, y: 70 }] }], labels: [{ x: 0, y: 0, width: 10, height: 10 }] },
        { id: 'bb', container: 'G', sections: [{ startPoint: { x: 120, y: 60 }, endPoint: { x: 140, y: 60 } }] },
      ],
    };
    expect(placesOf(out).get('b')).toEqual({ x: 20, y: 40, width: 100, height: 40 });
    const routes = routesOf(out);
    expect(routes.get('ab')?.points).toHaveLength(4);
    expect(routes.get('ab')?.label).toEqual({ x: 190, y: 70 });
    expect(routes.get('bb')).toEqual({ points: [{ x: 320, y: 70 }, { x: 340, y: 70 }] });
  });

  it('rounds corners without overshooting short stretches', () => {
    expect(roundedPath([])).toBe('');
    expect(roundedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe('M0,0 L10,0');
    expect(roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }])).toBe('M0,0 L91,0 Q100,0 100,9 L100,100');
    expect(roundedPath([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 100 }])).toContain('L2,0 Q4,0 4,2');
  });

  it('places labels ELK left alone on their lines, clear of each other and of nodes', () => {
    const routes = new Map([
      ['a', { points: [{ x: 100, y: 0 }, { x: 100, y: 200 }] }],
      ['b', { points: [{ x: 130, y: 0 }, { x: 130, y: 200 }] }],
      ['c', { points: [{ x: 300, y: 0 }, { x: 300, y: 200 }], label: { x: 300, y: 50 } }],
    ]);
    const labels = new Map([['a', 'payment_intent.succeeded'], ['b', 'INSERT pending'], ['c', 'kept']]);
    const out = placeLabels(routes, labels, []);
    expect(out.get('a')?.label).toEqual({ x: 100, y: 100 });
    // Side by side with the first: it moves along its line.
    expect(out.get('b')?.label).toEqual({ x: 130, y: 70 });
    expect(out.get('c')?.label).toEqual({ x: 300, y: 50 });
    // A node across the middle: the label moves off it.
    expect(placeLabels(routes, labels, [{ x: 0, y: 90, width: 60, height: 20 }]).get('a')?.label).toEqual({ x: 100, y: 70 });
    const nested = { id: 'root', children: [{ id: 'g', x: 10, y: 10, children: [{ id: 'n', x: 5, y: 5, width: 20, height: 10 }] }] };
    expect(nodeBoxes(nested)).toEqual([{ x: 15, y: 15, width: 20, height: 10 }]);
  });

  it('finds the middle of a line and of its longest stretch', () => {
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 100 }];
    expect(midpoint(line)).toEqual({ x: 10, y: 45 });
    expect(longestMiddle(line)).toEqual({ x: 10, y: 50 });
  });

  it('lays the demo graph out with every node placed and every line routed', async () => {
    const g = demo();
    const out = await layout(elkGraph(g, new Map(), g.direction, 1.8));
    const places = placesOf(out);
    for (const n of g.nodes) expect(places.has(n.id)).toBe(true);
    const routes = routesOf(out);
    for (const e of g.edges) expect(routes.get(e.id)?.points.length).toBeGreaterThanOrEqual(2);
    expect(out.width).toBeGreaterThan(0);
  });
});

describe('which layout reads best', () => {
  const frame = { width: 700, height: INLINE_MAX_HEIGHT };
  const across = { direction: 'right' as const, wrapped: false, size: { width: 2800, height: 340 } };
  const down = { direction: 'down' as const, wrapped: false, size: { width: 500, height: 990 } };
  const wrappedAcross = { direction: 'right' as const, wrapped: true, size: { width: 1500, height: 720 } };

  it('fits a size into a frame, never bigger than life', () => {
    expect(fitZoom({ width: 200, height: 100 }, frame)).toBe(1);
    expect(fitZoom({ width: 1360, height: 100 }, { width: 700, height: 500 })).toBeCloseTo(0.5);
    expect(turned('right')).toBe('down');
    expect(turned('up')).toBe('right');
  });

  it('a long graph turns down rather than wrapping back across the card', () => {
    expect(bestLayout([across, wrappedAcross, down], frame, 'right')).toBe(down);
  });

  it('keeps the way Claude drew it when that fits, and wraps only when it reads much bigger', () => {
    const fits = { direction: 'right' as const, wrapped: false, size: { width: 600, height: 200 } };
    expect(bestLayout([fits, { ...down, size: { width: 300, height: 400 } }], frame, 'right')).toBe(fits);
    const chainAcross = { direction: 'right' as const, wrapped: false, size: { width: 7000, height: 60 } };
    const chainDown = { direction: 'down' as const, wrapped: false, size: { width: 200, height: 3000 } };
    const chainWrapped = { direction: 'right' as const, wrapped: true, size: { width: 900, height: 600 } };
    expect(bestLayout([chainAcross, chainDown, chainWrapped], frame, 'right')).toBe(chainWrapped);
    expect(bestLayout([], frame, 'right')).toBeUndefined();
  });

  it('lays the demo graph out down, unwrapped, when it sits in a conversation', async () => {
    const g = demo();
    const sizes = new Map(g.nodes.map((n) => [n.id, n.type === 'database' ? { width: 230, height: 190 } : { width: 200, height: n.status ? 82 : 52 }]));
    const tries = [
      { direction: 'right' as const, wrapped: false },
      { direction: 'right' as const, wrapped: true },
      { direction: 'down' as const, wrapped: false },
      { direction: 'down' as const, wrapped: true },
    ];
    const laid = await Promise.all(tries.map(async (t) => {
      const out = await layout(elkGraph(g, sizes, t.direction, t.wrapped ? 1.8 : undefined));
      return { ...t, size: { width: out.width ?? 0, height: out.height ?? 0 } };
    }));
    const pick = bestLayout(laid, { width: 700, height: INLINE_MAX_HEIGHT }, 'right');
    expect(pick).toMatchObject({ direction: 'down', wrapped: false });
    expect(fitZoom(pick!.size, { width: 700, height: INLINE_MAX_HEIGHT })).toBeGreaterThan(0.6);
  });
});

describe('what lights up', () => {
  it('a node: its lines, the nodes at their ends, and a group with its contents', () => {
    expect([...neighborhood(small, 'api').nodes].sort()).toEqual(['api', 'db', 'web']);
    expect([...neighborhood(small, 'api').edges]).toEqual(['web->api', 'api->db']);
    expect([...neighborhood(small, 'g').nodes].sort()).toEqual(['api', 'db', 'g']);
  });

  it('a step: what it names, lines between those, and the ends of lines it names', () => {
    const [ask, store] = small.steps;
    expect([...stepFocus(small, ask!).edges]).toEqual(['web->api']);
    expect([...stepFocus(small, store!).nodes].sort()).toEqual(['api', 'db']);
  });

  it('a node’s lines in words, outgoing first', () => {
    expect(connections(small, 'api').map((c) => `${c.verb} ${c.other.label}`)).toEqual(['Sends data to DB', 'Called by Web']);
  });
});

describe('a node’s links', () => {
  it('opens pages, absolute paths, and paths in the workspace on screen (with a line)', () => {
    expect(linkGoal('https://stripe.com/docs', undefined)).toEqual({ kind: 'url', url: 'https://stripe.com/docs' });
    expect(linkGoal('/Users/me/a.md', undefined)).toEqual({ kind: 'local', path: '/Users/me/a.md', dir: false });
    expect(linkGoal('src/server.ts:42', '/w/add-auth/')).toEqual({ kind: 'local', path: '/w/add-auth/src/server.ts', dir: false, line: 42 });
    expect(linkGoal('./src/', '/w/x')).toEqual({ kind: 'local', path: '/w/x/src/', dir: true });
  });

  it('goes nowhere for other schemes, climbing out, or a relative path with no workspace', () => {
    expect(linkGoal('javascript:alert(1)', '/w')).toEqual({ kind: 'none' });
    expect(linkGoal('file:///etc/passwd', '/w')).toEqual({ kind: 'none' });
    expect(linkGoal('../../etc/passwd', '/w')).toEqual({ kind: 'none' });
    expect(linkGoal('src/a.ts', undefined)).toEqual({ kind: 'none' });
  });
});

describe('height in a conversation', () => {
  it('guesses from the shape, within bounds', () => {
    expect(shape(small)).toEqual({ layers: 3, widest: 2 });
    const h = inlineHeight(small, 700);
    expect(h).toBeGreaterThanOrEqual(240);
    expect(h).toBeLessThanOrEqual(520);
    const chain = graphOf({ nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, label: `N${i}` })), edges: Array.from({ length: 29 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })) });
    expect(shape(chain).layers).toBe(30);
    expect(inlineHeight(chain, 700)).toBe(240);
  });

  it('fits a laid-out graph across, never too short or too tall', () => {
    expect(fittedHeight({ width: 600, height: 300 }, 700)).toBe(328);
    expect(fittedHeight({ width: 2000, height: 100 }, 700)).toBe(200);
    expect(fittedHeight({ width: 400, height: 2000 }, 700)).toBe(INLINE_MAX_HEIGHT);
    expect(inlineAspect(700)).toBeCloseTo(1.84, 1);
    expect(inlineAspect(3000)).toBe(3);
  });
});
