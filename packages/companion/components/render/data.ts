import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSupports } from '../../lib/hooks';
import { calls } from '../../lib/link/calls';
import type { Topic } from '../../lib/link/protocol';
import { type Column, type ControlState, type Row, type Source, type View, type ViewFetchResult, type ViewQuery, columnsFor, initialState, pageOf, resolveControls, sourceKey } from '../../lib/render';
import { store } from '../../lib/store';

/**
 * A view's rows on the phone, as the Mac app's window keeps them (packages/mac use-view-data.ts):
 * a page, sorted and searched; the controls' choices resolved by the shared view-controls. Rows
 * Claude wrote in are paged here. A source never runs on the phone: each page is asked of your Mac
 * (companion.viewFetch), which runs it with the window's own rules; `refresh` asks again on a
 * timer while the view is on screen, and a command that hasn't run before waits for your Run.
 */

/** Where a view sits: its conversation, the turn and which drawn block (what the Mac finds it by). */
export interface BlockAt {
  readonly topic: Topic;
  readonly turn: string;
  readonly block: number;
}

export type Sort = ViewQuery['sort'];

export interface ViewData {
  readonly live: boolean;
  readonly rows: readonly Row[];
  readonly columns: readonly Column[];
  readonly total?: number;
  readonly hasMore: boolean;
  readonly at?: number;
  readonly text?: string;
  readonly loading: boolean;
  readonly error?: string;
  readonly needsApproval?: string;
  readonly page: number;
  readonly pageSize: number;
  readonly sort: Sort;
  readonly search: string;
  readonly controls: ControlState;
  readonly switched: boolean;
  setControl(id: string, value: ControlState[string]): void;
  setPage(n: number): void;
  setSort(s: Sort): void;
  setSearch(s: string): void;
  refresh(): void;
  approve(): void;
  useSource(s: Source | undefined): void;
}

type Got = { key: string; rows: readonly Row[]; columns: readonly string[]; total?: number; hasMore: boolean; at: number; text?: string };

export function useViewData(view: View, at: BlockAt | undefined, opts: { limit?: number; text?: boolean } = {}): ViewData {
  const canFetch = useSupports('viewFetch');
  const [page, setPage] = useState(0);
  const [sort, setSortNow] = useState<Sort>(undefined);
  const [search, setSearchNow] = useState('');
  const [needle, setNeedle] = useState('');
  const [other, setOther] = useState<Source | undefined>(undefined);
  const [got, setGot] = useState<Got>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [ask, setAsk] = useState<string>();
  const [tick, setTick] = useState(0);
  const fresh = useRef(false);
  const confirm = useRef(false);
  const [controls, setControls] = useState<ControlState>(() => initialState(view));
  const [touched, setTouched] = useState(false);
  const patch = useMemo(() => resolveControls(view, controls), [view, controls]);

  const source = other ?? patch.source ?? view.source;
  // Live only through the Mac, for a view in a conversation, on a Mac that has it.
  const live = Boolean(source && at && canFetch);
  const pageSize = opts.limit ?? view.pageSize;
  const query: ViewQuery = useMemo(() => {
    const by = sort ?? patch.sort;
    const find = needle || patch.search;
    return { offset: page * pageSize, limit: pageSize, ...(by ? { sort: by } : {}), ...(find ? { search: find } : {}), ...(patch.where?.length ? { where: patch.where } : {}), ...(patch.top ? { top: patch.top } : {}), ...(patch.params && Object.keys(patch.params).length ? { params: patch.params } : {}) };
  }, [page, pageSize, sort, needle, patch]);
  const key = source ? `${sourceKey(source)}\u0000${JSON.stringify(query)}` : '';
  const pristine = !other && !touched && page === 0 && !sort && !needle && tick === 0;
  const snapshotWillDo = pristine && (view.rows.length > 0 || view.text !== undefined) && !view.source?.refresh;

  useEffect(() => {
    const t = setTimeout(() => setNeedle(search.trim()), live ? 300 : 0);
    return () => clearTimeout(t);
  }, [search, live]);

  useEffect(() => {
    if (!live || !source || !at || snapshotWillDo) return;
    let alive = true;
    setLoading(true);
    const wantFresh = fresh.current;
    const yes = confirm.current;
    fresh.current = false;
    confirm.current = false;
    const own = other ?? patch.source;
    store
      .call<ViewFetchResult>(calls.viewFetch({ ...at, query, ...(own ? { source: own } : {}), ...(wantFresh ? { fresh: true } : {}), ...(yes ? { confirm: true } : {}), ...(opts.text ? { text: true } : {}) }), { queue: false })
      .then(
        (r) => {
          if (!alive || !r) return;
          if ('needsApproval' in r) return setAsk(r.what);
          setAsk(undefined);
          setError(undefined);
          setGot({ key, rows: r.rows, columns: r.columns, ...(r.total !== undefined ? { total: r.total } : {}), hasMore: r.hasMore, at: r.at, ...(r.text !== undefined ? { text: r.text } : {}) });
        },
        (e: Error) => alive && setError(e.message),
      )
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [key, tick, live, snapshotWillDo]);

  // `refresh` seconds: asked again while it's on screen (the Mac fetches; the phone only asks).
  const every = source?.refresh ? Math.max(2, source.refresh) * 1000 : 0;
  useEffect(() => {
    if (!live || !every || ask) return;
    const t = setInterval(() => {
      fresh.current = true;
      setTick((n) => n + 1);
    }, every);
    return () => clearInterval(t);
  }, [live, every, ask]);

  const local = useMemo(() => (live ? undefined : pageOf(view.rows, query)), [live, view.rows, query]);
  const setSort = useCallback((s: Sort) => (setSortNow(s), setPage(0)), []);
  const setSearch = useCallback((s: string) => (setSearchNow(s), setPage(0)), []);
  const refresh = useCallback(() => {
    fresh.current = true;
    setTick((n) => n + 1);
  }, []);
  const approve = useCallback(() => {
    confirm.current = true;
    setAsk(undefined);
    setTick((n) => n + 1);
  }, []);
  const setControl = useCallback((id: string, value: ControlState[string]) => {
    setControls((now) => ({ ...now, [id]: value }));
    setTouched(true);
    setPage(0);
  }, []);
  const useSource = useCallback((s: Source | undefined) => {
    setOther(s);
    setPage(0);
    setGot(undefined);
  }, []);

  const shown = live && got && !(snapshotWillDo && got.key !== key) ? got : undefined;
  const rows = shown ? shown.rows : live ? (snapshotWillDo || (!got && pristine) ? view.rows.slice(0, pageSize) : []) : local!.rows;
  const columns = useMemo(() => (shown ? columnsFor(view, shown.rows, shown.columns) : view.columns), [shown, view]);
  const total = shown ? shown.total : live ? (view.total ?? (view.rows.length < pageSize ? view.rows.length : undefined)) : local!.total;
  const hasMore = shown ? shown.hasMore : live ? (view.total ?? 0) > pageSize || view.rows.length > pageSize : local!.hasMore;
  const when = shown?.at ?? view.at;
  const text = shown?.text ?? view.text;
  return {
    live,
    rows,
    columns,
    ...(total !== undefined ? { total } : {}),
    hasMore,
    ...(when !== undefined ? { at: when } : {}),
    ...(text !== undefined ? { text } : {}),
    loading,
    ...(error ? { error } : {}),
    ...(ask ? { needsApproval: ask } : {}),
    page,
    pageSize,
    sort,
    search,
    controls,
    switched: other !== undefined,
    setControl,
    setPage,
    setSort,
    setSearch,
    refresh,
    approve,
    useSource,
  };
}
