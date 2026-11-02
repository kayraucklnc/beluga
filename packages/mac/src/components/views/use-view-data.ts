import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Column, type Row, type Source, type View, type ViewQuery, columnsFor, pageOf, sourceKey } from '@beluga/shared/view-spec.js';
import { useBeluga } from '../../lib/beluga.js';
import { useClock } from '../../lib/window-active.js';
import { type ControlState, initialState, resolveControls } from '@beluga/shared/view-controls.js';

/**
 * A view's rows as you look at them: a page, sorted and searched. Rows Claude brought are paged
 * here; a source (your own Claude's) is asked for each page, and fetched again on Refresh or every
 * `refresh` seconds while it's on screen. What this Mac fetched before is shown again when the
 * view opens, without running the source (core/views/kept.ts). A command that hasn't run before
 * waits for your Run.
 */

export type Sort = ViewQuery['sort'];
export type DataMode =
  /** Rows Claude wrote in. */
  | 'inline'
  /** A source that runs here. */
  | 'live'
  /** A source on someone else's computer: only the rows it came with. */
  | 'snapshot';

export interface ViewData {
  readonly mode: DataMode;
  readonly rows: readonly Row[];
  readonly columns: readonly Column[];
  readonly total?: number;
  readonly hasMore: boolean;
  readonly at?: number;
  readonly text?: string;
  readonly loading: boolean;
  readonly error?: string;
  /** What runs once you say yes. */
  readonly needsApproval?: string;
  readonly page: number;
  readonly pageSize: number;
  readonly sort: Sort;
  readonly search: string;
  readonly source?: Source;
  /** The source an action switched to (undefined: the view's own). */
  readonly switched: boolean;
  /** What's chosen in each of the view's controls (see shared/view-controls.ts). */
  readonly controls: ControlState;
  /** Every row in this order (sorted, searched, filtered), past the page: what Copy takes. A source here: the page it has. */
  allRows(): readonly Row[];
  setControl(id: string, value: ControlState[string]): void;
  setPage(n: number): void;
  setSort(s: Sort): void;
  setSearch(s: string): void;
  refresh(): void;
  approve(): void;
  useSource(s: Source | undefined): void;
}

type Got = { readonly key: string; readonly rows: readonly Row[]; readonly columns: readonly string[]; readonly total?: number; readonly hasMore: boolean; readonly at: number; readonly text?: string };

export function useViewData(view: View, opts: { local: boolean; visible: boolean; limit?: number; text?: boolean }): ViewData {
  const { client } = useBeluga();
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
  // What's chosen in the controls Claude set up, and what that does to the rows.
  const [controls, setControls] = useState<ControlState>(() => initialState(view));
  const [touched, setTouched] = useState(false);
  const patch = useMemo(() => resolveControls(view, controls), [view, controls]);

  const source = other ?? patch.source ?? view.source;
  const mode: DataMode = !source ? 'inline' : opts.local ? 'live' : 'snapshot';
  const pageSize = opts.limit ?? view.pageSize;
  const query: ViewQuery = useMemo(() => {
    const by = sort ?? patch.sort;
    const find = needle || patch.search;
    return { offset: page * pageSize, limit: pageSize, ...(by ? { sort: by } : {}), ...(find ? { search: find } : {}), ...(patch.where ? { where: patch.where } : {}), ...(patch.top ? { top: patch.top } : {}), ...(patch.params ? { params: patch.params } : {}) };
  }, [page, pageSize, sort, needle, patch]);
  const key = source ? `${sourceKey(source)}\u0000${JSON.stringify(query)}` : '';
  // The rows the view came with stand for its first page until you ask for something else.
  const pristine = !other && !touched && page === 0 && !sort && !needle && tick === 0;
  const snapshotWillDo = pristine && (view.rows.length > 0 || view.text !== undefined) && !view.source?.refresh;

  // Searching waits for you to stop typing.
  useEffect(() => {
    const t = setTimeout(() => setNeedle(search.trim()), mode === 'live' ? 280 : 0);
    return () => clearTimeout(t);
  }, [search, mode]);

  useEffect(() => {
    if (mode !== 'live' || !source || !opts.visible) return;
    let alive = true;
    // The rows it came with will do, unless this Mac fetched newer ones since (a Refresh): never runs it.
    if (snapshotWillDo) {
      client.api.view.fetch(source, query, { cache: 'only', ...(opts.text ? { text: true } : {}) }).then(
        (r) => {
          if (!alive || !('rows' in r) || r.at <= (view.at ?? 0)) return;
          setGot({ key, rows: r.rows, columns: r.columns, ...(r.total !== undefined ? { total: r.total } : {}), hasMore: r.hasMore, at: r.at, ...(r.text !== undefined ? { text: r.text } : {}) });
        },
        () => undefined,
      );
      return () => {
        alive = false;
      };
    }
    setLoading(true);
    const wantFresh = fresh.current;
    const yes = confirm.current;
    fresh.current = false;
    confirm.current = false;
    // What was fetched before is shown again (it says when it's from); Refresh fetches anew.
    client.api.view
      .fetch(source, query, { ...(wantFresh ? { fresh: true } : { cache: 'prefer' }), ...(yes ? { confirm: true } : {}), ...(opts.text ? { text: true } : {}) })
      .then(
        (r) => {
          if (!alive || 'notKept' in r) return;
          if ('needsApproval' in r) {
            setAsk(r.what);
            return;
          }
          setAsk(undefined);
          setError(undefined);
          setGot({ key, rows: r.rows, columns: r.columns, ...(r.total !== undefined ? { total: r.total } : {}), hasMore: r.hasMore, at: r.at, ...(r.text !== undefined ? { text: r.text } : {}) });
        },
        (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [key, tick, mode, opts.visible, snapshotWillDo]);

  // Live: fetched again every `refresh` seconds while you can see it (and look at the window).
  const every = source?.refresh ? Math.max(2, source.refresh) * 1000 : 0;
  const clock = useClock(mode === 'live' && every > 0 && opts.visible && !ask, every || 1000);
  const lastAt = got?.at ?? view.at ?? 0;
  useEffect(() => {
    if (mode !== 'live' || !every || !opts.visible || ask || loading) return;
    if (clock - lastAt < every * 0.9) return;
    fresh.current = true;
    setTick((n) => n + 1);
  }, [clock]);

  const local = useMemo(() => (mode === 'live' ? undefined : pageOf(view.rows, query)), [mode, view.rows, query]);

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

  const shown = mode === 'live' && got && !(snapshotWillDo && got.key !== key) ? got : undefined;
  const rows = shown ? shown.rows : mode === 'live' ? (snapshotWillDo || (!got && pristine) ? view.rows.slice(0, pageSize) : []) : local!.rows;
  const found = shown ? shown.columns : [];
  const columns = useMemo(() => (shown ? columnsFor(view, shown.rows, found) : view.columns), [shown, view]);
  const total = shown ? shown.total : mode === 'live' ? view.total ?? (view.rows.length < pageSize ? view.rows.length : undefined) : local!.total;
  const hasMore = shown ? shown.hasMore : mode === 'live' ? (view.total ?? 0) > pageSize || view.rows.length > pageSize : local!.hasMore;
  const at = shown?.at ?? view.at;
  const text = shown?.text ?? view.text;
  const allRows = useCallback(() => (mode === 'live' ? rows : pageOf(view.rows, { ...query, offset: 0, limit: view.rows.length }).rows), [mode, view.rows, query, rows]);
  return {
    mode,
    rows,
    columns,
    ...(total !== undefined ? { total } : {}),
    hasMore,
    ...(at !== undefined ? { at } : {}),
    ...(text !== undefined ? { text } : {}),
    loading,
    ...(error ? { error } : {}),
    ...(ask ? { needsApproval: ask } : {}),
    page,
    pageSize,
    sort,
    search,
    ...(source ? { source } : {}),
    switched: other !== undefined,
    controls,
    allRows,
    setControl,
    setPage,
    setSort,
    setSearch,
    refresh,
    approve,
    useSource,
  };
}

/** Whether an element is on screen (sources are only fetched for what you can see). */
export function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(Boolean(e?.isIntersecting)), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, visible];
}
