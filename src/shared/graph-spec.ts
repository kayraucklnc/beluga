import { z } from 'zod';

/**
 * `beluga-graph`: the diagrams Claude draws for you (a fenced block of JSON in an answer, a report
 * or a task's brief). Only data, never code: the window lays it out and draws it with its own
 * pieces. Browser-safe (the Mac app parses it; the core teaches Claude the format).
 * Spec and examples: docs/graphs.md.
 */

export const GRAPH_FENCE = 'beluga-graph';

/** A fence tag that holds a graph: `beluga-graph`, or `klaud-graph` from before the rename (older messages and peers). */
export const isGraphFence = (lang: string | undefined): boolean => lang === GRAPH_FENCE || lang === 'klaud-graph';

export const NODE_KINDS = [
  'client',
  'service',
  'database',
  'queue',
  'storage',
  'external',
  'actor',
  'person',
  'function',
  'file',
  'decision',
  'note',
  'task',
  'milestone',
  'image',
  'metric',
  'group',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = ['flow', 'call', 'data', 'async', 'depends', 'blocks'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const STATUSES = ['todo', 'active', 'review', 'done', 'blocked', 'failed', 'idle'] as const;
export type GraphStatus = (typeof STATUSES)[number];

export const DIRECTIONS = ['right', 'down', 'left', 'up'] as const;
export type GraphDirection = (typeof DIRECTIONS)[number];

export const MAX_NODES = 150;
export const MAX_EDGES = 300;
export const MAX_STEPS = 30;

/** An id as written, made safe: other characters become "-" ("Auth Service" → "Auth-Service"). */
export const cleanId = (raw: string): string =>
  raw
    .trim()
    .replace(/[^\w.:/-]+/g, '-')
    .slice(0, 64);
const id = z
  .string()
  .transform(cleanId)
  .refine((v) => v.length > 0, 'an id needs letters or digits');
/** Text that's too long is cut short (with "…") instead of failing the graph. */
const clip = (max: number) => z.string().transform((v) => (v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v));
const short = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .transform((v) => (v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v));
// Claude sometimes writes a near-miss ("Service", "db"): read it kindly, else the default.
const kindOf = <T extends string>(all: readonly T[], aliases: Readonly<Record<string, T>>, fallback: T) =>
  z
    .string()
    .optional()
    .transform((v): T => {
      const k = (v ?? '').trim().toLowerCase();
      // Own keys only: "constructor" or "__proto__" isn't a kind.
      return (all as readonly string[]).includes(k) ? (k as T) : Object.hasOwn(aliases, k) ? aliases[k]! : fallback;
    });

const NODE_ALIASES: Readonly<Record<string, NodeKind>> = {
  db: 'database',
  table: 'database',
  app: 'client',
  ui: 'client',
  frontend: 'client',
  browser: 'client',
  server: 'service',
  api: 'service',
  backend: 'service',
  worker: 'service',
  topic: 'queue',
  stream: 'queue',
  bucket: 'storage',
  cache: 'storage',
  user: 'actor',
  thirdparty: 'external',
  'third-party': 'external',
  fn: 'function',
  method: 'function',
  module: 'file',
  choice: 'decision',
  comment: 'note',
  issue: 'task',
  screenshot: 'image',
  picture: 'image',
  stat: 'metric',
  cluster: 'group',
  boundary: 'group',
};
const EDGE_ALIASES: Readonly<Record<string, EdgeKind>> = {
  request: 'call',
  http: 'call',
  sync: 'call',
  event: 'async',
  message: 'async',
  publish: 'async',
  read: 'data',
  write: 'data',
  dependency: 'depends',
  requires: 'depends',
  blocker: 'blocks',
};

const field = z.object({
  name: short(60),
  type: clip(40).optional(),
  key: z.enum(['pk', 'fk']).optional(),
  note: clip(120).optional(),
});

const link = z.object({ label: short(60), href: short(500) });

/** A node's own steps, drawn inside it in order, each with its status ("Install", "Unit tests"). */
const item = z.object({
  label: short(80),
  status: z.enum(STATUSES).optional(),
  /** A few words at its end ("12s"). */
  note: clip(24).optional(),
});
/** How many of a node's steps are drawn (the rest are counted). */
export const MAX_ITEMS = 40;

const nodeSchema = z.object({
  id,
  type: kindOf(NODE_KINDS, NODE_ALIASES, 'service'),
  label: short(80),
  sublabel: clip(120).optional(),
  tag: clip(24).optional(),
  status: z.enum(STATUSES).optional(),
  group: id.optional(),
  details: clip(4000).optional(),
  fields: z.array(field).transform((a) => a.slice(0, 40)).optional(),
  items: z.array(item).transform((a) => a.slice(0, MAX_ITEMS)).optional(),
  image: clip(500).optional(),
  value: clip(24).optional(),
  links: z.array(link).transform((a) => a.slice(0, 8)).optional(),
  emphasis: z.boolean().optional(),
});

// "source"/"target" (React Flow's words) work as well as "from"/"to".
const edgeSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const e = raw as Record<string, unknown>;
    return { ...e, from: e.from ?? e.source, to: e.to ?? e.target };
  },
  z.object({
    id: id.optional(),
    from: id,
    to: id,
    label: clip(60).optional(),
    kind: kindOf(EDGE_KINDS, EDGE_ALIASES, 'flow'),
    animated: z.boolean().optional(),
    emphasis: z.boolean().optional(),
  }),
);

const stepSchema = z.object({
  title: short(80),
  text: clip(600).optional(),
  // Node ids, and line ids (yours, or "from->to" when a line has none).
  focus: z.array(z.string().max(140)).transform((a) => a.slice(0, 40)).default([]),
});

const graphSchema = z.object({
  version: z.literal(1).optional(),
  title: clip(120).optional(),
  summary: clip(400).optional(),
  direction: kindOf(DIRECTIONS, { lr: 'right', 'left-right': 'right', horizontal: 'right', td: 'down', tb: 'down', 'top-down': 'down', vertical: 'down' }, 'right'),
  nodes: z.array(nodeSchema).min(1).max(MAX_NODES),
  edges: z.array(edgeSchema).max(MAX_EDGES).default([]),
  steps: z.array(stepSchema).max(MAX_STEPS).default([]),
});

export type GraphNode = z.infer<typeof nodeSchema>;
export type GraphField = z.infer<typeof field>;
export type GraphItem = z.infer<typeof item>;
export type GraphEdge = Omit<z.infer<typeof edgeSchema>, 'id'> & { readonly id: string };
export type GraphStep = z.infer<typeof stepSchema>;
export interface Graph {
  readonly title?: string;
  readonly summary?: string;
  readonly direction: GraphDirection;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly steps: readonly GraphStep[];
}

export type GraphParse =
  | { readonly ok: true; readonly graph: Graph; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly incomplete: boolean };

/** Where in the JSON a schema problem is ("nodes[2].label"). */
function pathOf(path: readonly PropertyKey[]): string {
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : `${i ? '.' : ''}${String(p)}`)).join('');
}

/** Whether JSON text stops part-way (a block still being written), rather than being wrong. */
export function looksUnfinished(text: string): boolean {
  const open: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') open.push(c === '{' ? '}' : ']');
    // A closer that doesn't match what's open is a mistake, not a block cut short.
    else if ((c === '}' || c === ']') && open.pop() !== c) return false;
  }
  return inString || open.length > 0;
}

/**
 * A block's JSON → a graph that's safe to draw: every id unique, every edge between real nodes,
 * groups that are groups (no loops). Small mistakes are dropped with a warning instead of
 * failing the whole graph; a graph with nothing left to draw fails.
 */
export function parseGraph(text: string): GraphParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Not valid JSON: ${message}`, incomplete: looksUnfinished(text) };
  }
  const parsed = graphSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? pathOf(issue.path) : '';
    return { ok: false, error: `${where ? `${where}: ` : ''}${issue?.message ?? 'not a graph'}`, incomplete: false };
  }
  return { ok: true, ...tidy(parsed.data) };
}

function tidy(g: z.infer<typeof graphSchema>): { graph: Graph; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const nodes: GraphNode[] = [];
  for (const n of g.nodes) {
    if (seen.has(n.id)) warnings.push(`Two nodes are called "${n.id}"; the second is left out`);
    else (seen.add(n.id), nodes.push(n));
  }
  const groups = new Set(nodes.filter((n) => n.type === 'group').map((n) => n.id));
  const withGroups = nodes.map((n) => {
    if (n.group === undefined) return n;
    if (!groups.has(n.group) || n.group === n.id || loops(n.id, n.group, nodes)) {
      warnings.push(`"${n.id}" is in "${n.group}", which isn't a group it can be in`);
      const { group: _drop, ...rest } = n;
      return rest;
    }
    return n;
  });
  const edgeIds = new Set<string>();
  const edges: GraphEdge[] = [];
  g.edges.forEach((e, i) => {
    if (!seen.has(e.from) || !seen.has(e.to)) {
      warnings.push(`The line from "${e.from}" to "${e.to}" needs both ends to be nodes`);
      return;
    }
    let edgeId = e.id ?? `${e.from}->${e.to}`;
    if (edgeIds.has(edgeId) || seen.has(edgeId)) edgeId = `${edgeId}#${i}`;
    edgeIds.add(edgeId);
    edges.push({ ...e, id: edgeId });
  });
  const known = new Set([...seen, ...edgeIds]);
  // A step may name an id as it was written ("Auth Service") or as it became ("Auth-Service").
  const steps = g.steps.map((s) => ({ ...s, focus: s.focus.map((f) => (known.has(f) ? f : cleanId(f))).filter((f) => known.has(f)) }));
  return {
    graph: {
      ...(g.title ? { title: g.title } : {}),
      ...(g.summary ? { summary: g.summary } : {}),
      direction: g.direction,
      nodes: withGroups,
      edges,
      steps,
    },
    warnings,
  };
}

/** Whether putting `id` inside `group` would put a group inside itself. */
function loops(id: string, group: string, nodes: readonly GraphNode[]): boolean {
  const parent = new Map(nodes.map((n) => [n.id, n.group]));
  let at: string | undefined = group;
  for (let hops = 0; at !== undefined && hops <= nodes.length; hops++) {
    if (at === id) return true;
    at = parent.get(at);
  }
  return false;
}
