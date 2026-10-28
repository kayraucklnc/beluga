import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activityOf } from '@beluga/ui/workspace-models.js';
import { type Dashboard, type Tile, CHART_TILE_KINDS, OUTPUT_SHOWS, type OutputShow, GRID_COLUMNS, TILE_WIDTHS, type TileHeight, type TileWidth, WIDTH_WORDS, dashboardMarkdown, moveTile, snapWidth, tileSentinelOf, dashboardSentinels, gridLanding, metricOf, outputLook, outputRows, tileCompare, tileMetrics, tileOutput, tileStateIn } from '@beluga/core/sentinel/dashboard-model.js';
import { COMPARE, COMPARE_LABEL, COMPARE_WORDS, type Compare } from '@beluga/core/sentinel/metrics.js';
import type { MetricSeries, SentinelState } from '@beluga/core/sentinel/model.js';
import type { Args } from '@beluga/ipc/api.js';
import { Attention } from '../chat/Attention.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Button, IconButton, Tip } from '../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { openSheet } from '../lib/sheets.js';
import { isDrag } from '../tasks/board-drag.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { ago } from '../tasks/tasks-model.js';
import { ClaudeMark } from './marks.js';
import { FillChart, MetricChart, NumberTile, RowsTable, SeriesChart } from './NumberParts.js';
import { draftsOf, jsonFence, numberWords, outputTable, refreshLine, tileCaption, tileNote, tileWords } from './numbers-model.js';
import { askLine, inScope, namedLine } from './sentinel-model.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { TINTS, setTintChoice, tintChoiceOf, useProjectTint } from './tint.js';
import { SHOW_TILE } from '../lib/widget-links.js';
import { useSentinelActions, useSentinelState } from './use-sentinel.js';
import n from './numbers.module.css';

/**
 * At a glance (docs/sentinel.md §10, BLG-300): the board on Sentinel's page. Anything your
 * sentinels keep or bring back, as tiles: numbers with their change, series, tables, a step's
 * latest output, a headline or a report. Tiles sit in a grid of six columns, dragged into place
 * (the board's drag) and resized by their corner (a bigger tile shows more: a number gets its chart);
 * each is marked with its project when the board mixes them, and can be grouped by project. The
 * board picker goes between boards; compare sets every tile at once; Refresh runs the sentinels it
 * draws from one at a time; Add takes a description or lets you pick. Everything saves at once.
 */

/** The boards' names (the picker), and the one shown: the one asked for, else the first. */
export function Board({ id, onPick, scope, children }: { id?: string; onPick: (id: string) => void; scope?: string; children?: React.ReactNode }) {
  const state = useSentinelState();
  const all = state.dashboards ?? [];
  const current = all.find((d) => d.id === id) ?? all[0];
  if (!current) return <NoBoard onPick={onPick}>{children}</NoBoard>;
  return (
    <Page key={current.id} d={current} all={all} onPick={onPick} {...(scope ? { scope } : {})}>
      {children}
    </Page>
  );
}

/** Group the board's tiles by project (kept for this Mac). */
const GROUPED = 'sentinel.board.grouped';
const readGrouped = (): boolean => {
  try {
    return localStorage.getItem(GROUPED) === '1';
  } catch {
    return false;
  }
};

/** The project a tile's sentinel works in (none: Your Mac), and its name. */
function tileProject(state: SentinelState, tile: Tile, projects: ReadonlyArray<{ readonly id: string; readonly name: string }>): { readonly id?: string; readonly name: string; readonly sentinel?: string } | undefined {
  const sid = tileSentinelOf(tile);
  const item = sid ? state.items.find((i) => i.id === sid) : undefined;
  if (!item) return undefined;
  const p = item.projectId ? projects.find((x) => x.id === item.projectId) : undefined;
  return p ? { id: p.id, name: p.name, sentinel: item.name } : { name: 'Your Mac', sentinel: item.name };
}

/** No board yet: a quiet strip that says what goes here, and Add (the first board is made for it). */
function NoBoard({ onPick, children }: { onPick: (id: string) => void; children?: React.ReactNode }) {
  const api = useApi();
  const a = useSentinelActions();
  const add = async (): Promise<void> => {
    const d = await a.act(() => api.dashboard.create('Overview'));
    if (!d) return;
    onPick(d.id);
    openSheet({ kind: 'add_tile', dashboardId: d.id });
  };
  return (
    <section className={n.glance} aria-label="At a glance">
      <SectionHead title="At a glance" />
      <button type="button" className={n.noBoard} onClick={() => void add()} data-testid="board-empty">
        <Icon name="plus" size={14} />
        <span>
          <strong>Put a number here</strong>
          <span>Revenue, open pull requests, how fast your site answers, what Claude wrote this morning: it updates each time its sentinel runs.</span>
        </span>
      </button>
      {children}
    </section>
  );
}

/** A section's heading on Sentinel's page: its name, a hairline, and what acts on it at the end. */
export function SectionHead({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
  return (
    <div className={n.sectionHead}>
      <span className={n.sectionTitle}>
        {title}
        {count ? <span className={n.sectionCount}>{count}</span> : null}
      </span>
      <span className={n.sectionRule} />
      {children}
    </div>
  );
}

function Page({ d, all, onPick, scope, children }: { d: Dashboard; all: readonly Dashboard[]; onPick: (id: string) => void; scope?: string; children?: React.ReactNode }) {
  const api = useApi();
  const allProjects = useApp((st) => st.projects);
  const projects = useMemo(() => allProjects.filter((p) => p.root && !p.error), [allProjects]);
  const [grouped, setGrouped] = useState(readGrouped);
  const group = (on: boolean): void => {
    setGrouped(on);
    try {
      localStorage.setItem(GROUPED, on ? '1' : '0');
    } catch {
      // Not kept: it still groups now.
    }
  };
  const { client } = useBeluga();
  const a = useSentinelActions();
  const state = useSentinelState();
  const refreshing = state.refreshing?.[d.id];
  const [renaming, setRenaming] = useState(false);
  const save = (patch: Args<'dashboard.update'>[1]): void => void a.act(() => api.dashboard.update(d.id, patch));
  const sentinels = dashboardSentinels(d).filter((sid) => state.items.some((i) => i.id === sid && !i.paused));
  const copyMarkdown = (): void => void copyText(dashboardMarkdown(d, (tile) => tileWords(state, d, tile))).then(() => toast(client, `Copied ${d.name} as Markdown`, 'success'));
  const newBoard = (): void => void a.act(() => api.dashboard.create(`Board ${all.length + 1}`)).then((x) => x && onPick(x.id));
  const more: ActionItem[] = [
    { label: 'Rename…', icon: 'pencil', onSelect: () => setRenaming(true) },
    { label: 'Copy as Markdown', icon: 'copy', onSelect: copyMarkdown },
    { label: 'Group by Project', icon: 'folder', checked: grouped, hint: 'Each project’s tiles under its name (drag tiles in the board as one)', onSelect: () => group(!grouped) },
    { label: 'New Board', icon: 'plus', separate: true, onSelect: newBoard },
    {
      label: 'Delete Board…',
      danger: true,
      separate: true,
      onSelect: () =>
        openSheet({
          kind: 'confirm',
          title: `Delete “${d.name}”?`,
          message: 'Its tiles go; the numbers stay with their sentinels, and other boards keep theirs.',
          confirm: 'Delete Board',
          destructive: true,
          run: () => void a.act(() => api.dashboard.remove(d.id), `Deleted ${d.name}`),
        }),
    },
  ];
  return (
    <section className={n.glance} data-dashboard={d.id} aria-label="At a glance">
      <SectionHead title="At a glance">
        {renaming ? (
          <RenameTab
            name={d.name}
            done={(name) => {
              setRenaming(false);
              if (name && name !== d.name) save({ name });
            }}
          />
        ) : (
          <PickMenu<string>
            label="Boards"
            choices={all.map((x) => ({ value: x.id, label: x.name, mark: <Icon name="gauge" size={13} />, hint: `${x.tiles.length} ${x.tiles.length === 1 ? 'tile' : 'tiles'}` }))}
            chosen={[d.id]}
            onPick={onPick}
            actions={[{ label: 'New Board', icon: 'plus', onSelect: newBoard }]}
          >
            <button type="button" className={n.headPick} aria-label={`Board: ${d.name}`} onDoubleClick={() => setRenaming(true)}>
              {d.name}
              <Icon name="chevronDown" size={10} />
            </button>
          </PickMenu>
        )}
        <PickMenu<Compare> label="Compare every tile with" choices={COMPARE.map((c) => ({ value: c, label: COMPARE_WORDS[c] }))} chosen={[d.compare]} onPick={(compare) => save({ compare })}>
          <button type="button" className={n.headPick} aria-label={`Compare: ${COMPARE_WORDS[d.compare]}`}>
            {COMPARE_WORDS[d.compare]}
            <Icon name="chevronDown" size={10} />
          </button>
        </PickMenu>
        {refreshing ? (
          <span className={n.fetching} role="status" data-testid="dashboard-fetching">
            <Icon name="refresh" size={12} />
            {refreshLine(refreshing)}
          </span>
        ) : (
          <Tip label={sentinels.length ? `Run its ${sentinels.length === 1 ? 'sentinel' : `${sentinels.length} sentinels`} now, one at a time` : 'Its sentinels are paused or gone'}>
            <IconButton icon="refresh" label="Refresh" disabled={!sentinels.length} onClick={() => void a.act(() => api.dashboard.refresh(d.id))} />
          </Tip>
        )}
        <ActionsDropdown items={more}>
          <IconButton icon="more" label={`More for ${d.name}`} />
        </ActionsDropdown>
      </SectionHead>
      <AskLine d={d} />
      {scope ? (
        <Grid d={d} state={state} projects={projects} tiles={d.tiles.filter((x) => x.kind !== 'divider' && inScope({ projectId: tileProject(state, x, projects)?.id }, scope) && tileProject(state, x, projects))} />
      ) : grouped ? (
        <GroupedGrid d={d} state={state} projects={projects} />
      ) : (
        <Grid d={d} state={state} projects={projects} />
      )}
      {children}
    </section>
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
      {/* What Claude needs your OK for while it builds this (it works in a quiet chat of its own). */}
      {ask ? <Attention channel={ask.channel} /> : null}
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
  /** Where it was lifted from (among the others): dropped back there, nothing moves. */
  readonly from: number;
  readonly dx: number;
  readonly dy: number;
  readonly w: number;
  readonly h: number;
  x: number;
  y: number;
  index: number | undefined;
}

/** The tiles, dragged into place: a pointer that moves past a few pixels lifts the tile; where it drops is worked out from the others' boxes. */
/** Tiles under their project's name (the board's own order inside each); dividers are left out, and tiles aren't dragged here. */
function GroupedGrid({ d, state, projects }: { d: Dashboard; state: SentinelState; projects: ReadonlyArray<{ readonly id: string; readonly name: string }> }) {
  const groups = new Map<string, { id?: string; name: string; tiles: Tile[] }>();
  for (const tile of d.tiles) {
    if (tile.kind === 'divider') continue;
    const p = tileProject(state, tile, projects) ?? { name: 'Gone' };
    const key = p.id ?? p.name;
    const g = groups.get(key) ?? { ...(p.id ? { id: p.id } : {}), name: p.name, tiles: [] };
    g.tiles.push(tile);
    groups.set(key, g);
  }
  return (
    <>
      {[...groups.values()].map((g) => (
        <div key={g.id ?? g.name} className={n.tileGroup} role="group" aria-label={g.name}>
          <div className={n.tileGroupHead}>
            {g.id ? <ProjectIcon id={g.id} name={g.name} size={14} /> : <Icon name="laptop" size={13} />}
            {g.name}
          </div>
          <Grid d={d} state={state} tiles={g.tiles} projects={projects} />
        </div>
      ))}
    </>
  );
}

function Grid({ d, state, tiles: only, projects = [] }: { d: Dashboard; state: SentinelState; tiles?: readonly Tile[]; projects?: ReadonlyArray<{ readonly id: string; readonly name: string }> }) {
  const api = useApi();
  const a = useSentinelActions();
  const grid = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>();
  const start = useRef<{ id: string; x: number; y: number; box: DOMRect } | undefined>(undefined);
  const others = useRef<ReturnType<typeof boxesOf>>([]);
  // Dropped: the board shows the new order at once, until the saved board comes back with it.
  const [moved, setMoved] = useState<{ readonly id: string; readonly index: number; readonly tiles: readonly Tile[] }>();

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
        if (now && now.index !== undefined && now.index !== now.from) {
          const { id, index } = now;
          setMoved({ id, index, tiles: d.tiles });
          void a.act(() => api.dashboard.moveTile(d.id, id, index));
        }
        return undefined;
      });
      start.current = undefined;
    };
    // Escape puts it back where it was.
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setDrag(undefined);
      start.current = undefined;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('keydown', key);
    document.documentElement.dataset.dragging = 'tile';
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
      delete document.documentElement.dataset.dragging;
    };
  }, [drag !== undefined, a, api, d.id]);

  const down = (e: React.PointerEvent<HTMLElement>, id: string): void => {
    // A part of the board (one project's tiles) keeps the board's order: tiles move on the whole board.
    if (only) return;
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, a, [role="menu"], [data-resize], .recharts-wrapper')) return;
    const box = (e.currentTarget.closest('[data-tile]') as HTMLElement).getBoundingClientRect();
    start.current = { id, x: e.clientX, y: e.clientY, box };
  };
  const moveStart = (e: React.PointerEvent<HTMLElement>): void => {
    const s = start.current;
    if (!s || drag || !isDrag(e.clientX - s.x, e.clientY - s.y)) return;
    others.current = boxesOf(s.id);
    measure();
    // Its place stays open where it was until the pointer goes somewhere else.
    const from = tiles.findIndex((x) => x.id === s.id);
    setDrag({ id: s.id, from, dx: s.x - s.box.left, dy: s.y - s.box.top, w: s.box.width, h: s.box.height, x: e.clientX, y: e.clientY, index: from });
  };

  const tiles = only ?? (moved && moved.tiles === d.tiles ? moveTile(d.tiles, moved.id, moved.index) : d.tiles);
  const rest = drag ? tiles.filter((x) => x.id !== drag.id) : tiles;
  const lifted = drag ? tiles.find((x) => x.id === drag.id) : undefined;
  const measure = useGlide(grid, `${rest.map((x) => `${x.id}:${x.width}:${x.height ?? 1}`).join(' ')}|${drag?.index ?? ''}`);

  const at = drag?.index;
  const gapStyle = (tile: Tile): React.CSSProperties => ({ gridColumn: `span ${tile.kind === 'divider' ? 6 : tile.width}`, ...(drag ? { minHeight: drag.h } : {}) });
  return (
    <div ref={grid} className={n.grid} role="list" aria-label={`${d.name}’s tiles`} onPointerMove={moveStart} onPointerUp={() => (start.current = undefined)}>
      {rest.map((tile, i) => (
        <TileSlot key={tile.id} before={at === i && lifted ? gapStyle(lifted) : undefined}>
          <TileCell d={d} tile={tile} state={state} source={tileProject(state, tile, projects)} movable={!only} onPointerDown={(e) => down(e, tile.id)} />
        </TileSlot>
      ))}
      {lifted && at !== undefined && at >= rest.length ? <div className={n.gap} data-w={lifted.width} style={gapStyle(lifted)} /> : null}
      {lifted && drag ? (
        <div className={n.ghost} style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.w, height: drag.h }} aria-hidden="true">
          <TileCell d={d} tile={lifted} state={state} ghost />
        </div>
      ) : null}
      {drag || only ? null : (
        <button type="button" className={n.addCell} data-first={d.tiles.length ? undefined : ''} onClick={() => openSheet({ kind: 'add_tile', dashboardId: d.id })} aria-label="Add to the board">
          <Icon name="plus" size={14} />
          <span>{d.tiles.length ? 'Add' : 'Add a number, a chart or what Claude wrote'}</span>
        </button>
      )}
    </div>
  );
}

function TileSlot({ before, children }: { before: React.CSSProperties | undefined; children: React.ReactNode }) {
  return (
    <>
      {before ? <div className={n.gap} style={before} /> : null}
      {children}
    </>
  );
}

const still = (): boolean => document.documentElement.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Tiles glide to their new places when the order changes (a tile lifted, the gap moving, a drop)
 * instead of jumping: each starts where it was and slides home (FLIP). Still with reduced motion.
 */
function useGlide(grid: React.RefObject<HTMLDivElement | null>, order: string): () => void {
  const was = useRef(new Map<string, { x: number; y: number }>());
  // Each tile's place in the grid (not the window: scrolling moves nothing).
  const places = (): { els: HTMLElement[]; at: Map<string, { x: number; y: number }> } => {
    const box = grid.current?.getBoundingClientRect();
    const els = [...(grid.current?.querySelectorAll<HTMLElement>(':scope > [data-tile]') ?? [])];
    return { els, at: new Map(els.map((el) => { const r = el.getBoundingClientRect(); return [el.dataset.tile!, { x: r.left - (box?.left ?? 0), y: r.top - (box?.top ?? 0) }] as const; })) };
  };
  useLayoutEffect(() => {
    for (const el of grid.current?.querySelectorAll<HTMLElement>(':scope > [data-tile]') ?? []) for (const x of el.getAnimations()) x.cancel();
    const { els, at } = places();
    if (!still()) {
      for (const el of els) {
        const from = was.current.get(el.dataset.tile!);
        const to = at.get(el.dataset.tile!);
        if (!from || !to) continue;
        const dx = from.x - to.x;
        const dy = from.y - to.y;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
    }
    was.current = at;
  }, [order]);
  // Measured again just before a drag lifts a tile (the window or a tile may have changed size since).
  return () => {
    was.current = places().at;
  };
}

const noop = (): void => undefined;
/** The grid's gap (numbers.module.css .grid), for working out a column's width. */
const GAP = 10;
/** A tile's least height, normal and tall (numbers.module.css .cell). */
const NORMAL = 110;
const TALL = 300;
const SHOW_WORDS: Readonly<Record<OutputShow, string>> = { auto: 'As it reads', markdown: 'Markdown', tree: 'A JSON tree', table: 'A table', text: 'Plain text' };

type Source = ReturnType<typeof tileProject>;

function TileCell({ d, tile, state, source, movable, onPointerDown, ghost }: { d: Dashboard; tile: Tile; state: SentinelState; source?: Source; movable?: boolean; onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void; ghost?: boolean }) {
  // Its project's logo in the corner, and a soft wash of the project's colour (changeable from ⋯ › Tint).
  const tint = useProjectTint(source?.id, source?.name ?? '');
  const mark = source ? (
    <Tip label={`From ${source.sentinel} · ${source.name}`}>
      <span className={n.source} aria-label={`From ${source.sentinel}, ${source.name}`}>
        {source.id ? <ProjectIcon id={source.id} name={source.name} size={14} /> : <Icon name="laptop" size={13} />}
      </span>
    </Tip>
  ) : null;
  const api = useApi();
  const a = useSentinelActions();
  const [renaming, setRenaming] = useState(false);
  // Dragging its corner: the size it would land on (and that outline's size on screen), shown while the pointer moves.
  const [sizing, setSizing] = useState<{ readonly w: TileWidth; readonly h: TileHeight; readonly width: number; readonly height: number }>();
  // A desktop widget of this tile was clicked: the board scrolls to it and marks it for a moment.
  const [shown, setShown] = useState(false);
  const cellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ghost) return;
    const on = (e: Event): void => {
      if ((e as CustomEvent<string>).detail !== tile.id) return;
      cellRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setShown(true);
      setTimeout(() => setShown(false), 1600);
    };
    document.addEventListener(SHOW_TILE, on);
    return () => document.removeEventListener(SHOW_TILE, on);
  }, [tile.id, ghost]);
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
    ...(tile.kind === 'divider'
      ? []
      : [
          {
            label: 'Add to Desktop…',
            icon: 'laptop' as const,
            hint: 'As a macOS widget that updates when its sentinel runs',
            separate: true,
            onSelect: () =>
              openSheet({
                kind: 'confirm',
                title: `Put “${cap.title}” on your desktop`,
                message: `Right-click your desktop and choose Edit Widgets, search for Beluga, and drag Board tile where you want it (small, medium or large). Then right-click the widget, choose Edit “Board tile”, and pick “${cap.title}” (${d.name}). It updates each time its sentinel runs, and clicking it opens this board. macOS doesn’t let an app place a widget itself.`,
                confirm: 'Got It',
                run: noop,
              }),
          },
        ]),
    ...(source?.id
      ? [
          {
            label: 'Tint',
            icon: 'palette' as const,
            hint: `For every tile from ${source.name}`,
            separate: true,
            onSelect: noop,
            submenu: [
              { label: 'From its icon', checked: tintChoiceOf(source.id) === 'auto', onSelect: () => setTintChoice(source.id!, 'auto') },
              ...TINTS.map((t) => ({ label: t.label, swatch: t.color, checked: tintChoiceOf(source.id!) === t.id, onSelect: () => setTintChoice(source.id!, t.id) })),
              { label: 'None', checked: tintChoiceOf(source.id) === 'none', onSelect: () => setTintChoice(source.id!, 'none') },
            ],
          },
        ]
      : []),
    { label: 'Remove Tile', danger: true, separate: true, onSelect: () => void a.act(() => api.dashboard.removeTile(d.id, tile.id)) },
  ];
  /**
   * The corner: drag it across the grid's columns (it snaps to 1, 2, 3, 4 or 6 of 6) and down for
   * tall. The tile stays put while you drag; an outline shows the size it lands on, and the board
   * moves once, when you let go. Escape leaves it as it was.
   */
  const resize = (e: React.PointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cell = e.currentTarget.closest<HTMLElement>('[data-tile]');
    const grid = cell?.parentElement;
    if (!cell || !grid) return;
    const box = cell.getBoundingClientRect();
    const room = grid.getBoundingClientRect();
    const column = (room.width + GAP) / GRID_COLUMNS;
    const from = { w: tile.width, h: tile.height ?? 1 };
    const heightOf = (h: TileHeight): number => (h === from.h ? box.height : h === 2 ? Math.max(TALL, box.height * 2 + GAP) : Math.max(NORMAL, (box.height - GAP) / 2));
    let to = from;
    const move = (ev: PointerEvent): void => {
      const tall = from.h === 2 ? ev.clientY - box.top > box.height * 0.7 : ev.clientY - box.top > box.height * 1.4;
      to = { w: snapWidth((ev.clientX - box.left + GAP) / column), h: tall ? 2 : 1 };
      // Never drawn past the board's edge (a tile too wide for its row goes to the next one).
      setSizing({ ...to, width: Math.min(to.w * column - GAP, room.right - box.left), height: heightOf(to.h) });
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
      delete document.documentElement.dataset.dragging;
      setSizing(undefined);
    };
    const up = (): void => {
      stop();
      if (to.w !== from.w || to.h !== from.h) update({ width: to.w, height: to.h });
    };
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      stop();
    };
    document.documentElement.dataset.dragging = 'resize';
    setSizing({ ...from, width: box.width, height: box.height });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('keydown', key);
  };
  const corner = ghost ? null : (
    <>
      <span className={n.resize} data-resize="" onPointerDown={resize} role="separator" aria-label={`Resize ${cap.title || 'this tile'}: drag the corner`} title="Drag to resize">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M9 3.5 3.5 9M9 7 7 9" />
        </svg>
      </span>
      {sizing ? (
        <span className={n.sizeOutline} style={{ width: sizing.width, height: sizing.height }} aria-hidden="true">
          <span className={n.sizing}>
            {WIDTH_WORDS[sizing.w].replace(/ \(.*\)$/, '')}
            {sizing.h === 2 ? ' · tall' : ''}
          </span>
        </span>
      ) : null}
    </>
  );
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
      {mark}
      {renaming ? <TitleInput title={tile.title ?? cap.title} done={(title) => (setRenaming(false), title !== (tile.title ?? cap.title) && update({ title }))} /> : <span className={n.cellTitle}>{cap.title}</span>}
      {cap.from && tile.kind !== 'text' && cap.from !== cap.title ? <span className={n.cellFrom}>{cap.from}</span> : null}
      {note ? <span className={n.note}>{note}</span> : tile.compare && tile.kind !== 'number' ? <span className={n.note}>{COMPARE_WORDS[tile.compare]}</span> : null}
      {more}
    </div>
  );
  return (
    <div ref={cellRef} className={n.cell} data-shown={shown || undefined} data-tile={tile.id} data-kind={tile.kind} data-w={tile.width} data-h={tile.height ?? 1} data-movable={movable && !ghost ? '' : undefined} data-sizing={sizing ? '' : undefined} data-state={cap.state} data-tinted={tint ? '' : undefined} style={tint ? ({ '--tint': tint } as React.CSSProperties) : undefined} role="listitem" onPointerDown={onPointerDown}>
      {tile.kind === 'number' ? null : head}
      <div className={n.cellBody}>
        <TileBody d={d} tile={tile} state={state} compare={compare} note={note} lead={tile.kind === 'number' ? mark : null} more={tile.kind === 'number' ? more : null} />
      </div>
      {corner}
    </div>
  );
}

function TileBody({ d, tile, state, compare, note, lead, more }: { d: Dashboard; tile: Tile; state: SentinelState; compare: Compare; note: string | undefined; lead?: React.ReactNode; more: React.ReactNode }) {
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
    return <NumberFit m={m} compare={compare} title={tileCaption(state, tile).title} note={note} lead={lead} more={more} onRun={(runId) => a.openRun(runId)} />;
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

/**
 * A number that fits its tile: the value, its change and a sparkline when small; given more room
 * (taller or wider), its points over time fill the rest and the sparkline steps aside. The value
 * grows with the tile.
 */
function NumberFit({ m, compare, title, note, lead, more, onRun }: { m: MetricSeries; compare: Compare; title: string; note: string | undefined; lead?: React.ReactNode; more: React.ReactNode; onRun: (runId: string) => void }) {
  const [filled, setFilled] = useState(false);
  const series = useMemo(() => [m], [m]);
  return (
    <div className={n.numberFit} data-look={filled ? 'chart' : 'number'}>
      <NumberTile w={numberWords(m, compare, title)} spark={!filled} lead={lead} {...(note ? { note } : {})}>
        {more}
      </NumberTile>
      <FillChart series={series} onRun={onRun} onFit={setFilled} />
    </div>
  );
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
