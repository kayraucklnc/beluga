/**
 * ```mermaid blocks drawn our way: read into a `beluga-graph` (flowcharts, state diagrams, ER and
 * class diagrams, sequence diagrams as a walkthrough) or a `beluga-view` (a pie as a chart, a gantt
 * as a gantt), so they look like everything else the window draws and work on the phone too. What
 * isn't read here (mindmaps, journeys…) is left to Mermaid itself on the Mac. Pure.
 */

export type MermaidResult = { readonly kind: 'graph'; readonly spec: Record<string, unknown> } | { readonly kind: 'view'; readonly spec: Record<string, unknown> };

interface GNode {
  id: string;
  type?: string;
  label: string;
  sublabel?: string;
  group?: string;
  status?: string;
  details?: string;
  fields?: { name: string; type?: string; key?: 'pk' | 'fk'; note?: string }[];
}
interface GEdge {
  id?: string;
  from: string;
  to: string;
  label?: string;
  kind?: string;
  emphasis?: boolean;
}

const MAX_TEXT = 60_000;

/** Lines without comments (`%%`) and the front matter / init directives. */
function linesOf(code: string): string[] {
  const body = code.replace(/^\s*---\n[\s\S]*?\n---\s*\n/, '');
  return body
    .split('\n')
    .map((l) => l.replace(/%%.*$/, '').trimEnd())
    .filter((l) => l.trim());
}

/** A label as words: no HTML, no Markdown marks, entities read, `<br>` as a break. */
function words(raw: string): string {
  return raw
    .replace(/^"(.*)"$/s, '$1')
    .replace(/^`(.*)`$/s, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/#quot;/g, '"')
    .replace(/#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/fa:fa-[\w-]+\s*/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\\n/g, '\n')
    .trim();
}

/** A label's first line as the label, the rest as its sublabel. */
function labelled(raw: string): { label: string; sublabel?: string } {
  const [first = '', ...rest] = words(raw)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const sub = rest.join(' · ');
  return { label: first || '·', ...(sub ? { sublabel: sub } : {}) };
}

/** What a node probably is, from its name ("Postgres" a database, "User" an actor). */
function guessKind(label: string): string | undefined {
  const l = label.toLowerCase();
  if (/\b(db|database|postgres(ql)?|mysql|sqlite|mongo(db)?|dynamo(db)?|table|supabase|prisma)\b/.test(l)) return 'database';
  if (/\b(queue|kafka|sqs|rabbit(mq)?|pub\/?sub|nats|stream|topic|event bus)\b/.test(l)) return 'queue';
  if (/\b(redis|cache|memcached?|s3|bucket|storage|blob|cdn)\b/.test(l)) return 'storage';
  if (/\b(user|customer|admin|visitor|client user|person|developer|you)\b/.test(l)) return 'actor';
  if (/\b(browser|web ?app|frontend|front-end|mobile|ios|android|ui|client|app)\b/.test(l)) return 'client';
  if (/\b(stripe|github|google|aws|slack|openai|anthropic|twilio|third[- ]party|external)\b/.test(l)) return 'external';
  return undefined;
}

const STATUS_CLASSES: Readonly<Record<string, string>> = { done: 'done', complete: 'done', completed: 'done', active: 'active', current: 'active', doing: 'active', todo: 'todo', review: 'review', blocked: 'blocked', failed: 'failed', error: 'failed', fail: 'failed', idle: 'idle', crit: 'blocked' };

const cleanId = (raw: string): string => raw.trim().replace(/[^\w.:/-]+/g, '-').slice(0, 64) || 'n';

function finish(title: string | undefined, direction: string, nodes: Map<string, GNode>, edges: GEdge[], extra: Record<string, unknown> = {}): MermaidResult | undefined {
  if (!nodes.size) return undefined;
  return {
    kind: 'graph',
    spec: { ...(title ? { title } : {}), direction, nodes: [...nodes.values()].slice(0, 150), edges: edges.slice(0, 300), ...extra },
  };
}

// ---------------------------------------------------------------- flowchart

const DIRS: Readonly<Record<string, string>> = { TD: 'down', TB: 'down', BT: 'up', LR: 'right', RL: 'left' };

/** Shapes: their opening, closing, and what kind of node they suggest. */
const SHAPES: ReadonlyArray<readonly [string, string, string | undefined]> = [
  ['(((', ')))', 'milestone'],
  ['([', '])', undefined],
  ['[[', ']]', 'function'],
  ['[(', ')]', 'database'],
  ['((', '))', 'milestone'],
  ['{{', '}}', 'function'],
  ['[/', '/]', undefined],
  ['[/', '\\]', undefined],
  ['[\\', '\\]', undefined],
  ['[\\', '/]', undefined],
  ['[', ']', undefined],
  ['(', ')', undefined],
  ['{', '}', 'decision'],
  ['>', ']', 'note'],
];

// A "-" or "." inside an id only between letters or digits ("my-node"), so "A-->B" is an edge.
const ID = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_]|[.-](?=[\p{L}\p{N}_]))*/u;
const EDGE_TEXT = /^\s*(<?)(--|==|-\.)\s+(.+?)\s+(-{2,}[>ox]?|={2,}[>ox]?|\.-+[>ox]?)(?=\s|[\p{L}\p{N}_"])/u;
const EDGE = /^\s*(<?)(-{2,}[>ox]?|={2,}[>ox]?|-\.+-[>ox]?|~{3,})\s*(?:\|([^|]*)\|)?/;

interface Cursor {
  s: string;
  i: number;
}

function readNode(c: Cursor): { id: string; text?: string; shape?: string | undefined; cls?: string } | undefined {
  const rest = c.s.slice(c.i).replace(/^\s+/, '');
  c.i = c.s.length - rest.length;
  const m = ID.exec(rest);
  if (!m) return undefined;
  c.i += m[0].length;
  const out: { id: string; text?: string; shape?: string | undefined; cls?: string } = { id: m[0] };
  for (const [open, close, kind] of SHAPES) {
    if (!c.s.startsWith(open, c.i)) continue;
    let j = c.i + open.length;
    let text: string;
    if (c.s[j] === '"') {
      const q = c.s.indexOf('"', j + 1);
      if (q < 0) continue;
      text = c.s.slice(j, q + 1);
      j = q + 1;
      if (!c.s.startsWith(close, j)) continue;
    } else {
      const end = c.s.indexOf(close, j);
      if (end < 0) continue;
      text = c.s.slice(j, end);
      j = end;
    }
    c.i = j + close.length;
    out.text = text;
    out.shape = kind;
    break;
  }
  const cls = /^:::([\w-]+)/.exec(c.s.slice(c.i));
  if (cls) {
    out.cls = cls[1]!;
    c.i += cls[0].length;
  }
  return out;
}

function readEdge(c: Cursor): { label?: string; kind: string; emphasis: boolean; invisible: boolean; both: boolean } | undefined {
  const rest = c.s.slice(c.i);
  const t = EDGE_TEXT.exec(rest);
  const m = t ? undefined : EDGE.exec(rest);
  const hit = t ?? m;
  if (!hit) return undefined;
  c.i += hit[0].length;
  const arrow = t ? `${t[2]}${t[4]}` : m![2]!;
  const label = t ? t[3] : m![3];
  return {
    ...(label?.trim() ? { label: words(label) } : {}),
    kind: arrow.includes('.') ? 'async' : 'flow',
    emphasis: arrow.includes('='),
    invisible: arrow.startsWith('~'),
    both: hit[1] === '<',
  };
}

function flowchart(lines: string[], header: RegExpExecArray): MermaidResult | undefined {
  const direction = DIRS[(header[2] ?? 'TD').toUpperCase()] ?? 'down';
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const groups: string[] = [];
  const classOf = new Map<string, string>();
  let title: string | undefined;
  const touch = (n: { id: string; text?: string; shape?: string | undefined; cls?: string }): string => {
    const id = cleanId(n.id);
    let node = nodes.get(id);
    if (!node) {
      node = { id, label: n.id, ...(groups.length ? { group: groups.at(-1)! } : {}) };
      nodes.set(id, node);
    } else if (groups.length && node.group === undefined && node.type !== 'group' && id !== groups.at(-1)) {
      // Named inside a subgraph after it was first drawn: it goes in there (as Mermaid does).
      node.group = groups.at(-1)!;
    }
    if (n.text !== undefined) {
      const l = labelled(n.text);
      node.label = l.label;
      if (l.sublabel) node.sublabel = l.sublabel;
    }
    const kind = n.shape ?? guessKind(node.label);
    if (kind && node.type !== 'group') node.type = kind;
    if (n.cls) classOf.set(id, n.cls);
    return id;
  };
  for (const raw of lines.slice(1)) {
    for (const stmt of raw.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
      const line = stmt.trim();
      if (!line) continue;
      const sub = /^subgraph\s+(.+)$/.exec(line);
      if (sub) {
        const spec = sub[1]!.trim();
        const m = /^([^\s[]+)\s*\[(.+)\]$/.exec(spec);
        const id = cleanId(m ? m[1]! : spec.replace(/^"|"$/g, ''));
        const label = words(m ? m[2]! : spec);
        nodes.set(id, { ...nodes.get(id), id, type: 'group', label: label || id, ...(groups.length ? { group: groups.at(-1)! } : {}) });
        groups.push(id);
        continue;
      }
      if (line === 'end') {
        groups.pop();
        continue;
      }
      const cls = /^class\s+([\w,\s-]+?)\s+([\w-]+)$/.exec(line);
      if (cls) {
        for (const id of cls[1]!.split(',')) classOf.set(cleanId(id), cls[2]!);
        continue;
      }
      if (/^(classDef|style|linkStyle|click|direction|accTitle|accDescr)\b/.test(line)) continue;
      const t = /^title\s+(.+)$/.exec(line);
      if (t) {
        title = words(t[1]!);
        continue;
      }
      // A statement: nodes (A & B), then edges to more nodes.
      const c: Cursor = { s: line, i: 0 };
      const group = (): string[] => {
        const ids: string[] = [];
        for (;;) {
          const n = readNode(c);
          if (!n) break;
          ids.push(touch(n));
          const amp = /^\s*&\s*/.exec(c.s.slice(c.i));
          if (!amp) break;
          c.i += amp[0].length;
        }
        return ids;
      };
      let from = group();
      while (from.length) {
        const e = readEdge(c);
        if (!e) break;
        const to = group();
        if (!to.length) break;
        if (!e.invisible) {
          for (const a of from) {
            for (const b of to) {
              edges.push({ from: a, to: b, ...(e.label ? { label: e.label.slice(0, 60) } : {}), kind: e.kind, ...(e.emphasis ? { emphasis: true } : {}) });
              if (e.both) edges.push({ from: b, to: a, kind: e.kind });
            }
          }
        }
        from = to;
      }
    }
  }
  for (const [id, cls] of classOf) {
    const status = STATUS_CLASSES[cls.toLowerCase()];
    const node = nodes.get(id);
    if (status && node && node.type !== 'group') node.status = status;
  }
  return finish(title, direction, nodes, edges);
}

// ---------------------------------------------------------------- state diagram

function stateDiagram(lines: string[]): MermaidResult | undefined {
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const groups: string[] = [];
  let direction = 'down';
  const scope = (): string => groups.at(-1) ?? '';
  const node = (raw: string, end = false): string => {
    if (raw === '[*]') {
      const id = `${scope() ? `${scope()}-` : ''}${end ? 'end' : 'start'}`;
      if (!nodes.has(id)) nodes.set(id, { id, type: 'milestone', label: end ? 'End' : 'Start', ...(scope() ? { group: scope() } : {}) });
      return id;
    }
    const id = cleanId(raw);
    if (!nodes.has(id)) nodes.set(id, { id, label: raw, ...(scope() ? { group: scope() } : {}) });
    return id;
  };
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    const dir = /^direction\s+(\w+)/.exec(line);
    if (dir) {
      if (!groups.length) direction = DIRS[dir[1]!.toUpperCase()] ?? direction;
      continue;
    }
    const comp = /^state\s+(?:"([^"]+)"\s+as\s+)?([\w.-]+)\s*\{$/.exec(line);
    if (comp) {
      const id = cleanId(comp[2]!);
      nodes.set(id, { ...nodes.get(id), id, type: 'group', label: comp[1] ?? comp[2]!, ...(scope() ? { group: scope() } : {}) });
      groups.push(id);
      continue;
    }
    if (line === '}') {
      groups.pop();
      continue;
    }
    const alias = /^state\s+"([^"]+)"\s+as\s+([\w.-]+)/.exec(line);
    if (alias) {
      const id = node(alias[2]!);
      nodes.get(id)!.label = alias[1]!;
      continue;
    }
    const choice = /^state\s+([\w.-]+)\s+<<(choice|fork|join)>>/.exec(line);
    if (choice) {
      const id = node(choice[1]!);
      nodes.get(id)!.type = 'decision';
      continue;
    }
    const tr = /^([\w.-]+|\[\*\])\s*-->\s*([\w.-]+|\[\*\])\s*(?::\s*(.+))?$/.exec(line);
    if (tr) {
      const a = node(tr[1]!);
      const b = node(tr[2]!, true);
      edges.push({ from: a, to: b, ...(tr[3] ? { label: words(tr[3]).slice(0, 60) } : {}) });
      continue;
    }
    const desc = /^([\w.-]+)\s*:\s*(.+)$/.exec(line);
    if (desc) {
      const id = node(desc[1]!);
      const n = nodes.get(id)!;
      n.sublabel = n.sublabel ? `${n.sublabel} · ${words(desc[2]!)}` : words(desc[2]!);
    }
  }
  return finish(undefined, direction, nodes, edges);
}

// ---------------------------------------------------------------- ER diagram

const CARD: Readonly<Record<string, string>> = { '||': 'one', '|o': 'zero or one', 'o|': 'zero or one', '}|': 'one or more', '|{': 'one or more', '}o': 'zero or more', 'o{': 'zero or more' };

function erDiagram(lines: string[]): MermaidResult | undefined {
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  let open: GNode | undefined;
  const entity = (raw: string, alias?: string): GNode => {
    const id = cleanId(raw);
    let n = nodes.get(id);
    if (!n) {
      n = { id, type: 'database', label: alias ?? raw, fields: [] };
      nodes.set(id, n);
    }
    return n;
  };
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (open) {
      if (line === '}') {
        open = undefined;
        continue;
      }
      const f = /^(\S+)\s+(\S+)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+"([^"]*)")?/.exec(line);
      if (f && open.fields!.length < 40) {
        const keys = f[3] ?? '';
        open.fields!.push({ name: f[2]!, type: f[1]!, ...(keys.includes('PK') ? { key: 'pk' as const } : keys.includes('FK') ? { key: 'fk' as const } : {}), ...(f[4] ? { note: f[4].slice(0, 120) } : {}) });
      }
      continue;
    }
    const block = /^([\w-]+)(?:\["([^"]+)"\])?\s*\{$/.exec(line);
    if (block) {
      open = entity(block[1]!, block[2]);
      continue;
    }
    const rel = /^([\w-]+)\s+([|}o][|o{]?)(--|\.\.)([|o][|{o]?)\s+([\w-]+)\s*:\s*(.+)$/.exec(line);
    if (rel) {
      const a = entity(rel[1]!);
      const b = entity(rel[5]!);
      const left = CARD[rel[2]!] ?? '';
      const right = CARD[rel[4]!] ?? '';
      edges.push({ from: a.id, to: b.id, label: words(rel[6]!).slice(0, 60), kind: rel[3] === '..' ? 'depends' : 'data', ...(left && right ? { id: `${a.id}->${b.id}:${edges.length}` } : {}) });
      const last = edges.at(-1)!;
      if (left && right && last.label) last.label = `${last.label} (${left} → ${right})`.slice(0, 60);
      continue;
    }
    const lone = /^([\w-]+)$/.exec(line);
    if (lone) entity(lone[1]!);
  }
  for (const n of nodes.values()) if (!n.fields?.length) delete n.fields;
  return finish(undefined, 'right', nodes, edges);
}

// ---------------------------------------------------------------- class diagram

const REL: ReadonlyArray<readonly [RegExp, string, string, boolean]> = [
  // pattern, label, kind, reversed (the arrow points left)
  [/^<\|--$/, 'extends', 'depends', true],
  [/^--\|>$/, 'extends', 'depends', false],
  [/^<\|\.\.$/, 'implements', 'depends', true],
  [/^\.\.\|>$/, 'implements', 'depends', false],
  [/^\*--$/, 'has', 'data', true],
  [/^--\*$/, 'has', 'data', false],
  [/^o--$/, 'has', 'data', true],
  [/^--o$/, 'has', 'data', false],
  [/^<--$/, 'uses', 'call', true],
  [/^-->$/, 'uses', 'call', false],
  [/^<\.\.$/, 'depends on', 'depends', true],
  [/^\.\.>$/, 'depends on', 'depends', false],
  [/^(--|\.\.)$/, '', 'flow', false],
];

function classDiagram(lines: string[]): MermaidResult | undefined {
  const nodes = new Map<string, GNode>();
  const members = new Map<string, string[]>();
  const edges: GEdge[] = [];
  let open: string | undefined;
  let direction = 'down';
  const cls = (raw: string): string => {
    const name = raw.replace(/~[^~]*~/g, '').replace(/`/g, '');
    const id = cleanId(name);
    if (!nodes.has(id)) nodes.set(id, { id, type: 'function', label: name });
    return id;
  };
  const member = (id: string, text: string): void => {
    const list = members.get(id) ?? [];
    if (list.length < 40) list.push(text.trim());
    members.set(id, list);
  };
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (open) {
      if (line === '}') open = undefined;
      else if (!/^<<.*>>$/.test(line)) member(open, line);
      else nodes.get(open)!.sublabel = line;
      continue;
    }
    const dir = /^direction\s+(\w+)/.exec(line);
    if (dir) {
      direction = DIRS[dir[1]!.toUpperCase()] ?? direction;
      continue;
    }
    const def = /^class\s+([\w~`-]+)(?:\["([^"]+)"\])?\s*(\{)?\s*(?:\})?$/.exec(line);
    if (def) {
      const id = cls(def[1]!);
      if (def[2]) nodes.get(id)!.label = def[2];
      if (def[3] && !line.endsWith('}')) open = id;
      continue;
    }
    const rel = /^([\w~`-]+)\s*(?:"[^"]*"\s*)?(<\|--|--\|>|<\|\.\.|\.\.\|>|\*--|--\*|o--|--o|<--|-->|<\.\.|\.\.>|--|\.\.)\s*(?:"[^"]*"\s*)?([\w~`-]+)\s*(?::\s*(.+))?$/.exec(line);
    if (rel) {
      const a = cls(rel[1]!);
      const b = cls(rel[3]!);
      const [, label, kind, back] = REL.find(([p]) => p.test(rel[2]!)) ?? [undefined, '', 'flow', false];
      const text = rel[4] ? words(rel[4]) : label;
      edges.push({ from: back ? b : a, to: back ? a : b, ...(text ? { label: text.slice(0, 60) } : {}), kind });
      continue;
    }
    const mem = /^([\w~`-]+)\s*:\s*(.+)$/.exec(line);
    if (mem) member(cls(mem[1]!), mem[2]!);
  }
  for (const [id, list] of members) {
    const n = nodes.get(id);
    if (!n) continue;
    const methods = list.filter((m) => m.includes('('));
    const fields = list.filter((m) => !m.includes('('));
    n.sublabel = [n.sublabel, [fields.length && `${fields.length} ${fields.length === 1 ? 'field' : 'fields'}`, methods.length && `${methods.length} ${methods.length === 1 ? 'method' : 'methods'}`].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || undefined!;
    if (!n.sublabel) delete n.sublabel;
    n.details = list.map((m) => `- \`${m.replace(/`/g, '')}\``).join('\n').slice(0, 4000);
  }
  return finish(undefined, direction, nodes, edges);
}

// ---------------------------------------------------------------- sequence diagram

function sequenceDiagram(lines: string[]): MermaidResult | undefined {
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const steps: { title: string; text?: string; focus: string[] }[] = [];
  let title: string | undefined;
  const who = (raw: string, label?: string, actor = false): string => {
    const id = cleanId(raw);
    if (!nodes.has(id)) {
      const name = label ? words(label) : raw;
      nodes.set(id, { id, label: name, type: actor ? 'actor' : (guessKind(name) ?? 'service') });
    } else if (label) nodes.get(id)!.label = words(label);
    return id;
  };
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    const t = /^title\s*:?\s*(.+)$/.exec(line);
    if (t) {
      title = words(t[1]!);
      continue;
    }
    const p = /^(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/.exec(line);
    if (p) {
      who(p[2]!, p[3], p[1] === 'actor');
      continue;
    }
    const m = /^([^\s:+-][^:]*?)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*([+-]?)\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (m) {
      const a = who(m[1]!.trim());
      const b = who(m[4]!.trim());
      const n = steps.length + 1;
      const text = words(m[5]!);
      const reply = m[2]!.startsWith('--');
      if (a !== b && edges.length < 300) {
        const id = `m${n}`;
        edges.push({ id, from: a, to: b, label: `${n}. ${text}`.slice(0, 60), kind: reply ? 'data' : m[2]!.includes(')') ? 'async' : 'call' });
        steps.push({ title: `${n}. ${nodes.get(a)!.label} → ${nodes.get(b)!.label}`.slice(0, 80), ...(text ? { text: text.slice(0, 600) } : {}), focus: [a, b, id] });
      } else steps.push({ title: `${n}. ${nodes.get(a)!.label}`.slice(0, 80), ...(text ? { text: text.slice(0, 600) } : {}), focus: [a] });
      continue;
    }
    const note = /^note\s+(?:over|left of|right of)\s+([^:]+):\s*(.+)$/i.exec(line);
    if (note && steps.length) {
      const last = steps.at(-1)!;
      last.text = `${last.text ? `${last.text}\n\n` : ''}${words(note[2]!)}`.slice(0, 600);
    }
  }
  return finish(title, 'right', nodes, edges, { steps: steps.slice(0, 30) });
}

// ---------------------------------------------------------------- pie and gantt: views

function pie(lines: string[]): MermaidResult | undefined {
  let title = /^pie\b.*?\btitle\s+(.+)$/.exec(lines[0]!)?.[1];
  const data: { label: string; value: number }[] = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    const t = /^title\s+(.+)$/.exec(line);
    if (t) title = t[1];
    const m = /^"([^"]+)"\s*:\s*(-?[\d.]+)/.exec(line);
    if (m) data.push({ label: m[1]!, value: Number(m[2]) });
  }
  if (!data.length) return undefined;
  return { kind: 'view', spec: { type: 'chart', chart: 'donut', ...(title ? { title: words(title) } : {}), x: 'label', y: 'value', data } };
}

const DAY = 86_400_000;
const pad = (n: number): string => String(n).padStart(2, '0');
function iso(t: number, withTime: boolean): string {
  const d = new Date(t);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${day}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}
function parseWhen(s: string): number | undefined {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s.trim());
  if (!m) return undefined;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
}
function duration(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|M|y)$/.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY, M: 30 * DAY, y: 365 * DAY };
  return n * unit[m[2]!]!;
}

function gantt(lines: string[]): MermaidResult | undefined {
  let title: string | undefined;
  let section: string | undefined;
  let last: number | undefined;
  let withTime = false;
  const ends = new Map<string, number>();
  const data: Record<string, string | number | boolean>[] = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (/^(dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|displayMode)\b/.test(line)) {
      if (/^dateFormat\s+.*(HH|hh)/.test(line)) withTime = true;
      continue;
    }
    const t = /^title\s+(.+)$/.exec(line);
    if (t) {
      title = words(t[1]!);
      continue;
    }
    const s = /^section\s+(.+)$/.exec(line);
    if (s) {
      section = words(s[1]!);
      continue;
    }
    const task = /^(.+?)\s*:\s*(.+)$/.exec(line);
    if (!task) continue;
    const parts = task[2]!.split(',').map((p) => p.trim()).filter(Boolean);
    const tags = new Set<string>();
    while (parts.length && /^(done|active|crit|milestone)$/.test(parts[0]!)) tags.add(parts.shift()!);
    let id: string | undefined;
    if (parts.length >= 2 && !parseWhen(parts[0]!) && !/^after\s/.test(parts[0]!) && !duration(parts[0]!)) id = parts.shift();
    let start: number | undefined;
    let end: number | undefined;
    const [a, b] = parts;
    if (parts.length === 1) {
      start = last;
      end = parseWhen(a!) ?? (start !== undefined ? start + (duration(a!) ?? DAY) : undefined);
    } else if (a !== undefined) {
      const after = /^after\s+(.+)$/.exec(a);
      start = after ? Math.max(...after[1]!.split(/\s+/).map((x) => ends.get(x) ?? -Infinity)) : parseWhen(a);
      if (start === -Infinity) start = last;
      end = b !== undefined ? (parseWhen(b) ?? (start !== undefined ? start + (duration(b) ?? DAY) : undefined)) : start;
    }
    if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    last = end;
    if (id) ends.set(id, end);
    data.push({
      task: words(task[1]!),
      start: iso(start, withTime),
      // Mermaid's end is the moment after; a gantt view's end date is the last day.
      end: iso(tags.has('milestone') ? start : withTime ? end : Math.max(start, end - DAY), withTime),
      ...(section ? { section } : {}),
      ...(tags.has('done') ? { status: 'done' } : tags.has('active') ? { status: 'active' } : tags.has('crit') ? { status: 'blocked' } : {}),
      ...(tags.has('milestone') ? { milestone: true } : {}),
    });
  }
  if (!data.length) return undefined;
  return { kind: 'view', spec: { type: 'gantt', ...(title ? { title } : {}), label: 'task', start: 'start', end: 'end', ...(data.some((d) => d.section) ? { group: 'section' } : {}), data } };
}

// ----------------------------------------------------------------

/** A mermaid block as our own graph or view, or undefined when it's a kind we don't read (or empty). */
export function mermaidToSpec(code: string): MermaidResult | undefined {
  if (code.length > MAX_TEXT) return undefined;
  const lines = linesOf(code);
  const first = lines[0]?.trim() ?? '';
  try {
    const flow = /^(flowchart|graph)(?:-elk)?\s*(TD|TB|BT|LR|RL)?\b/i.exec(first);
    if (flow) return flowchart(lines, flow);
    if (/^stateDiagram(-v2)?\b/.test(first)) return stateDiagram(lines);
    if (/^erDiagram\b/.test(first)) return erDiagram(lines);
    if (/^classDiagram(-v2)?\b/.test(first)) return classDiagram(lines);
    if (/^sequenceDiagram\b/.test(first)) return sequenceDiagram(lines);
    if (/^pie\b/.test(first)) return pie(lines);
    if (/^gantt\b/.test(first)) return gantt(lines);
  } catch {
    return undefined;
  }
  return undefined;
}

/** The block's JSON for the screens: a `beluga-graph` or a `beluga-view`, as text. */
export function mermaidBlock(code: string): { readonly kind: 'graph' | 'view'; readonly text: string } | undefined {
  const r = mermaidToSpec(code);
  return r ? { kind: r.kind, text: JSON.stringify(r.spec) } : undefined;
}
