import { useEffect, useMemo, useRef, useState } from 'react';
import { activityOf } from '@beluga/ui/workspace-models.js';
import { type Dashboard, type Tile, CHART_TILE_KINDS, OUTPUT_SHOWS, type OutputShow, TILE_WIDTHS, WIDTH_WORDS, dashboardMarkdown, dashboardSentinels, gridLanding, metricOf, outputLook, outputRows, tileCompare, tileMetrics, tileOutput, tileStateIn } from '@beluga/core/sentinel/dashboard-model.js';
import { COMPARE, COMPARE_LABEL, COMPARE_WORDS, type Compare } from '@beluga/core/sentinel/metrics.js';
import type { SentinelState } from '@beluga/core/sentinel/model.js';
import type { Args } from '@beluga/ipc/api.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, EmptyActions, IconButton, Tip } from '../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { openSheet } from '../lib/sheets.js';
import { useActions } from '../lib/actions.js';
import { isDrag } from '../tasks/board-drag.js';
import { ago } from '../tasks/tasks-model.js';
import { ClaudeMark } from './marks.js';
import { CompareSwitch, MetricChart, NumberTile, RowsTable, SeriesChart } from './NumberParts.js';
import { draftsOf, jsonFence, numberWords, outputTable, refreshLine, tileCaption, tileNote, tileWords } from './numbers-model.js';
import { askLine, namedLine } from './sentinel-model.js';
import { useSentinelActions, useSentinelState } from './use-sentinel.js';
import t from '../tasks/tasks.module.css';
import n from './numbers.module.css';

/**
 * Sentinel › Dashboard (docs/sentinel.md §10): anything your sentinels produced, picked up as tiles
 * in tabs: numbers with their change, series, tables, a step's latest output, a headline or report.
 * Tiles in a grid of six columns, dragged into place (the board's drag), each resized and retitled
 * from its ⋯; compare at the top for every tile (a tile can pin its own); Refresh runs the
 * sentinels it draws from one at a time; Add a Tile takes a description (your Claude builds it, and
 * sets up a draft sentinel when nothing fetches it yet) or lets you pick. Everything saves at once.
 */

export function DashboardPage({ id }: { id?: string }) {
  const state = useSentinelState();
  const all = state.dashboards ?? [];
  const current = all.find((d) => d.id === id) ?? all[0];
  if (!state.enabled) return <Empty icon="gauge" title="Dashboards need the Beluga app" />;
  if (!current) return <NoDashboard />;
  return <Page key={current.id} d={current} all={all} />;
}

function NoDashboard() {
  const api = useApi();
  const go = useGo();
  const a = useSentinelActions();
  return (
    <div className={n.page}>
      <Empty
        icon="gauge"
        title="Nothing on a dashboard yet"
        detail="Sentinel’s dashboard shows what your sentinels keep and bring back: a number and how it moved, a series, a table, what Claude wrote, an API’s answer. Make one and add tiles by describing them; the first is made for you when the first number arrives."
        action={
          <EmptyActions>
            <Button variant="primary" onClick={() => void a.act(() => api.dashboard.create('Dashboard')).then((d) => d && go(d.id))}>
              New Dashboard
            </Button>
            <Button onClick={() => openSheet({ kind: 'new_sentinel', way: 'recipe' })}>Try a Recipe</Button>
          </EmptyActions>
        }
      />
    </div>
  );
}

const useGo = () => {
  const actions = useActions();
  return (id: string): void => actions.run({ type: 'view', view: { kind: 'dashboard', id } });
};

function Page({ d, all }: { d: Dashboard; all: readonly Dashboard[] }) {
  const api = useApi();
  const { client } = useBeluga();
  const a = useSentinelActions();
  const go = useGo();
  const state = useSentinelState();
  const refreshing = state.refreshing?.[d.id];
  const [renaming, setRenaming] = useState(false);
  const save = (patch: Args<'dashboard.update'>[1]): void => void a.act(() => api.dashboard.update(d.id, patch));
  const sentinels = dashboardSentinels(d).filter((sid) => state.items.some((i) => i.id === sid && !i.paused));
  const copyMarkdown = (): void => void copyText(dashboardMarkdown(d, (tile) => tileWords(state, d, tile))).then(() => toast(client, `Copied ${d.name} as Markdown`, 'success'));
  const more: ActionItem[] = [
    { label: 'Rename…', icon: 'pencil', onSelect: () => setRenaming(true) },
    { label: 'Copy as Markdown', icon: 'copy', onSelect: copyMarkdown },
    { label: 'New Dashboard', icon: 'plus', separate: true, onSelect: () => void a.act(() => api.dashboard.create(`Dashboard ${all.length + 1}`)).then((x) => x && go(x.id)) },
    {
      label: 'Delete Dashboard…',
      danger: true,
      separate: true,
      onSelect: () =>
        openSheet({
          kind: 'confirm',
          title: `Delete “${d.name}”?`,
          message: 'Its tiles go; the numbers stay with their sentinels, and other dashboards keep theirs.',
          confirm: 'Delete Dashboard',
          destructive: true,
          run: () => void a.act(() => api.dashboard.remove(d.id), `Deleted ${d.name}`),
        }),
    },
  ];
  return (
    <div className={n.page} data-dashboard={d.id}>
      <div className={n.bar}>
        <div className={n.tabs} role="tablist" aria-label="Dashboards">
          {all.map((x) =>
            renaming && x.id === d.id ? (
              <RenameTab key={x.id} name={x.name} done={(name) => {
                setRenaming(false);
                if (name && name !== d.name) save({ name });
              }} />
            ) : (
              <button key={x.id} type="button" role="tab" className={n.tab} aria-selected={x.id === d.id} onClick={() => go(x.id)} onDoubleClick={() => x.id === d.id && setRenaming(true)}>
                {x.name}
              </button>
            ),
          )}
          <IconButton icon="plus" label="New Dashboard" onClick={() => void a.act(() => api.dashboard.create(`Dashboard ${all.length + 1}`)).then((x) => x && go(x.id))} />
        </div>
        <span className={t.grow} />
        <CompareSwitch value={d.compare} onChange={(compare) => save({ compare })} label="Compare every tile with" />
        {refreshing ? (
          <span className={n.fetching} role="status" data-testid="dashboard-fetching">
            <Icon name="refresh" size={12} />
            {refreshLine(refreshing)}
          </span>
        ) : (
          <Tip label={sentinels.length ? `Run Now on its ${sentinels.length === 1 ? 'sentinel' : `${sentinels.length} sentinels`}, one at a time` : 'Its sentinels are paused or gone'}>
            <Button size="small" icon="refresh" disabled={!sentinels.length} onClick={() => void a.act(() => api.dashboard.refresh(d.id))}>
              Refresh
            </Button>
          </Tip>
        )}
        <Button size="small" variant="primary" icon="plus" onClick={() => openSheet({ kind: 'add_tile', dashboardId: d.id })}>
          Add a Tile
        </Button>
        <ActionsDropdown items={more}>
          <IconButton icon="more" label={`More for ${d.name}`} />
        </ActionsDropdown>
      </div>
      <AskLine d={d} />
      {d.tiles.length ? (
        <Grid d={d} state={state} />
      ) : (
        <Empty icon="gauge" title="Nothing on it yet" detail="Describe a tile (“my Stripe revenue per day”, “the open PR count”) and Claude puts it together, setting up a sentinel to fetch it when none does yet; or pick a number, a series, a table or a step’s output yourself." action={<Button onClick={() => openSheet({ kind: 'add_tile', dashboardId: d.id })}>Add a Tile</Button>} />
      )}
    </div>
  );
}

function RenameTab({ name, done }: { name: string; done: (name: string) => void }) {
  const [text, setText] = useState(name);
  return (
    <input
      className={n.tabInput}
      value={text}
      aria-label="Dashboard name"
      autoFocus
      onChange={(e) => setText(e.target.value)}
      onBlur={() => done(text.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') done(text.trim());
        if (e.key === 'Escape') done(name);
      }}
    />
  );
}

/**
 * Your Claude building this dashboard (Add a Tile by description): its last line while it works and
 * its answer after, with Open Chat; and the draft sentinels it set up to fetch what nothing kept yet,
 * each with Review and Turn On (nothing runs before you've seen it).
 */
function AskLine({ d }: { d: Dashboard }) {
  const a = useSentinelActions();
  const ask = useApp((st) => st.sentinel.dashboardAsks?.[d.id]);
  const live = useApp((st) => (ask?.state === 'writing' ? activityOf(st.log, ask.channel) : undefined));
  const drafts = useApp((st) => draftsOf(st.sentinel, d.id), (x, y) => JSON.stringify(x) === JSON.stringify(y));
  const line = askLine(ask, live);
  const items = useApp((st) => st.sentinel.items);
  return (
    <>
      {line && ask ? (
        <div className={n.describeLine} role="status" aria-live="polite" data-testid="dashboard-ask">
          <Icon name={line.who === 'done' ? 'check' : line.who === 'claude' ? 'claude' : 'alert'} size={12} />
          <span>{namedLine(line.text, (id) => items.find((i) => i.id === id)?.name)}</span>
          <Button size="small" variant="quiet" onClick={() => a.openChannel(ask.channel)}>
            Open Chat
          </Button>
        </div>
      ) : null}
      {drafts.map((x) => (
        <div key={x.id} className={n.draft} data-testid="dashboard-draft" data-sentinel={x.id}>
          <ClaudeMark />
          <span className={n.draftText}>
            Claude set up <strong>{x.name}</strong> to fetch it. It’s a draft: nothing runs until you turn it on.
          </span>
          <Button size="small" variant="quiet" onClick={() => a.open(x.id)}>
            Review
          </Button>
          <Button size="small" variant="primary" icon="play" onClick={() => void a.setPaused(x, false)}>
            Turn On
          </Button>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- the grid, and its drag

interface Drag {
  readonly id: string;
  readonly dx: number;
  readonly dy: number;
  readonly w: number;
  readonly h: number;
  x: number;
  y: number;
  index: number | undefined;
}

/** The tiles, dragged into place: a pointer that moves past a few pixels lifts the tile; where it drops is worked out from the others' boxes. */
function Grid({ d, state }: { d: Dashboard; state: SentinelState }) {
  const api = useApi();
  const a = useSentinelActions();
  const grid = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>();
  const start = useRef<{ id: string; x: number; y: number; box: DOMRect } | undefined>(undefined);
  const others = useRef<ReturnType<typeof boxesOf>>([]);

  const boxesOf = (lifted: string) =>
    [...(grid.current?.querySelectorAll<HTMLElement>('[data-tile]') ?? [])]
      .filter((el) => el.dataset.tile !== lifted)
      .map((el) => {
        const b = el.getBoundingClientRect();
        return { id: el.dataset.tile!, left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      });

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent): void => setDrag((now) => (now ? { ...now, x: e.clientX, y: e.clientY, index: gridLanding(e.clientX, e.clientY, others.current) } : now));
    const up = (): void => {
      setDrag((now) => {
        if (now && now.index !== undefined) void a.act(() => api.dashboard.moveTile(d.id, now.id, now.index!));
        return undefined;
      });
      start.current = undefined;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    document.documentElement.dataset.dragging = 'tile';
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      delete document.documentElement.dataset.dragging;
    };
  }, [drag !== undefined, a, api, d.id]);

  const down = (e: React.PointerEvent<HTMLElement>, id: string): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, a, [role="menu"], .recharts-wrapper')) return;
    const box = (e.currentTarget.closest('[data-tile]') as HTMLElement).getBoundingClientRect();
    start.current = { id, x: e.clientX, y: e.clientY, box };
  };
  const moveStart = (e: React.PointerEvent<HTMLElement>): void => {
    const s = start.current;
    if (!s || drag || !isDrag(e.clientX - s.x, e.clientY - s.y)) return;
    others.current = boxesOf(s.id);
    setDrag({ id: s.id, dx: s.x - s.box.left, dy: s.y - s.box.top, w: s.box.width, h: s.box.height, x: e.clientX, y: e.clientY, index: undefined });
  };

  const rest = drag ? d.tiles.filter((x) => x.id !== drag.id) : d.tiles;
  const lifted = drag ? d.tiles.find((x) => x.id === drag.id) : undefined;
  const at = drag?.index;
  return (
    <div ref={grid} className={n.grid} role="list" aria-label={`${d.name}’s tiles`} onPointerMove={moveStart} onPointerUp={() => (start.current = undefined)}>
      {rest.map((tile, i) => (
        <TileSlot key={tile.id} before={at === i && lifted ? lifted : undefined}>
          <TileCell d={d} tile={tile} state={state} onPointerDown={(e) => down(e, tile.id)} />
        </TileSlot>
      ))}
      {lifted && at !== undefined && at >= rest.length ? <div className={n.gap} data-w={lifted.width} style={{ gridColumn: `span ${lifted.kind === 'divider' ? 6 : lifted.width}` }} /> : null}
      {lifted && drag ? (
        <div className={n.ghost} style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.w, height: drag.h }} aria-hidden="true">
          <TileCell d={d} tile={lifted} state={state} ghost />
        </div>
      ) : null}
    </div>
  );
}

function TileSlot({ before, children }: { before: Tile | undefined; children: React.ReactNode }) {
  return (
    <>
      {before ? <div className={n.gap} style={{ gridColumn: `span ${before.kind === 'divider' ? 6 : before.width}` }} /> : null}
      {children}
    </>
  );
}

const noop = (): void => undefined;
const SHOW_WORDS: Readonly<Record<OutputShow, string>> = { auto: 'As it reads', markdown: 'Markdown', tree: 'A JSON tree', table: 'A table', text: 'Plain text' };

function TileCell({ d, tile, state, onPointerDown, ghost }: { d: Dashboard; tile: Tile; state: SentinelState; onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void; ghost?: boolean }) {
  const api = useApi();
  const a = useSentinelActions();
  const [renaming, setRenaming] = useState(false);
  const onRename = (): void => setRenaming(true);
  const cap = tileCaption(state, tile);
  const note = tileNote(cap.state);
  const compare = tileCompare(d, tile);
  const update = (patch: Args<'dashboard.updateTile'>[2]): void => void a.act(() => api.dashboard.updateTile(d.id, tile.id, patch));
  const sentinelId = tile.metric?.sentinelId ?? tile.metrics?.[0]?.sentinelId ?? tile.sentinelId ?? tile.step?.sentinelId;
  const output = tile.kind === 'output' ? tileOutput(state, tile) : undefined;
  const menu: ActionItem[] = [
    { label: 'Rename…', icon: 'pencil', onSelect: () => onRename?.() },
    ...(tile.kind === 'divider'
      ? []
      : [
          { label: 'Width', icon: 'columns' as const, onSelect: noop, submenu: TILE_WIDTHS.map((w) => ({ label: WIDTH_WORDS[w], checked: tile.width === w, onSelect: () => update({ width: w }) })) },
          { label: 'Height', icon: 'rows' as const, onSelect: noop, submenu: [{ label: 'Normal', checked: tile.height !== 2, onSelect: () => update({ height: 1 }) }, { label: 'Tall', checked: tile.height === 2, onSelect: () => update({ height: 2 }) }] },
          ...(tile.kind === 'number' || tile.kind === 'series'
            ? [{ label: 'Compare', icon: 'clock' as const, onSelect: noop, submenu: [{ label: `As the dashboard (${COMPARE_WORDS[d.compare]})`, checked: !tile.compare, onSelect: () => update({ compare: null }) }, ...COMPARE.map((c) => ({ label: `Pin: ${COMPARE_LABEL[c]}`, checked: tile.compare === c, onSelect: () => update({ compare: c }) }))] }]
            : []),
          ...(tile.kind === 'series' ? [{ label: 'Draw as', icon: 'chartLine' as const, onSelect: noop, submenu: CHART_TILE_KINDS.map((k) => ({ label: k === 'line' ? 'Lines' : k === 'area' ? 'Areas' : 'Bars', checked: (tile.chart ?? 'line') === k, onSelect: () => update({ chart: k }) })) }] : []),
          ...(tile.kind === 'output' ? [{ label: 'Show as', icon: 'eye' as const, onSelect: noop, submenu: OUTPUT_SHOWS.map((k) => ({ label: SHOW_WORDS[k], checked: (tile.show ?? 'auto') === k, onSelect: () => update({ show: k }) })) }] : []),
          ...(tile.kind === 'text' ? [{ label: 'Shows', icon: 'eye' as const, onSelect: noop, submenu: [{ label: 'Its last headline', checked: tile.text !== 'report', onSelect: () => update({ text: 'headline' }) }, { label: 'Its last report', checked: tile.text === 'report', onSelect: () => update({ text: 'report' }) }] }] : []),
          ...(output?.runId ? [{ label: 'Open the Run', icon: 'arrowRight' as const, separate: true, onSelect: () => a.openRun(output.runId) }] : []),
          ...(sentinelId && cap.state !== 'gone' ? [{ label: 'Open Its Sentinel', icon: 'sentinel' as const, ...(output?.runId ? {} : { separate: true }), onSelect: () => a.open(sentinelId) }] : []),
        ]),
    { label: 'Remove Tile', danger: true, separate: true, onSelect: () => void a.act(() => api.dashboard.removeTile(d.id, tile.id)) },
  ];
  const more = ghost ? null : (
    <ActionsDropdown items={menu}>
      <IconButton icon="more" label={`More for ${cap.title || 'this tile'}`} className={n.cellMore} />
    </ActionsDropdown>
  );
  if (tile.kind === 'divider') {
    return (
      <div className={n.cell} data-tile={tile.id} data-kind="divider" role="listitem" onPointerDown={onPointerDown}>
        <div className={n.divider}>
          {renaming ? <TitleInput title={tile.title ?? ''} done={(title) => (setRenaming(false), title !== (tile.title ?? '') && update({ title }))} /> : <span className={n.dividerTitle}>{tile.title || 'Divider'}</span>}
        </div>
        {more ? <div style={{ position: 'absolute', right: 0, top: 4 }}>{more}</div> : null}
      </div>
    );
  }
  const head = (
    <div className={n.cellHead}>
      {renaming ? <TitleInput title={tile.title ?? cap.title} done={(title) => (setRenaming(false), title !== (tile.title ?? cap.title) && update({ title }))} /> : <span className={n.cellTitle}>{cap.title}</span>}
      {cap.from && tile.kind !== 'text' && cap.from !== cap.title ? <span className={n.cellFrom}>{cap.from}</span> : null}
      {note ? <span className={n.note}>{note}</span> : tile.compare && tile.kind !== 'number' ? <span className={n.note}>{COMPARE_WORDS[tile.compare]}</span> : null}
      {more}
    </div>
  );
  return (
    <div className={n.cell} data-tile={tile.id} data-kind={tile.kind} data-w={tile.width} data-h={tile.height ?? 1} data-state={cap.state} role="listitem" onPointerDown={onPointerDown}>
      {tile.kind === 'number' ? null : head}
      <div className={n.cellBody}>
        <TileBody d={d} tile={tile} state={state} compare={compare} note={note} more={tile.kind === 'number' ? more : null} />
      </div>
    </div>
  );
}

function TileBody({ d, tile, state, compare, note, more }: { d: Dashboard; tile: Tile; state: SentinelState; compare: Compare; note: string | undefined; more: React.ReactNode }) {
  const a = useSentinelActions();
  if (tile.kind === 'number') {
    const m = metricOf(state, tile.metric);
    if (!m)
      return (
        <div className={n.waiting}>
          <span className={n.cellTitle}>{tileCaption(state, tile).title}</span>
          <span className={n.quiet}>{note ?? 'gone'}</span>
          {more}
        </div>
      );
    const w = numberWords(m, compare, tileCaption(state, tile).title);
    return (
      <NumberTile w={w} {...(note ? { note } : {})}>
        {more}
      </NumberTile>
    );
  }
  const tall = tile.height === 2;
  if (tile.kind === 'series') {
    const ms = tileMetrics(state, tile);
    if (!ms.length) return <div className={n.quiet}>{note ?? 'gone'}</div>;
    const height = (tile.width === 1 ? 140 : 200) + (tall ? 200 : 0);
    // A series metric draws its latest array; numbers draw their points over time.
    if (ms[0]!.kind === 'series') return <SeriesChart metric={ms[0]!} kind={tile.chart ?? 'bar'} height={height} />;
    return <MetricChart series={ms} kind={tile.chart ?? 'line'} height={height} onRun={(runId) => a.openRun(runId)} />;
  }
  if (tile.kind === 'table') {
    const m = metricOf(state, tile.metric);
    if (!m?.rows) return <div className={n.quiet}>{note ?? 'gone'}</div>;
    return <RowsTable metric={m} pageSize={tall ? 14 : 6} />;
  }
  if (tile.kind === 'output') return <OutputTile tile={tile} state={state} note={note} />;
  return <TextTile tile={tile} state={state} />;
}

/** A tile's title, renamed in place (empty: its metric's or step's name again). */
function TitleInput({ title, done }: { title: string; done: (title: string) => void }) {
  const [text, setText] = useState(title);
  return (
    <input
      className={n.tileTitleInput}
      value={text}
      aria-label="Tile title"
      autoFocus
      maxLength={80}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => done(text.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') done(text.trim());
        if (e.key === 'Escape') done(title);
      }}
    />
  );
}

/**
 * A step's export, always the latest run's: what Claude wrote (the chat's Markdown), a service's
 * answer (the chat's JSON tree, or a table when it's a list), or plain text; with when it came and a
 * link to that run.
 */
function OutputTile({ tile, state, note }: { tile: Tile; state: SentinelState; note: string | undefined }) {
  const a = useSentinelActions();
  const o = tileOutput(state, tile);
  if (!o) return <div className={n.quiet}>{note ?? 'No output yet: it shows after its step runs'}</div>;
  const look = outputLook(o, tile.show);
  let body: React.ReactNode;
  if (look === 'table') {
    let rows: Array<Record<string, unknown>> | undefined;
    try {
      rows = outputRows(JSON.parse(o.text));
    } catch {
      rows = undefined;
    }
    body = rows ? <RowsTable metric={outputTable(rows)} pageSize={tile.height === 2 ? 14 : 6} /> : <pre className={n.outputText}>{o.text}</pre>;
  } else if (look === 'tree') body = <Markdown text={jsonFence(o.text)} />;
  else if (look === 'markdown') body = <Markdown text={o.text} tasks />;
  else body = <pre className={n.outputText}>{o.text}</pre>;
  return (
    <div className={n.output} data-look={look}>
      <div className={n.outputBody}>{body}</div>
      <div className={n.outputFoot}>
        {o.at ? <span>{ago(o.at)}</span> : null}
        {o.cut ? <span>· shortened: the run has all of it</span> : null}
        {o.runId ? (
          <button type="button" className={n.outputRun} onClick={() => a.openRun(o.runId)}>
            Open the run
            <Icon name="arrowRight" size={10} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A sentinel's last headline, or its last report (the chat's Markdown). */
function TextTile({ tile, state }: { tile: Tile; state: SentinelState }) {
  const api = useApi();
  const last = useMemo(() => [...state.runs].reverse().find((r) => r.sentinelId === tile.sentinelId && r.endedAt), [state.runs, tile.sentinelId]);
  const [report, setReport] = useState<string>();
  useEffect(() => {
    if (tile.text !== 'report' || !last) return;
    let alive = true;
    api.sentinel.runGet(last.id).then(
      (r) => alive && setReport(r.report),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, tile.text, last?.id]);
  if (tileStateIn(state, tile) === 'gone') return <div className={n.quiet}>gone</div>;
  if (tileStateIn(state, tile) === 'draft') return <div className={n.quiet}>A draft: it runs once you turn it on</div>;
  if (!last) return <div className={n.quiet}>No runs yet</div>;
  return (
    <div className={n.text}>
      {tile.text === 'report' && report ? <Markdown text={report} tasks /> : <p style={{ margin: 0 }}>{last.headline || 'It ran'}</p>}
      <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-3)' }}>{ago(last.endedAt ?? last.startedAt)}</div>
    </div>
  );
}
