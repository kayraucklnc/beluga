import type { EdgeKind, Graph, GraphDirection, GraphEdge, GraphNode, GraphStatus, GraphStep, NodeKind } from '../../../../../src/shared/graph-spec.js';

/**
 * The pure half of drawing a `beluga-graph` (no DOM, no React Flow): what each kind looks like,
 * the ELK layout request and its answer, what lights up when you point at a node or step
 * through a walkthrough, and how tall a graph should sit in a conversation.
 */

/** Icons on the app's 16×16 grid with 1.5 strokes (like components/Icon.tsx). */
export const KIND_ICON: Readonly<Record<NodeKind, string>> = {
  client: 'M2.5 3.5h11v7.5h-11z M5.5 13.5h5 M8 11v2.5',
  service: 'M3 3.5h10v3.5H3z M3 9h10v3.5H3z M5.5 5.25h.01 M5.5 10.75h.01',
  database: 'M3 4.25C3 3.3 5.2 2.5 8 2.5s5 .8 5 1.75v7.5c0 .95-2.2 1.75-5 1.75s-5-.8-5-1.75z M3 4.25c0 .95 2.2 1.75 5 1.75s5-.8 5-1.75 M3 8c0 .95 2.2 1.75 5 1.75S13 8.95 13 8',
  queue: 'M2.5 5h11 M2.5 8h11 M2.5 11h11 M11 3l2.5 2-2.5 2',
  storage: 'M2.5 5.5h11v7h-11z M3.5 3.5h9 M6.5 8.5h3',
  external: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M2.5 8h11 M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5 M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5',
  actor: 'M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5z M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4',
  person: 'M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5z M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4',
  function: 'M10.5 2.5c-1.8 0-2.3 1-2.6 2.6L6.6 11c-.3 1.6-.8 2.5-2.6 2.5 M5 6.5h5.5',
  file: 'M4 2.5h5l3 3v8H4z M9 2.5v3h3',
  decision: 'M8 2l6 6-6 6-6-6z',
  note: 'M3 2.5h10v7.5L10 13.5H3z M10 13.5V10h3 M5.5 5.5h5 M5.5 8h3',
  task: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M5.75 8l1.6 1.6 3-3.2',
  milestone: 'M4 13.5V2.5 M4 3h8l-2 2.5 2 2.5H4',
  image: 'M2.5 3.5h11v9h-11z M2.5 10.5l3-3 3 3 2-2 3 3 M10.5 6.5h.01',
  metric: 'M2.5 13.5h11 M4.5 11V8 M8 11V4.5 M11.5 11V6.5',
  group: 'M2.5 3.5h11v9h-11z',
};

/** What a kind is called in the details panel. */
export const KIND_NAME: Readonly<Record<NodeKind, string>> = {
  client: 'App',
  service: 'Service',
  database: 'Database',
  queue: 'Queue',
  storage: 'Storage',
  external: 'External',
  actor: 'Actor',
  person: 'Person',
  function: 'Function',
  file: 'File',
  decision: 'Decision',
  note: 'Note',
  task: 'Task',
  milestone: 'Milestone',
  image: 'Picture',
  metric: 'Metric',
  group: 'Group',
};

export type Tone = 'muted' | 'claude' | 'info' | 'ok' | 'warn' | 'error';

export const STATUS_INFO: Readonly<Record<GraphStatus, { readonly label: string; readonly tone: Tone }>> = {
  todo: { label: 'To do', tone: 'muted' },
  active: { label: 'In progress', tone: 'claude' },
  review: { label: 'In review', tone: 'info' },
  done: { label: 'Done', tone: 'ok' },
  blocked: { label: 'Blocked', tone: 'warn' },
  failed: { label: 'Failed', tone: 'error' },
  idle: { label: 'Idle', tone: 'muted' },
};

/** How a line reads in words, for the details panel ("calls", "sends data to"…). */
export const EDGE_VERB: Readonly<Record<EdgeKind, { readonly out: string; readonly in: string }>> = {
  flow: { out: 'Leads to', in: 'Comes from' },
  call: { out: 'Calls', in: 'Called by' },
  data: { out: 'Sends data to', in: 'Gets data from' },
  async: { out: 'Notifies', in: 'Notified by' },
  depends: { out: 'Depends on', in: 'Needed by' },
  blocks: { out: 'Blocks', in: 'Blocked by' },
};

export type Side = 'left' | 'right' | 'top' | 'bottom';

/** Where lines leave and arrive on a node, for the graph's direction. */
export function handleSides(direction: GraphDirection): { readonly source: Side; readonly target: Side } {
  switch (direction) {
    case 'down':
      return { source: 'bottom', target: 'top' };
    case 'left':
      return { source: 'left', target: 'right' };
    case 'up':
      return { source: 'top', target: 'bottom' };
    default:
      return { source: 'right', target: 'left' };
  }
}

const ELK_DIRECTION: Readonly<Record<GraphDirection, string>> = { right: 'RIGHT', down: 'DOWN', left: 'LEFT', up: 'UP' };

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface ElkInput {
  readonly id: string;
  readonly layoutOptions?: Readonly<Record<string, string>>;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly children?: readonly ElkInput[];
  /** Where lines meet a node (relative to it; its `elk.portConstraints` says how fixed). */
  readonly ports?: readonly ElkInput[];
  readonly edges?: ReadonlyArray<{ readonly id: string; readonly sources: readonly string[]; readonly targets: readonly string[]; readonly labels?: ReadonlyArray<{ readonly text: string } & Size> }>;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface ElkOutputEdge {
  readonly id: string;
  /** The group its coordinates are relative to ("root": the whole graph). */
  readonly container?: string;
  readonly sections?: ReadonlyArray<{ readonly startPoint: Point; readonly endPoint: Point; readonly bendPoints?: readonly Point[] }>;
  readonly labels?: ReadonlyArray<{ readonly x?: number; readonly y?: number; readonly width?: number; readonly height?: number }>;
}

export interface ElkOutput {
  readonly id: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly children?: readonly ElkOutput[];
  readonly edges?: readonly ElkOutputEdge[];
}

/** The room a label takes on a line (11px text in a pill). */
export const labelSize = (text: string): Size => ({ width: Math.min(220, Math.round(text.length * 6.2) + 16), height: 20 });

/** Up to how many lines the slower, nicer node placement is used. */
export const SIMPLEX_MAX_EDGES = 60;

/** Room above a group's children for its name. */
export const GROUP_HEAD = 34;

/**
 * The layout request: ELK's layered algorithm with groups as compound nodes, keeping the order
 * Claude wrote things in (so a pipeline reads in the order it was described).
 */
export function elkGraph(graph: Graph, sizes: ReadonlyMap<string, Size>, direction: GraphDirection = graph.direction, aspect?: number): ElkInput {
  const kids = new Map<string | undefined, GraphNode[]>();
  for (const n of graph.nodes) kids.set(n.group, [...(kids.get(n.group) ?? []), n]);
  const toElk = (n: GraphNode): ElkInput => {
    const inner = kids.get(n.id);
    // An empty group is drawn as a box of its own size (ELK would make it nothing).
    if (n.type === 'group' && !inner?.length) return { id: n.id, width: 220, height: 96 };
    if (n.type === 'group') {
      return {
        id: n.id,
        layoutOptions: { 'elk.padding': `[top=${GROUP_HEAD + 8},left=18,bottom=18,right=18]` },
        children: (inner ?? []).map(toElk),
      };
    }
    const size = sizes.get(n.id) ?? { width: 180, height: 56 };
    return { id: n.id, width: size.width, height: size.height };
  };
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': ELK_DIRECTION[direction],
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
      'elk.spacing.nodeNode': '32',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
      'elk.spacing.edgeLabel': '6',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.spacing.edgeEdge': '14',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
      // Network simplex places nodes best but slows down sharply with many lines (seconds past ~60).
      'elk.layered.nodePlacement.strategy': graph.edges.length <= SIMPLEX_MAX_EDGES ? 'NETWORK_SIMPLEX' : 'BRANDES_KOEPF',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
      'elk.padding': '[top=16,left=16,bottom=16,right=16]',
      // A long chain wraps onto more rows (or columns) to suit the frame it's shown in.
      ...(aspect ? { 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.aspectRatio': aspect.toFixed(2), 'elk.layered.wrapping.additionalEdgeSpacing': '16' } : {}),
    },
    children: (kids.get(undefined) ?? []).map(toElk),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to], ...(e.label ? { labels: [{ text: e.label, ...labelSize(e.label) }] } : {}) })),
  };
}

export interface Placed {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** ELK's answer → each node's place (relative to its group, as React Flow wants it). */
export function placesOf(out: ElkOutput): Map<string, Placed> {
  const places = new Map<string, Placed>();
  const walk = (n: ElkOutput): void => {
    for (const c of n.children ?? []) {
      places.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 });
      walk(c);
    }
  };
  walk(out);
  return places;
}

/** Where ELK drew a line: its corners and its label's middle, in the whole graph's coordinates. */
export interface Route {
  readonly points: readonly Point[];
  readonly label?: Point;
}

/** ELK's lines → routes in the graph's coordinates (ELK gives them relative to their group). */
export function routesOf(out: ElkOutput): Map<string, Route> {
  const origin = new Map<string, Point>([[out.id, { x: 0, y: 0 }]]);
  const walk = (n: ElkOutput, at: Point): void => {
    for (const c of n.children ?? []) {
      const abs = { x: at.x + (c.x ?? 0), y: at.y + (c.y ?? 0) };
      origin.set(c.id, abs);
      walk(c, abs);
    }
  };
  walk(out, { x: 0, y: 0 });
  const routes = new Map<string, Route>();
  for (const e of out.edges ?? []) {
    const section = e.sections?.[0];
    if (!section) continue;
    const o = origin.get(e.container ?? out.id) ?? { x: 0, y: 0 };
    const shift = (p: Point): Point => ({ x: p.x + o.x, y: p.y + o.y });
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(shift);
    // ELK makes room for a label beside its line; it sits on the line, on its longest stretch.
    routes.set(e.id, e.labels?.length ? { points, label: longestMiddle(points) } : { points });
  }
  return routes;
}

/** A line through `points` with its corners rounded (never more than half a segment). */
export function roundedPath(points: readonly Point[], radius = 9): string {
  const [first, ...rest] = points;
  if (!first) return '';
  let d = `M${first.x},${first.y}`;
  for (let i = 0; i < rest.length; i++) {
    const p = rest[i]!;
    const prev = i === 0 ? first : rest[i - 1]!;
    const next = rest[i + 1];
    if (!next) {
      d += ` L${p.x},${p.y}`;
      break;
    }
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
    const outLen = Math.hypot(next.x - p.x, next.y - p.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += ` L${p.x},${p.y}`;
      continue;
    }
    const a = { x: p.x - ((p.x - prev.x) / inLen) * r, y: p.y - ((p.y - prev.y) / inLen) * r };
    const b = { x: p.x + ((next.x - p.x) / outLen) * r, y: p.y + ((next.y - p.y) / outLen) * r };
    d += ` L${a.x},${a.y} Q${p.x},${p.y} ${b.x},${b.y}`;
  }
  return d;
}

/** The middle of a line's longest straight stretch. */
export function longestMiddle(points: readonly Point[]): Point {
  let best = { len: -1, at: points[0] ?? { x: 0, y: 0 } };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best.len) best = { len, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
  return best.at;
}

/** The point halfway along a line (where its label goes when ELK didn't place one). */
export function midpoint(points: readonly Point[]): Point {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  let left = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (left <= len && len > 0) {
      const a = points[i]!;
      const b = points[i + 1]!;
      return { x: a.x + ((b.x - a.x) * left) / len, y: a.y + ((b.y - a.y) * left) / len };
    }
    left -= len;
  }
  return points[0] ?? { x: 0, y: 0 };
}

/** Nodes with every group before what's in it (React Flow draws parents first). */
export function parentsFirst(nodes: readonly GraphNode[]): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = (n: GraphNode): number => {
    let d = 0;
    for (let at = n.group; at !== undefined && d <= nodes.length; at = byId.get(at)?.group) d++;
    return d;
  };
  return nodes
    .map((n, i) => ({ n, i, d: depth(n) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.n);
}

export interface Focus {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}

/** A node, its lines and the nodes at their other ends: what lights up when you point at it. */
export function neighborhood(graph: Graph, id: string): Focus {
  const nodes = new Set([id]);
  const edges = new Set<string>();
  for (const e of graph.edges) {
    if (e.from !== id && e.to !== id) continue;
    edges.add(e.id);
    nodes.add(e.from);
    nodes.add(e.to);
  }
  // A group lights up with everything in it.
  for (const n of graph.nodes) if (n.group === id) nodes.add(n.id);
  return { nodes, edges };
}

/**
 * What one walkthrough step shows: the nodes and lines it names, the lines between the nodes it
 * names, and the ends of the lines it names.
 */
export function stepFocus(graph: Graph, step: GraphStep): Focus {
  const named = new Set(step.focus);
  const nodes = new Set(graph.nodes.filter((n) => named.has(n.id)).map((n) => n.id));
  const edges = new Set<string>();
  for (const e of graph.edges) {
    const between = nodes.has(e.from) && nodes.has(e.to);
    if (!named.has(e.id) && !between) continue;
    edges.add(e.id);
    nodes.add(e.from);
    nodes.add(e.to);
  }
  return { nodes, edges };
}

export interface Connection {
  readonly edge: GraphEdge;
  readonly other: GraphNode;
  readonly verb: string;
}

/** A node's lines in words, outgoing first, for the details panel. */
export function connections(graph: Graph, id: string): Connection[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: Connection[] = [];
  const into: Connection[] = [];
  for (const edge of graph.edges) {
    if (edge.from === id && edge.to !== id) {
      const other = byId.get(edge.to);
      if (other) out.push({ edge, other, verb: EDGE_VERB[edge.kind].out });
    } else if (edge.to === id && edge.from !== id) {
      const other = byId.get(edge.from);
      if (other) into.push({ edge, other, verb: EDGE_VERB[edge.kind].in });
    }
  }
  return [...out, ...into];
}

/**
 * How many layers deep the graph goes and how wide its widest layer is (a quick longest-path
 * count, before any layout), for picking a height that suits it.
 */
export function shape(graph: Graph): { readonly layers: number; readonly widest: number } {
  const drawn = graph.nodes.filter((n) => n.type !== 'group');
  const ids = new Set(drawn.map((n) => n.id));
  const rank = new Map(drawn.map((n) => [n.id, 0]));
  // Bellman-Ford style relaxation, capped so cycles stop.
  for (let pass = 0; pass < drawn.length; pass++) {
    let moved = false;
    for (const e of graph.edges) {
      if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
      const want = (rank.get(e.from) ?? 0) + 1;
      if (want > (rank.get(e.to) ?? 0) && want < drawn.length) {
        rank.set(e.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const perLayer = new Map<number, number>();
  for (const r of rank.values()) perLayer.set(r, (perLayer.get(r) ?? 0) + 1);
  return { layers: Math.max(1, perLayer.size), widest: Math.max(1, ...perLayer.values()) };
}

/** How tall a laid-out graph sits in a conversation of `width`: its own shape, shrunk to fit across. */
export function fittedHeight(laid: Size, width: number): number {
  const scale = Math.min(1, (width - 24) / Math.max(1, laid.width));
  return Math.round(Math.max(200, Math.min(560, laid.height * scale + 28)));
}

/** The shape a frame `width` wide asks the layout for (wide, not too tall). */
export const inlineAspect = (width: number): number => Math.max(1.2, Math.min(3, width / 380));

/** How tall a graph sits in a conversation of `width` before it's laid out (a guess from its shape). */
export function inlineHeight(graph: Graph, width: number, direction: GraphDirection = graph.direction): number {
  const { layers, widest } = shape(graph);
  const across = direction === 'right' || direction === 'left';
  const groups = graph.nodes.some((n) => n.type === 'group') ? 60 : 0;
  const natural = across ? { w: layers * 250, h: widest * 92 + groups } : { w: widest * 230, h: layers * 120 + groups };
  const scale = Math.min(1, (width - 32) / natural.w);
  return Math.round(Math.max(240, Math.min(520, natural.h * scale + 72)));
}

export type LinkGoal = { readonly kind: 'url'; readonly url: string } | { readonly kind: 'local'; readonly path: string; readonly dir: boolean; readonly line?: number } | { readonly kind: 'none' };

/**
 * Where a node's link goes: a web page, a file or folder on this Mac (absolute, or relative to the
 * workspace on screen, with an optional ":line"), or nowhere (another scheme, or a relative path
 * with no workspace to resolve it in).
 */
export function linkGoal(href: string, workspaceRoot: string | undefined): LinkGoal {
  const raw = href.trim();
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', url: raw };
  if (/^[a-z][\w+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return { kind: 'none' };
  const m = /^(.*?)(?::(\d+))?$/.exec(raw);
  const target = m?.[1] ?? raw;
  const line = m?.[2] ? Number(m[2]) : undefined;
  const absolute = target.startsWith('/') || target.startsWith('~/');
  if (!absolute && !workspaceRoot) return { kind: 'none' };
  const joined = absolute ? target : `${workspaceRoot!.replace(/\/+$/, '')}/${target.replace(/^\.\//, '')}`;
  // No climbing out of the workspace with "..".
  if (!absolute && joined.split('/').includes('..')) return { kind: 'none' };
  return { kind: 'local', path: joined, dir: target.endsWith('/'), ...(line ? { line } : {}) };
}
