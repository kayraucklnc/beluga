import { type FileTree, TREE_FENCE, readFileTree } from './file-tree.js';
import { type JsonDoc, JSON_FENCE, readJson } from './json-tree.js';
import { isMathFence } from './math.js';
import { mermaidBlock } from './mermaid.js';
import { isTerminal } from './terminal.js';

/**
 * What a plain fenced block Claude wrote really is, so the screens draw it as that instead of as
 * code: a file tree, JSON, a terminal session, math, or a mermaid diagram (drawn as our own graph
 * or view). Claude doesn't have to ask for any of these: it writes code blocks as it always does.
 * Undefined: just code. Pure: the Mac's chat, its documents and the phone's link read alike.
 */
export type RichFence =
  | { readonly kind: 'tree'; readonly tree: FileTree }
  | { readonly kind: 'json'; readonly doc: JsonDoc }
  | { readonly kind: 'terminal' }
  | { readonly kind: 'math'; readonly tex: string }
  | { readonly kind: 'mermaid'; readonly block: { readonly kind: 'graph' | 'view'; readonly text: string } };

export function richFence(lang: string | undefined, body: string): RichFence | undefined {
  const l = (lang ?? '').toLowerCase();
  if (isMathFence(l, body)) return body.trim() ? { kind: 'math', tex: body.trim() } : undefined;
  if (l === 'mermaid') {
    const block = mermaidBlock(body);
    return block ? { kind: 'mermaid', block } : undefined;
  }
  if (JSON_FENCE.test(l) || (!l && /^\s*[[{]/.test(body))) {
    const doc = readJson(body);
    if (doc) return { kind: 'json', doc };
    if (l) return undefined;
  }
  if (TREE_FENCE.test(l)) {
    const tree = readFileTree(body);
    if (tree) return { kind: 'tree', tree };
  }
  if (isTerminal(l, body)) return { kind: 'terminal' };
  return undefined;
}
