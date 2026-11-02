import { GRAPH_FENCE, parseGraph } from './graph-spec.js';
import { VIEW_FENCE, type ViewType, parseView, viewFenceType } from './view-spec.js';

/**
 * Visuals in the agent's terminal (BLG-535). A terminal can't draw a graph or a live table, so in
 * the terminal view the `show` tool keeps the element in the daemon and Claude writes its token,
 * `[[visual:7]]`, on a line of its own. The Mac draws a link over the token, and the element opens
 * in the panel beside the terminal. The chat gets the element itself in place of the token when the
 * terminal's turns come back to it. Browser-safe: the Mac reads tokens with it.
 */

/** A token as Claude writes it: `[[visual:7]]`. */
export const VISUAL_TOKEN = /\[\[visual:(\d{1,6})\]\]/g;
export const visualToken = (n: number): string => `[[visual:${n}]]`;

/** What a link says about the visual behind it, without the visual itself. */
export interface TermVisual {
  readonly n: number;
  /** 'graph', a view's type (table, chart, stats…), or another thing the chat draws (BlockKind). */
  readonly kind: 'graph' | ViewType | BlockKind;
  readonly title: string;
  /** A few words on what's in it: "6 parts · 5 links", "124 rows". */
  readonly meta: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The fence's language and its body (a block as `viewBlock` writes it). */
function splitBlock(block: string): { lang: string; body: string } | undefined {
  const m = /^```([\w-]+)\n([\s\S]*?)\n```\s*$/.exec(block.trim());
  return m ? { lang: m[1]!, body: m[2]! } : undefined;
}

/**
 * Everything else the chat draws, kept the same way (`show_block`): task cards, code from the
 * repository, a PR's comments, a mermaid diagram, a picture, a file tree or other block.
 */
export type BlockKind = 'tasks' | 'source' | 'comments' | 'diagram' | 'image' | 'block';

const OWN_BLOCKS = new Set(['beluga-tasks', 'beluga-code', 'beluga-pr-comments', 'mermaid']);

const BLOCK_TITLES: Readonly<Record<string, string>> = { console: 'Terminal output', shell: 'Terminal output', json: 'JSON', diff: 'Diff', tree: 'Files' };

/** What a link to Markdown the chat draws says (not a graph or a view). */
function describeBlock(n: number, block: string): TermVisual | undefined {
  const text = block.trim();
  const fence = splitBlock(text);
  if (fence?.lang === 'beluga-tasks') {
    const keys = fence.body.split(/[\s,]+/).filter((k) => /^[A-Za-z][A-Za-z0-9]{0,11}-\d{1,6}$/.test(k));
    return { n, kind: 'tasks', title: keys.length === 1 ? keys[0]! : 'Tasks', meta: keys.length > 1 ? `${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ` +${keys.length - 3}` : ''}` : 'task card' };
  }
  if (fence?.lang === 'beluga-code') return { n, kind: 'source', title: fence.body.split('\n')[0]!.trim().slice(0, 80) || 'Code', meta: 'from this repository' };
  if (fence?.lang === 'beluga-pr-comments') return { n, kind: 'comments', title: 'Pull request comments', meta: /show:\s*all/.test(fence.body) ? 'all threads' : 'open threads' };
  if (fence?.lang === 'mermaid') return { n, kind: 'diagram', title: 'Diagram', meta: fence.body.trim().split(/\s/)[0] ?? '' };
  const image = /^!\[([^\]]*)\]\(<?([^)>]+)>?\)$/.exec(text);
  if (image) return { n, kind: 'image', title: image[1]?.trim() || image[2]!.split('/').pop()!, meta: 'picture' };
  if (fence) return { n, kind: 'block', title: BLOCK_TITLES[fence.lang] ?? (fence.lang ? fence.lang.toUpperCase() : 'Text'), meta: plural(fence.body.split('\n').length, 'line') };
  if (splitBlock(text) === undefined && !text.startsWith('```')) return { n, kind: 'block', title: (text.split('\n').find((l) => l.trim()) ?? 'Note').replace(/^#+\s*/, '').slice(0, 60), meta: '' };
  return undefined;
}

/** What a link to `block` (a beluga-graph or beluga-view fence, or other Markdown the chat draws) says. */
export function describeVisual(n: number, block: string): TermVisual {
  const fence = splitBlock(block);
  // The chat's own blocks first: `beluga-code` is code from the repository, not a view of type code.
  if (!fence || OWN_BLOCKS.has(fence.lang) || (fence.lang !== GRAPH_FENCE && !viewFenceType(fence.lang))) {
    const other = describeBlock(n, block);
    if (other) return other;
  }
  if (fence?.lang === GRAPH_FENCE) {
    const g = parseGraph(fence.body);
    if (g.ok) {
      const parts = [plural(g.graph.nodes.filter((x) => x.type !== 'group').length, 'part'), plural(g.graph.edges.length, 'link'), ...(g.graph.steps.length ? [plural(g.graph.steps.length, 'step')] : [])];
      return { n, kind: 'graph', title: g.graph.title || 'Graph', meta: parts.join(' · ') };
    }
    return { n, kind: 'graph', title: 'Graph', meta: '' };
  }
  const fenced = fence ? viewFenceType(fence.lang) : undefined;
  const type = fenced === 'any' ? undefined : fenced;
  const v = fence && fenced ? parseView(fence.body, type) : undefined;
  if (!v?.ok) return { n, kind: type ?? 'table', title: 'View', meta: '' };
  const view = v.view;
  const rows = view.total ?? view.rows.length;
  const meta =
    view.type === 'table'
      ? `${plural(rows, 'row')} · sort, filter, chart`
      : view.type === 'chart'
        ? `${view.chart} chart · ${plural(view.rows.length, 'point')}`
        : view.type === 'stats'
          ? plural(view.items.length, 'tile')
          : view.type === 'code'
            ? (view.filename ?? view.language ?? 'code')
            : view.type === 'colors'
              ? plural(view.rows.length, 'colour')
              : view.type === 'gantt'
                ? plural(view.rows.length, 'bar')
                : plural(view.rows.length, 'value');
  const named: Record<ViewType, string> = { table: 'Table', chart: 'Chart', stats: 'Numbers', code: 'Code', colors: 'Colours', gantt: 'Timeline', heatmap: 'Heatmap', calendar: 'Calendar' };
  return { n, kind: view.type, title: view.title || named[view.type], meta };
}

/** The visuals a text names, in order, each once. */
export function visualsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(VISUAL_TOKEN)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Text for the chat: each token becomes its visual (the fenced block, on lines of its own); a
 * token with no visual behind it goes, as a made-up one does in a run (agent/view-tools.ts).
 */
export function expandVisuals(text: string, blockOf: (n: number) => string | undefined): string {
  if (!text.includes('[[visual:')) return text;
  // A graph or view first written as a fence, then shown again through the tool (the terminal's Stop hook, BLG-555): once is enough.
  const once = text.replace(new RegExp(`^[ \\t]*\`\`\`(?:${GRAPH_FENCE}|${VIEW_FENCE})\\b[^\\n]*\\n[\\s\\S]*?^[ \\t]*\`\`\`[ \\t]*$`, 'gm'), '');
  // A table's first rows, written under its token for the terminal, go: the live table is right there.
  const echo = /(\[\[visual:(\d{1,6})\]\]`?[ \t]*\n)(?:[ \t]*\n)*((?:[ \t]*\|[^\n]*\|[ \t]*(?:\n|$))+)/g;
  const lean = once.replace(echo, (whole, token: string, n: string) => {
    const block = blockOf(Number(n));
    return block && describeVisual(Number(n), block).kind === 'table' ? token : whole;
  });
  return lean
    .replace(/[ \t]*`?\[\[visual:(\d{1,6})\]\]`?[ \t]*/g, (_m, n: string) => {
      const block = blockOf(Number(n));
      return block ? `\n\n${block}\n\n` : '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
