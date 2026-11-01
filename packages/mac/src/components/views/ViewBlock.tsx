import { Suspense, lazy, memo, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { type ChartKind, type Column, type Row, type View, type ViewType, describeSource, parseView } from '@beluga/shared/view-spec.js';
import { ActionsContext, type ActionItem } from '../SpecMenu.js';
import { CodeLines } from '../markdown/CodeLines.js';
import { useCopied } from '../markdown/CodeBlock.js';
import { Icon, type IconName } from '../Icon.js';
import { IconButton, Tip, cx } from '../ui.js';
import { copyRich, copyText } from '../../lib/copy.js';
import { toast, useBeluga } from '../../lib/beluga.js';
import { useActions } from '../../lib/actions.js';
import { useClock } from '../../lib/window-active.js';
import { type ViewData, useViewData, useVisible } from './use-view-data.js';
import { ago, isNumeric, toCsv, toHtmlTable, toMarkdownTable } from './format.js';
import { DataTable } from './Table.js';
import { StatTiles } from './Stats.js';
import { CodeView } from './Code.js';
import { ColorsView } from './Colors.js';
import { ControlsBar } from './Controls.js';
import { GanttView } from './Gantt.js';
import { HeatmapView } from './Heatmap.js';
import { CalendarView } from './Calendar.js';
import { tableRows, tableView } from './md-table.js';
import v from './views.module.css';

/**
 * A ```beluga-view block (or ```beluga-table, ```beluga-chart…) wherever Markdown is drawn: a
 * card with the element in it. Tables page, sort and search; a table turns into a chart and back;
 * a source (your own Claude's) is fetched for more and refreshed, live. While Claude is still
 * writing the block it says so; a block that's wrong says what's wrong and shows its JSON.
 */

const Chart = lazy(() => import('./Chart.js'));

const ICON: Record<ViewType, IconName> = { table: 'table', chart: 'chartLine', stats: 'gauge', code: 'command', colors: 'palette', gantt: 'gantt', heatmap: 'heat', calendar: 'calendar' };
const NOUN: Record<ViewType, string> = { table: 'a table', chart: 'a chart', stats: 'stats', code: 'code', colors: 'colors', gantt: 'a timeline', heatmap: 'a heatmap', calendar: 'a calendar' };
/** Views drawn from all their rows at once (not a page of them). */
const WHOLE: ReadonlySet<ViewType> = new Set(['chart', 'gantt', 'heatmap', 'calendar']);

export const ViewBlock = memo(function ViewBlock({ code, type, live = false, local = false }: { code: string; type?: ViewType | 'any'; live?: boolean; local?: boolean }) {
  const parsed = useMemo(() => parseView(code, type === 'any' ? undefined : type), [code, type]);
  if (!parsed.ok) {
    if (parsed.incomplete && live) {
      return (
        <figure className={v.card} data-state="drawing" aria-label="View">
          <div className={v.drawing}>
            <Icon name={type && type !== 'any' ? ICON[type] : 'grid'} size={14} />
            Showing {type && type !== 'any' ? NOUN[type] : 'data'}…
          </div>
        </figure>
      );
    }
    return (
      <figure className={v.cardError} data-state="error">
        <figcaption>Can’t show this: {parsed.error}</figcaption>
        <CodeLines text={code} lang="json" />
      </figure>
    );
  }
  return <ViewCard view={parsed.view} code={code} warnings={parsed.warnings} local={local} />;
});

/** What a table can be shown as. */
type Shape = 'table' | ChartKind;

function chartable(view: View, data: ViewData): boolean {
  return data.columns.some(isNumeric) && data.columns.length >= 2 && view.type !== 'stats';
}

function ViewCard({ view, code, warnings, local, bare = false }: { view: View; code: string; warnings: readonly string[]; local: boolean; bare?: boolean }) {
  const { client } = useBeluga();
  const [ref, visible] = useVisible<HTMLElement>();
  const [shape, setShape] = useState<Shape>(view.type === 'chart' ? view.chart : 'table');
  const [full, setFull] = useState(false);
  const asChart = view.type === 'chart' || (view.type === 'table' && shape !== 'table');
  const data = useViewData(view, { local, visible, ...(asChart || WHOLE.has(view.type) ? { limit: Math.max(view.pageSize, 500) } : {}), ...(view.type === 'code' ? { text: true } : {}) });
  const copyJson = (): void => void copyText(JSON.stringify(JSON.parse(code), null, 2)).then(() => toast(client, 'Copied as JSON', 'success'));
  const rowsCopied = (n: number, as = ''): string => `Copied ${n} ${n === 1 ? 'row' : 'rows'}${as}`;
  const copyCsv = (): void => {
    const rows = data.allRows();
    void copyText(toCsv(rows, data.columns)).then(() => toast(client, rowsCopied(rows.length, ' as CSV'), 'success'));
  };
  // A table copies as a table: HTML for Sheets, Numbers, Docs and Notion; Markdown for everything else.
  const [copied, copy] = useCopied();
  const tableCopy = view.type === 'table' && data.rows.length > 0;
  const copyTable = (): void =>
    copy(() => {
      const rows = data.allRows();
      const columns = data.columns.filter((c) => !c.hidden);
      return copyRich(toHtmlTable(rows, columns), toMarkdownTable(rows, columns)).then(() => toast(client, rowsCopied(rows.length), 'success'));
    });
  const items: ActionItem[] = [
    ...(view.type !== 'code' && view.type !== 'colors' ? [{ label: 'Open in Full Window', icon: 'expand' as const, onSelect: () => setFull(true) }] : []),
    ...(tableCopy ? [{ label: 'Copy Table', icon: 'copy' as const, onSelect: copyTable }] : []),
    ...(data.rows.length ? [{ label: 'Copy as CSV', icon: 'copy' as const, onSelect: copyCsv }] : []),
    { label: 'Copy as JSON', icon: 'copy', onSelect: copyJson },
    ...(data.mode === 'live' ? [{ label: 'Refresh', icon: 'refresh' as const, onSelect: data.refresh }] : []),
  ];
  const body = (inFull: boolean) => <Body view={view} data={data} shape={asChart ? (view.type === 'chart' && shape === 'table' ? view.chart : shape) : 'table'} full={inFull} />;
  const canSwitch = (view.type === 'table' || view.type === 'chart') && chartable(view, data);
  // Opened from the welcome (the tour's table): over it, not hidden behind it.
  const overWelcome = full && document.querySelector('[data-welcome]') ? '' : undefined;
  return (
    <>
      <ActionsContext items={items}>
        <figure ref={ref} className={cx(v.card, bare && v.bare)} data-type={view.type} data-state="ready" aria-label={view.title ? `${label(view.type)}: ${view.title}` : label(view.type)}>
          <Head view={view} data={data} warnings={warnings} shape={shape} setShape={canSwitch ? setShape : undefined} copy={tableCopy ? { copied, onCopy: copyTable } : undefined} onExpand={!bare && items[0]?.label === 'Open in Full Window' ? () => setFull(true) : undefined} bare={bare} />
          <ControlsBar view={view} data={data} />
          {data.needsApproval ? <Approve command={data.needsApproval} onRun={data.approve} /> : null}
          {data.error ? (
            <div className={v.problem} role="alert">
              <Icon name="alert" size={13} />
              <span>Couldn’t load it: {data.error}</span>
              {data.mode === 'live' ? (
                <button type="button" className={v.linkButton} onClick={data.refresh}>
                  Try Again
                </button>
              ) : null}
            </div>
          ) : null}
          {body(false)}
          <Foot view={view} data={data} />
        </figure>
      </ActionsContext>
      {full ? (
        <Dialog.Root open onOpenChange={(open) => (open ? undefined : setFull(false))}>
          <Dialog.Portal>
            <Dialog.Overlay className={v.fullOverlay} data-over-welcome={overWelcome} />
            <Dialog.Content className={v.full} data-over-welcome={overWelcome} aria-describedby={undefined} onOpenAutoFocus={(e) => e.preventDefault()}>
              <Head view={view} data={data} warnings={warnings} shape={shape} setShape={canSwitch ? setShape : undefined} copy={tableCopy ? { copied, onCopy: copyTable } : undefined} inFull onClose={() => setFull(false)} />
              <ControlsBar view={view} data={data} />
              <div className={v.fullBody}>{body(true)}</div>
              <Foot view={view} data={data} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  );
}

const LABEL: Record<ViewType, string> = { table: 'Table', chart: 'Chart', stats: 'Stats', code: 'Code', colors: 'Colors', gantt: 'Timeline', heatmap: 'Heatmap', calendar: 'Calendar' };
const label = (t: ViewType): string => LABEL[t];

function Body({ view, data, shape, full }: { view: View; data: ViewData; shape: Shape; full: boolean }) {
  switch (view.type) {
    case 'stats':
      return <StatTiles view={view} data={data} />;
    case 'code':
      return <CodeView view={view} data={data} />;
    case 'colors':
      return <ColorsView view={view} />;
    case 'gantt':
      return <GanttView view={view} data={data} full={full} />;
    case 'heatmap':
      return <HeatmapView view={view} data={data} />;
    case 'calendar':
      return <CalendarView view={view} data={data} />;
    default:
      if (shape === 'table') return <DataTable view={view} data={data} full={full} />;
      return (
        <Suspense fallback={<div className={v.chartWait} style={{ height: view.height ?? 260 }} />}>
          <Chart view={view} data={data} kind={shape} full={full} />
        </Suspense>
      );
  }
}

const SHAPES: ReadonlyArray<{ shape: Shape; icon: IconName; label: string }> = [
  { shape: 'table', icon: 'table', label: 'Table' },
  { shape: 'line', icon: 'chartLine', label: 'Line Chart' },
  { shape: 'area', icon: 'chartArea', label: 'Area Chart' },
  { shape: 'bar', icon: 'chartBar', label: 'Bar Chart' },
];

function Head({ view, data, warnings, shape, setShape, copy, onExpand, inFull, onClose, bare = false }: { view: View; data: ViewData; warnings: readonly string[]; shape: Shape; setShape?: ((s: Shape) => void) | undefined; copy?: { copied: boolean; onCopy: () => void } | undefined; onExpand?: (() => void) | undefined; inFull?: boolean; onClose?: () => void; bare?: boolean }) {
  const actions = useActions();
  const now = useClock(data.at !== undefined, 15_000);
  const live = data.mode === 'live' && Boolean(data.source?.refresh);
  const TitleTag = inFull ? Dialog.Title : 'span';
  return (
    <figcaption className={cx(v.head, bare && v.headBare)}>
      <span className={v.chip} aria-hidden="true">
        <Icon name={ICON[view.type]} size={13} />
      </span>
      <span className={v.titles}>
        <TitleTag className={v.title}>{view.title ?? label(view.type)}</TitleTag>
        {view.summary ? <span className={v.summary}>{view.summary}</span> : null}
      </span>
      <span className={v.tools}>
        {warnings.length ? (
          <Tip label={warnings.join('\n')}>
            <span className={v.note}>{warnings.length} left out</span>
          </Tip>
        ) : null}
        {data.mode === 'live' && (data.at || data.loading || live) ? (
          <Tip label={data.at ? `Fetched ${new Date(data.at).toLocaleString()}` : 'Live'}>
            <span className={cx(v.status, live && v.statusLive, data.loading && v.statusBusy)}>
              <span className={v.dot} />
              {data.loading ? 'Loading' : live ? 'Live' : data.at ? ago(data.at, now) : 'Live'}
            </span>
          </Tip>
        ) : data.mode === 'snapshot' && data.at ? (
          <Tip label="These rows are from when the agent fetched them. Its source runs on its owner’s computer.">
            <span className={v.status}>{ago(data.at, now)}</span>
          </Tip>
        ) : null}
        {setShape ? (
          <span className={v.segment} role="radiogroup" aria-label="Show as">
            {SHAPES.map((s) => (
              <Tip key={s.shape} label={s.label}>
                <button type="button" role="radio" aria-checked={shape === s.shape} aria-label={s.label} className={cx(v.segmentItem, shape === s.shape && v.segmentOn)} onClick={() => setShape(s.shape)}>
                  <Icon name={s.icon} size={12} />
                </button>
              </Tip>
            ))}
          </span>
        ) : null}
        {view.actions.map((a) => (
          <button
            key={a.label}
            type="button"
            className={cx(v.action, a.source && data.switched && data.source === a.source && v.actionOn)}
            onClick={() => {
              if (a.source) data.useSource(data.source === a.source ? undefined : a.source);
              else if (a.href) actions.openLink(/^https?:/i.test(a.href) ? { kind: 'url', url: a.href } : { kind: 'local', path: a.href, dir: a.href.endsWith('/') });
              else if (a.copy !== undefined) void copyText(a.copy);
            }}
          >
            {a.href ? <Icon name="external" size={11} /> : a.copy !== undefined ? <Icon name="copy" size={11} /> : null}
            {a.label}
          </button>
        ))}
        {copy ? <IconButton icon={copy.copied ? 'check' : 'copy'} label={copy.copied ? 'Copied' : 'Copy Table'} className={cx(v.iconTool, copy.copied && v.iconDone)} onClick={copy.onCopy} /> : null}
        {data.mode === 'live' ? <IconButton icon="refresh" label="Refresh" className={cx(v.iconTool, data.loading && v.spinning)} onClick={data.refresh} /> : null}
        {onExpand ? <IconButton icon="expand" label="Open in Full Window" className={v.iconTool} onClick={onExpand} /> : null}
        {onClose ? (
          <Dialog.Close asChild>
            <IconButton icon="x" label="Close" keys="esc" className={v.iconTool} />
          </Dialog.Close>
        ) : null}
      </span>
    </figcaption>
  );
}

/** A command Claude wrote by hand (not through its tool) runs once you press Load; after that, by itself. */
function Approve({ command, onRun }: { command: string; onRun: () => void }) {
  return (
    <div className={v.approve}>
      <button type="button" className={v.primary} onClick={onRun}>
        <Icon name="play" size={11} />
        Load
      </button>
      <Tip label={command}>
        <code className={v.approveCode}>{command}</code>
      </Tip>
    </div>
  );
}

function Foot({ view, data }: { view: View; data: ViewData }) {
  if (!data.source || view.type === 'colors') return null;
  const kind = data.source.kind;
  return (
    <div className={v.foot}>
      <Icon name={kind === 'http' ? 'globe' : kind === 'folder' ? 'folder' : kind === 'file' ? 'file' : kind === 'command' ? 'terminal' : 'grid'} size={11} />
      <span className={v.sourceText} title={describeSource(data.source)}>
        {kind === 'sqlite' ? 'SQLite' : kind === 'postgres' ? 'Postgres' : kind === 'http' ? 'Web' : kind === 'command' ? 'Command' : kind === 'folder' ? 'Folder' : 'File'} · {describeSource(data.source)}
      </span>
      {data.mode === 'snapshot' ? <span className={v.footNote}>Live on its owner’s computer</span> : data.source.refresh ? <span className={v.footNote}>Every {data.source.refresh}s</span> : null}
    </div>
  );
}

/**
 * A plain Markdown table in an answer (md-table.ts), drawn as a table view: it sorts by its
 * headings, searches when it's long, turns into a chart when it has numbers. Its tools show on hover.
 */
export function MarkdownTable({ node, fallback }: { node: unknown; fallback: React.ReactNode }) {
  const view = useMemo(() => {
    const t = tableRows(node as Parameters<typeof tableRows>[0]);
    return t ? tableView(t) : undefined;
  }, [node]);
  const code = useMemo(() => (view ? JSON.stringify({ type: 'table', data: view.rows }) : ''), [view]);
  return view ? <ViewCard view={view} code={code} warnings={[]} local={false} bare /> : <PlainTable>{fallback}</PlainTable>;
}

/** A table that stays as written (it has links): Copy on hover takes it as drawn, links and all. */
function PlainTable({ children }: { children: React.ReactNode }) {
  const { client } = useBeluga();
  const box = useRef<HTMLDivElement>(null);
  const [copied, copy] = useCopied();
  const onCopy = (): void =>
    copy(() => {
      const table = box.current?.querySelector('table');
      if (!table) return Promise.resolve();
      const lines = [...table.rows].map((tr) => [...tr.cells].map((td) => td.innerText.trim()));
      const columns: Column[] = (lines[0] ?? []).map((label, i) => ({ key: String(i), label, type: 'text' }));
      const rows: Row[] = lines.slice(1).map((cells) => Object.fromEntries(cells.map((t, i) => [String(i), t])));
      return copyRich(table.outerHTML, toMarkdownTable(rows, columns)).then(() => toast(client, `Copied ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`, 'success'));
    });
  return (
    <div ref={box} className={v.plainTable}>
      <span className={v.plainTools}>
        <IconButton icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : 'Copy Table'} className={cx(v.iconTool, copied && v.iconDone)} onClick={onCopy} />
      </span>
      {children}
    </div>
  );
}
