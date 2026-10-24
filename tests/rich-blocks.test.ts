import { describe, expect, it } from 'vitest';
import { readFileTree } from '../src/shared/render/file-tree.js';
import { jsonPreview, jsonSize, pathStep, readJson } from '../src/shared/render/json-tree.js';
import { isTerminal, parseAnsi, readTerminal, toneOfLine } from '../src/shared/render/terminal.js';
import { displayMathAt, isMathFence, prepareMath, splitInlineMath } from '../src/shared/render/math.js';
import { mermaidToSpec } from '../src/shared/render/mermaid.js';
import { richFence } from '../src/shared/render/rich-fence.js';
import { planCalendar, planGantt, planHeatmap, scaleColor } from '../src/shared/render/grid-model.js';
import { parseGraph } from '../src/shared/graph-spec.js';
import { parseView } from '../src/shared/view-spec.js';
import { stripCode } from '../src/companion/strip.js';
import { texToSvg, withMath } from '../src/companion/math-svg.js';

describe('file trees (BLG-89)', () => {
  it('reads tree output with a root, notes and depth', () => {
    const t = readFileTree(['src/', '├── index.ts        # entry', '├── lib/', '│   ├── a.ts', '│   └── b.ts  ← new', '└── README.md', '', '2 directories, 4 files'].join('\n'))!;
    expect(t.summary).toBe('2 directories, 4 files');
    expect(t.roots).toHaveLength(1);
    const [src] = t.roots;
    expect(src!.name).toBe('src');
    expect(src!.children.map((c) => c.name)).toEqual(['index.ts', 'lib', 'README.md']);
    expect(src!.children[0]!.note).toBe('entry');
    expect(src!.children[1]!.dir).toBe(true);
    expect(src!.children[1]!.children[1]).toMatchObject({ name: 'b.ts', note: 'new', dir: false });
    expect([t.dirs, t.files]).toEqual([2, 4]);
  });

  it('reads ASCII trees without a root, and three-wide rails', () => {
    const t = readFileTree(['|-- app', '|  |-- main.py', '|  `-- util.py', '`-- setup.py'].join('\n'))!;
    expect(t.roots.map((r) => r.name)).toEqual(['app', 'setup.py']);
    expect(t.roots[0]!.children.map((c) => c.name)).toEqual(['main.py', 'util.py']);
  });

  it('leaves code and lists alone', () => {
    expect(readFileTree('const a = 1;\nconst b = 2;')).toBeUndefined();
    expect(readFileTree('- one\n- two\n  - three')).toBeUndefined();
    expect(readFileTree('├── only one')).toBeUndefined();
  });
});

describe('JSON (BLG-90)', () => {
  it('reads JSON and JSONC, and not other text', () => {
    expect(readJson('{"a": [1, 2]}')!.value).toEqual({ a: [1, 2] });
    expect(readJson('{\n  // a comment\n  "a": 1, /* more */\n  "b": "x // not a comment",\n}')!.value).toEqual({ a: 1, b: 'x // not a comment' });
    expect(readJson('{"a": ')).toBeUndefined();
    expect(readJson('42')).toBeUndefined();
  });

  it('says what a folded value holds', () => {
    expect(jsonSize([1, 2, 3])).toBe('3 items');
    expect(jsonSize({ a: 1 })).toBe('1 key');
    expect(jsonPreview({ id: 1, name: 'x' })).toBe('{ id, name }');
    expect(pathStep('name')).toBe('.name');
    expect(pathStep('odd key')).toBe('["odd key"]');
    expect(pathStep(3)).toBe('[3]');
  });
});

describe('terminal output (BLG-92)', () => {
  it('draws ANSI colors instead of showing them', () => {
    const [line] = parseAnsi('\x1b[1;31mFAIL\x1b[0m src/a.test.ts');
    expect(line).toEqual([{ text: 'FAIL', bold: true, fg: 'red' }, { text: ' src/a.test.ts' }]);
    // Written out, as Claude types them.
    expect(parseAnsi('\\x1b[32mok\\x1b[0m')[0]).toEqual([{ text: 'ok', fg: 'green' }]);
    expect(parseAnsi('\x1b[38;5;196mx')[0]![0]!.fg).toMatch(/^#/);
    // A progress bar's line shows what it wrote last.
    expect(parseAnsi('10%\r50%\r100%')[0]).toEqual([{ text: '100%' }]);
  });

  it('tells a session from a script', () => {
    expect(isTerminal('console', 'anything')).toBe(true);
    expect(isTerminal('bash', '$ npm test\n 3 passed')).toBe(true);
    expect(isTerminal('bash', '$ npm i\n$ npm test')).toBe(false);
    expect(isTerminal('bash', 'npm install\nnpm test')).toBe(false);
    expect(isTerminal('ts', '$ x')).toBe(false);
  });

  it('keeps prompts apart and tones the output', () => {
    const t = readTerminal('user@box:~/app$ npm test\nError: boom\n Tests 3 passed, 0 failed');
    expect(t.lines[0]).toMatchObject({ kind: 'prompt', prompt: 'user@box:~/app$ ', spans: [{ text: 'npm test' }] });
    expect(t.commands).toEqual(['npm test']);
    expect(t.lines[1]!.kind).toBe('error');
    expect(t.lines[2]!.kind).toBe('ok');
    expect(toneOfLine('warning: deprecated')).toBe('warning');
  });
});

describe('math (BLG-91)', () => {
  it('keeps prices as words', () => {
    expect(splitInlineMath('it costs $5 and $10')).toEqual([{ text: 'it costs $5 and $10' }]);
    expect(splitInlineMath('$5-$10 or $x^2$')).toEqual([{ text: '$5-$10 or ' }, { tex: 'x^2' }]);
    expect(splitInlineMath('`$HOME` and $a$')).toEqual([{ text: '`$HOME` and ' }, { tex: 'a' }]);
  });

  it('readies Markdown for remark-math', () => {
    expect(prepareMath('costs $5 and $10, \\(a+b\\) and $c$')).toBe('costs \\$5 and \\$10, $a+b$ and $c$');
    expect(prepareMath('$$E=mc^2$$')).toBe('$$\nE=mc^2\n$$');
    expect(prepareMath('\\[x\\]')).toBe('$$\nx\n$$');
    expect(prepareMath('```sh\necho $HOME $PATH\n```')).toBe('```sh\necho $HOME $PATH\n```');
  });

  it('leaves dollars in code spans alone, however many backticks they use', () => {
    // A table that once turned the rest of an answer into one red KaTeX error.
    const table = [
      '| Claude writes | Draw it as |',
      '|---|---|',
      '| ` ```diff ` blocks | A diff view |',
      '| ` ```mermaid ` | A graph |',
      '| ` ```json ` (large) | A JSON explorer |',
      '| `$…$` / `$$…$$` | Rendered math |',
      '| Terminal output | A log view |',
      '',
      'Screenshots in `.beluga/scratch/` shown inline.',
    ].join('\n');
    expect(prepareMath(table)).toBe(table);
    expect(prepareMath('`` a ` $$ b `` and $x$')).toBe('`` a ` $$ b `` and $x$');
    expect(splitInlineMath('` ```sh ` then $a$')).toEqual([{ text: '` ```sh ` then ' }, { tex: 'a' }]);
    expect(splitInlineMath('`` `$x$` ``')).toEqual([{ text: '`` `$x$` ``' }]);
  });

  it('finds display blocks and math fences', () => {
    expect(displayMathAt(['$$', 'a + b', '$$'], 0)).toEqual({ tex: 'a + b', end: 2 });
    expect(displayMathAt(['$$ unclosed', '', 'x'], 0)).toBeUndefined();
    expect(isMathFence('math', 'x')).toBe(true);
    expect(isMathFence('latex', '\\frac{a}{b}')).toBe(true);
    expect(isMathFence('latex', '\\documentclass{article}')).toBe(false);
  });

  it('typesets for the phone', () => {
    const svg = texToSvg('\\frac{a}{b}', true)!;
    expect(svg.svg).toMatch(/^<svg/);
    expect(svg.svg).toContain('currentColor');
    expect(svg.w).toBeGreaterThan(0);
    expect(texToSvg('\\frac{', false)).toBeNull();
    const prose = withMath(stripCode('Area $\\pi r^2$, price $5.\n\n$$\nx^2\n$$'));
    expect(Object.keys(prose.math ?? {}).sort()).toEqual(['Dx^2', 'I\\pi r^2']);
  });
});

describe('mermaid drawn our way (BLG-88)', () => {
  it('reads a flowchart as a graph', () => {
    const r = mermaidToSpec('flowchart LR\n  A[Web app] -->|POST /login| B(API)\n  B --> C[(Postgres)] & D{OK?}\n  subgraph backend [Backend]\n    B\n    C\n  end\n  D -.-> A');
    expect(r?.kind).toBe('graph');
    const g = parseGraph(JSON.stringify(r!.spec));
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.graph.direction).toBe('right');
    expect(g.graph.nodes.find((n) => n.id === 'C')).toMatchObject({ type: 'database', group: 'backend', label: 'Postgres' });
    expect(g.graph.nodes.find((n) => n.id === 'D')!.type).toBe('decision');
    expect(g.graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['A->B', 'B->C', 'B->D', 'D->A']);
    expect(g.graph.edges[0]!.label).toBe('POST /login');
    expect(g.graph.edges[3]!.kind).toBe('async');
  });

  it('reads sequence, state, ER and class diagrams', () => {
    const seq = mermaidToSpec('sequenceDiagram\n  actor U as User\n  U->>API: login\n  API-->>U: token');
    expect(parseGraph(JSON.stringify(seq!.spec))).toMatchObject({ ok: true, graph: { steps: [{ title: '1. User → API' }, { title: '2. API → User' }] } });
    const st = mermaidToSpec('stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy : start\n  Busy --> [*]');
    expect(parseGraph(JSON.stringify(st!.spec)).ok).toBe(true);
    const er = mermaidToSpec('erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER {\n    string id PK\n    string customer_id FK\n  }');
    const erg = parseGraph(JSON.stringify(er!.spec));
    expect(erg.ok && erg.graph.nodes.find((n) => n.id === 'ORDER')!.fields).toEqual([{ name: 'id', type: 'string', key: 'pk' }, { name: 'customer_id', type: 'string', key: 'fk' }]);
    const cls = mermaidToSpec('classDiagram\n  Animal <|-- Duck\n  class Duck {\n    +swim()\n  }');
    const clg = parseGraph(JSON.stringify(cls!.spec));
    expect(clg.ok && clg.graph.edges[0]).toMatchObject({ from: 'Duck', to: 'Animal', label: 'extends' });
  });

  it('reads pies and gantts as views', () => {
    const pie = mermaidToSpec('pie title Pets\n  "Dogs" : 386\n  "Cats" : 85');
    expect(parseView(JSON.stringify(pie!.spec))).toMatchObject({ ok: true, view: { type: 'chart', chart: 'donut', title: 'Pets' } });
    const gantt = mermaidToSpec('gantt\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :done, d1, 2026-10-01, 5d\n  Code :after d1, 10d');
    const v = parseView(JSON.stringify(gantt!.spec));
    expect(v.ok && v.view.type).toBe('gantt');
    expect(v.ok && v.view.rows).toEqual([
      { task: 'Design', start: '2026-10-01', end: '2026-10-05', section: 'Build', status: 'done' },
      { task: 'Code', start: '2026-10-06', end: '2026-10-15', section: 'Build' },
    ]);
  });

  it('leaves what it does not read to Mermaid', () => {
    expect(mermaidToSpec('mindmap\n  root')).toBeUndefined();
  });
});

describe('which block a fence is', () => {
  it('reads each kind, and leaves code as code', () => {
    expect(richFence('json', '{"a":1}')?.kind).toBe('json');
    expect(richFence('', '[1,2]')?.kind).toBe('json');
    expect(richFence('json', '{"a":')).toBeUndefined();
    expect(richFence('', 'src/\n├── a\n└── b')?.kind).toBe('tree');
    expect(richFence('console', '$ ls\na b')?.kind).toBe('terminal');
    expect(richFence('math', 'x^2')?.kind).toBe('math');
    expect(richFence('mermaid', 'graph TD\nA-->B')?.kind).toBe('mermaid');
    expect(richFence('ts', 'const a = 1')).toBeUndefined();
  });

  it('sends them to the phone (1.9)', () => {
    const p = stripCode('Look:\n\n```\nsrc/\n├── a.ts\n└── b.ts\n```\n\n```json\n{"a":1}\n```\n\n```mermaid\ngraph LR\nA-->B\n```\n\n```ts\nconst x = 1\n```');
    expect(p.code.map((c) => [c.lang, c.block?.kind])).toEqual([
      [undefined, 'tree'],
      ['json', 'json'],
      ['beluga-graph', 'graph'],
      ['ts', undefined],
    ]);
  });
});

describe('gantt, heatmap and calendar views (BLG-93)', () => {
  const view = (spec: object) => {
    const v = parseView(JSON.stringify(spec));
    if (!v.ok) throw new Error(v.error);
    return v.view;
  };

  it('plans a gantt from its rows', () => {
    const v = view({ type: 'gantt', data: [
      { task: 'Design', start: '2026-11-02', end: '2026-11-06', team: 'Web', progress: 60, status: 'done' },
      { task: 'Launch', start: '2026-11-20', team: 'Web' },
      { task: 'API', start: '2026-11-04', end: '2026-11-12', team: 'Server' },
    ] });
    const plan = planGantt(v, v.rows, v.columns, Date.parse('2027-01-01'))!;
    expect(plan.lanes.map((l) => l.name)).toEqual(['Web', 'Server']);
    expect(plan.lanes[0]!.bars[0]).toMatchObject({ label: 'Design', progress: 0.6, status: 'done', milestone: false });
    expect(plan.lanes[0]!.bars[1]!.milestone).toBe(true);
    expect(plan.today).toBeUndefined();
    expect(plan.ticks.length).toBeGreaterThan(1);
  });

  it('reads a chart of kind heatmap as a heatmap, long or wide', () => {
    const long = view({ type: 'chart', chart: 'heatmap', x: 'hour', y: 'day', value: 'n', data: [{ hour: '09', day: 'Mon', n: 4 }, { hour: '10', day: 'Mon', n: 1 }, { hour: '09', day: 'Tue', n: 2 }] });
    expect(long.type).toBe('heatmap');
    const p = planHeatmap(long, long.rows, long.columns)!;
    expect(p.xs).toEqual(['09', '10']);
    expect(p.ys).toEqual(['Mon', 'Tue']);
    expect(p.cells).toEqual([[4, 1], [2, null]]);
    const wide = view({ type: 'heatmap', data: [{ day: 'Mon', a: 1, b: 2 }, { day: 'Tue', a: 3, b: 0 }] });
    expect(planHeatmap(wide, wide.rows, wide.columns)!.cells).toEqual([[1, 2], [3, 0]]);
  });

  it('lays a calendar out in Monday-first weeks', () => {
    const v = view({ type: 'calendar', data: [{ date: '2026-10-01', value: 3 }, { date: '2026-10-01', value: 2 }, { date: '2026-10-14', value: 1 }] });
    const p = planCalendar(v, v.rows, v.columns)!;
    expect(p.weeks.every((w) => w.length === 7)).toBe(true);
    expect(p.weeks[0]![0]!.date).toBe('2026-09-28');
    expect(p.weeks.flat().find((d) => d.date === '2026-10-01')!.value).toBe(5);
    expect([p.total, p.days, p.max]).toEqual([6, 2, 5]);
    expect(p.months[0]!.label).toBe('Oct');
  });

  it('colors a value along a soft scale', () => {
    const scale = ['#000000', '#000010', '#0000ff'];
    expect(scaleColor(null, 0, 10, scale)).toBe('#000000');
    expect(scaleColor(0, 0, 10, scale)).toBe('#000000');
    expect(scaleColor(10, 0, 10, scale)).toBe('#0000ff');
    expect(scaleColor(5, 5, 10, scale)).toBe('#000010');
  });
});
