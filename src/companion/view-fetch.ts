import type { DomainState } from '../core/store.js';
import { fetchSource } from '../core/views/sources.js';
import { type Source, type ViewFetchResult, type ViewQuery, parseView, sourceKey, viewFenceType } from '../shared/view-spec.js';
import { stripCode } from './strip.js';

/**
 * A live view's rows for the phone (BLG-68): the phone never fetches a source itself; it names the
 * view (its conversation, its turn, which block) and the Mac runs the source as the Mac app's
 * window would (src/core/views/sources.ts, view.fetch): the same refusals (credential files, a
 * command that hasn't run before waits for a yes), {{slots}} filled by its controls, paging,
 * sorting and search at the source or here.
 *
 * Only a source written in your own Claude's answer runs (as the window only runs those), and only
 * one that view names (its own, an action's, a control's): the phone can't send a command of its
 * own for the Mac to run.
 */

export interface ViewFetchArgs {
  readonly topic: string;
  readonly turn: string;
  readonly block: number;
  readonly source?: Source;
  readonly query: ViewQuery;
  readonly confirm?: boolean;
  readonly fresh?: boolean;
  readonly text?: boolean;
}

const me = (state: DomainState): string => state.selfId || state.self?.peerId || state.network.self?.peerId || 'me';

/** The sources a view's block names: its own, its actions', its controls' options'. */
export function sourcesOf(blockText: string, lang?: string): Source[] {
  const type = viewFenceType(lang);
  const parsed = parseView(blockText, type && type !== 'any' ? type : undefined);
  if (!parsed.ok) return [];
  const v = parsed.view;
  return [v.source, ...v.actions.map((a) => a.source), v.initial?.source, ...v.controls.flatMap((c) => [c.source, ...(c.options ?? []).map((o) => o.source)])].filter((s): s is Source => Boolean(s));
}

/** The view a phone points at, if it's in your own Claude's answer: its fence and JSON. */
export function blockOf(state: DomainState, a: Pick<ViewFetchArgs, 'topic' | 'turn' | 'block'>): { lang?: string; text: string } {
  const channel = a.topic.startsWith('conv:') ? a.topic.slice(5) : '';
  const item = state.log.find((l) => l.channel === channel && l.id === a.turn);
  if (!item || item.type !== 'agent') throw new Error('That view is no longer there');
  if (item.owner !== me(state)) throw new Error('Only your own Claude’s views run on your Mac');
  const code = stripCode(item.text).code[a.block];
  if (!code?.block || code.block.kind !== 'view') throw new Error('That isn’t a view');
  return { ...(code.lang ? { lang: code.lang } : {}), text: code.block.text };
}

export async function viewFetch(state: DomainState, a: ViewFetchArgs, fetch: typeof fetchSource = fetchSource): Promise<ViewFetchResult> {
  const block = blockOf(state, a);
  const named = sourcesOf(block.text, block.lang);
  const source = a.source ? named.find((s) => sourceKey(s) === sourceKey(a.source!)) : named[0];
  if (!source) throw new Error(a.source ? 'That view doesn’t name this source' : 'That view has no source');
  return fetch(source, a.query, { ...(a.confirm ? { confirm: true } : {}), ...(a.fresh ? { fresh: true } : {}), ...(a.text ? { text: true } : {}) });
}
