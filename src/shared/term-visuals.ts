import { GRAPH_FENCE, parseGraph } from './graph-spec.js';
import { type ViewType, parseView, viewFenceType } from './view-spec.js';

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
  /** 'graph', or the view's type (table, chart, stats…). */
  readonly kind: 'graph' | ViewType;
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

/** What a link to `block` (a beluga-graph or beluga-view fence) says. */
export function describeVisual(n: number, block: string): TermVisual {
  const fence = splitBlock(block);
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
  return text
    .replace(/[ \t]*`?\[\[visual:(\d{1,6})\]\]`?[ \t]*/g, (_m, n: string) => {
      const block = blockOf(Number(n));
      return block ? `\n\n${block}\n\n` : '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
