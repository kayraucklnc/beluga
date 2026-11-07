import type { ThreadChildren } from '../../../src/shared/threads';
import type { ConvSummary, ThreadCountView } from './link/protocol';

/** Child threads as the phone lists them and asks about them (1.43). Pure: no React. */

export interface ConvRow {
  readonly conv: ConvSummary;
  /** How far under the top of the list: its parent's row is just above it. */
  readonly depth: number;
}

/**
 * The rows of a project: each child after its parent, the rest in the order they came. A child whose
 * parent isn't in the list is a row of its own, so nothing the Mac sends drops out.
 */
export function nestRows(convs: readonly ConvSummary[]): ConvRow[] {
  const topics = new Set(convs.map((c) => c.topic));
  const under = new Map<string, ConvSummary[]>();
  for (const c of convs) if (c.parent && topics.has(c.parent)) under.set(c.parent, [...(under.get(c.parent) ?? []), c]);
  const rows: ConvRow[] = [];
  const seen = new Set<string>();
  const add = (conv: ConvSummary, depth: number): void => {
    if (seen.has(conv.topic)) return;
    seen.add(conv.topic);
    rows.push({ conv, depth });
    for (const child of under.get(conv.topic) ?? []) add(child, depth + 1);
  };
  for (const c of convs) if (!c.parent || !topics.has(c.parent)) add(c, 0);
  // Parents that point at each other never come up from the top: they still get a row.
  for (const c of convs) add(c, 0);
  return rows;
}

/**
 * The answer an archive or a delete sends. Undefined: nothing was asked, and the call stays as it
 * was. An older Mac refuses an argument it doesn't know, and keeps the children anyway.
 */
export function branchChildren(supported: boolean, family: ThreadCountView | undefined, too: boolean): ThreadChildren | undefined {
  if (!supported || !family?.count) return undefined;
  return too ? 'with' : 'keep';
}

/** The one question about a chat's threads, in the Mac's words (ThreadsChoice.tsx). */
export function threadsQuestion(action: 'archive' | 'delete', family: ThreadCountView): { readonly label: string; readonly detail: string } {
  const them = `its ${family.count} ${family.count === 1 ? 'thread' : 'threads'}`;
  const working = family.running ? ` ${family.running} ${family.running === 1 ? 'is' : 'are'} working now and would stop.` : '';
  const keep = 'Unticked, they stay as chats of their own and keep working.';
  return action === 'archive'
    ? { label: `Also archive ${them}`, detail: `Restoring links them again.${working} ${keep}` }
    : { label: `Also delete ${them}`, detail: `Deleting a thread loses its folder, its branch and its conversation for good.${working} ${keep}` };
}
