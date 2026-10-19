/**
 * GitHub's alerts: a quote that starts with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or
 * `[!CAUTION]` on its own line becomes a callout with that title. A remark plugin over the
 * Markdown tree (no dependencies, so it's tested on its own).
 */

export const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_TITLES: Record<AlertKind, string> = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };

/** The bits of an mdast node this plugin looks at. */
export interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const MARKER = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i;

/** The alert a quote's first line names, and how many characters the marker (with its line break) takes. */
export function parseAlertMarker(text: string): { kind: AlertKind; length: number } | undefined {
  const m = MARKER.exec(text);
  return m ? { kind: m[1]!.toLowerCase() as AlertKind, length: m[0].length } : undefined;
}

/** Drop the first `count` characters from the leading text nodes (the marker can span a few). */
function dropLeading(children: readonly MdNode[], count: number): MdNode[] {
  const out: MdNode[] = [];
  let left = count;
  for (const child of children) {
    if (left > 0 && child.type === 'text') {
      const value = child.value ?? '';
      if (value.length <= left) {
        left -= value.length;
        continue;
      }
      out.push({ ...child, value: value.slice(left) });
      left = 0;
      continue;
    }
    left = 0;
    out.push(child);
  }
  return out;
}

/** The leading text of a paragraph, across its first text nodes. */
const leadingText = (children: readonly MdNode[]): string => {
  const end = children.findIndex((c) => c.type !== 'text');
  return (end < 0 ? children : children.slice(0, end)).map((c) => c.value ?? '').join('');
};

/** A quote as an alert, or undefined when it isn't one. */
export function toAlert(quote: MdNode): MdNode | undefined {
  if (quote.type !== 'blockquote') return undefined;
  const [first, ...rest] = quote.children ?? [];
  if (first?.type !== 'paragraph' || !first.children?.length) return undefined;
  const marker = parseAlertMarker(leadingText(first.children));
  if (!marker) return undefined;
  const remaining = dropLeading(first.children, marker.length);
  const body = remaining.some((c) => c.type !== 'text' || (c.value ?? '').trim()) ? [{ ...first, children: remaining }, ...rest] : rest;
  const title: MdNode = { type: 'paragraph', data: { hProperties: { className: ['markdown-alert-title'] } }, children: [{ type: 'text', value: ALERT_TITLES[marker.kind] }] };
  return {
    ...quote,
    data: { ...quote.data, hName: 'div', hProperties: { className: ['markdown-alert', `markdown-alert-${marker.kind}`] } },
    children: [title, ...body],
  };
}

/** The tree with every alert quote turned into a callout (quotes inside them too). */
export function withAlerts(node: MdNode): MdNode {
  const children = node.children?.map(withAlerts);
  const next = children ? { ...node, children } : node;
  return toAlert(next) ?? next;
}

/** The remark plugin: `remarkPlugins={[remarkAlerts]}`. */
export function remarkAlerts(): (tree: MdNode) => MdNode {
  return (tree) => withAlerts(tree);
}
