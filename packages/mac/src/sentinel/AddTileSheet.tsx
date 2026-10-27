import { useMemo, useState } from 'react';
import { type ChartTileKind, type MetricRef, type TileKind, type TileWidth, DEFAULT_WIDTH, TILE_INFO, metricOf } from '@beluga/core/sentinel/dashboard-model.js';
import type { Args } from '@beluga/ipc/api.js';
import { FormSheet, Popup, TextInput } from '../components/FormSheet.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Segmented } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { MetricChart, NumberTile, RowsTable } from './NumberParts.js';
import { type MetricChoice, metricChoices, numberWords } from './numbers-model.js';
import { useSentinelActions, useSentinelState } from './use-sentinel.js';
import n from './numbers.module.css';

/**
 * Add a Tile (docs/sentinel.md §10): what kind, then which numbers (every metric any sentinel
 * keeps, by project and sentinel, with its last value), how wide, and its own title; the tile as it
 * will look is shown underneath. A tile names a sentinel and a metric, never its source.
 */

const KINDS: ReadonlyArray<{ readonly value: TileKind; readonly label: string; readonly icon: IconName; readonly hint: string }> = [
  { value: 'number', label: 'Number', icon: 'gauge', hint: TILE_INFO.number.hint },
  { value: 'chart', label: 'Chart', icon: 'chartLine', hint: TILE_INFO.chart.hint },
  { value: 'table', label: 'Table', icon: 'table', hint: TILE_INFO.table.hint },
  { value: 'text', label: 'Text', icon: 'file', hint: TILE_INFO.text.hint },
  { value: 'divider', label: 'Divider', icon: 'minus', hint: TILE_INFO.divider.hint },
];

const key = (r: MetricRef): string => `${r.sentinelId}/${r.metric}`;

export function AddTileSheet({ dashboardId, close }: { dashboardId: string; close: () => void }) {
  const api = useApi();
  const a = useSentinelActions();
  const state = useSentinelState();
  const projects = useApp((st) => st.projects);
  const d = state.dashboards?.find((x) => x.id === dashboardId);
  const [kind, setKind] = useState<TileKind>('number');
  const [picked, setPicked] = useState<readonly MetricRef[]>([]);
  const [sentinelId, setSentinelId] = useState<string>(state.items[0]?.id ?? '');
  const [text, setText] = useState<'headline' | 'report'>('headline');
  const [chart, setChart] = useState<ChartTileKind>('line');
  const [width, setWidth] = useState<TileWidth | undefined>();
  const [title, setTitle] = useState('');
  const choices = useMemo(() => metricChoices(state, (id) => projects.find((p) => p.id === id)?.name ?? 'Your Mac', d), [state, projects, d]);
  const shown = choices.filter((c) => (kind === 'table' ? c.kind === 'rows' : kind === 'number' || kind === 'chart' ? c.kind === 'number' : false));
  const many = kind === 'chart';
  const toggle = (c: MetricChoice): void => setPicked((now) => (now.some((r) => key(r) === key(c.ref)) ? now.filter((r) => key(r) !== key(c.ref)) : many ? [...now, c.ref].slice(0, 8) : [c.ref]));
  const changeKind = (k: TileKind): void => {
    setKind(k);
    setWidth(undefined);
    // A number and a chart pick from the same numbers; a table from rows.
    if (k === 'table' || kind === 'table') setPicked([]);
    else if (k === 'number') setPicked((now) => now.slice(0, 1));
  };
  const w = width ?? DEFAULT_WIDTH[kind];
  const ready = kind === 'divider' ? Boolean(title.trim()) : kind === 'text' ? Boolean(sentinelId) : picked.length > 0;
  const submit = async (): Promise<string | void> => {
    const tile: Args<'dashboard.addTile'>[1] =
      kind === 'divider'
        ? { kind, title: title.trim() }
        : kind === 'text'
          ? { kind, sentinelId, text, width: w, ...(title.trim() ? { title: title.trim() } : {}) }
          : kind === 'chart'
            ? { kind, metrics: [...picked], chart, width: w, ...(title.trim() ? { title: title.trim() } : {}) }
            : { kind, metric: picked[0]!, width: w, ...(title.trim() ? { title: title.trim() } : {}) };
    const done = await a.act(() => api.dashboard.addTile(dashboardId, tile));
    if (!done) return 'Couldn’t add it: see the message above';
    close();
  };
  // Grouped by project, then sentinel, as the list shows them.
  const groups = useMemo(() => {
    const out: Array<{ readonly head: string; readonly items: MetricChoice[] }> = [];
    for (const c of shown) {
      const head = `${c.project} · ${c.sentinel}`;
      const g = out.at(-1);
      if (g?.head === head) g.items.push(c);
      else out.push({ head, items: [c] });
    }
    return out;
  }, [shown]);
  return (
    <FormSheet title="Add a Tile" icon="gauge" intro={d ? `On “${d.name}”. Tiles show the numbers sentinels keep; drag them into place afterwards.` : undefined} submitLabel="Add Tile" canSubmit={ready} width={620} onCancel={close} onSubmit={submit}>
      <div className={n.sheet}>
        <div className={n.kinds}>
          <Segmented<TileKind> label="What kind of tile" value={kind} onChange={changeKind} options={KINDS} />
        </div>
        {kind === 'number' || kind === 'chart' || kind === 'table' ? (
          shown.length ? (
            <div className={n.picker} role={many ? 'group' : 'radiogroup'} aria-label={kind === 'table' ? 'Tables' : 'Numbers'}>
              {groups.map((g) => (
                <div key={g.head} role="presentation">
                  <div className={n.group}>{g.head}</div>
                  {g.items.map((c) => {
                    const on = picked.some((r) => key(r) === key(c.ref));
                    return (
                      <button key={key(c.ref)} type="button" role={many ? 'checkbox' : 'radio'} aria-checked={on} className={n.pick} onClick={() => toggle(c)} data-metric={c.ref.metric}>
                        {on ? <Icon name="check" size={13} /> : <span />}
                        <span className={n.pickName}>
                          {c.label}
                          {c.onIt ? <small>on this dashboard</small> : null}
                        </span>
                        <span className={n.pickValue}>{c.value ?? '—'}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
            <p className={n.quiet}>{kind === 'table' ? 'No sentinel keeps rows yet: a Keep the numbers step with a unit of Rows does.' : 'No numbers yet: a sentinel keeps them with a Keep the numbers step.'}</p>
          )
        ) : null}
        {kind === 'text' ? (
          <>
            <div className={n.row2}>
              <span className={n.row2Label}>Sentinel</span>
              <Popup label="Which sentinel" value={sentinelId} onChange={setSentinelId} options={state.items.map((i) => ({ value: i.id, label: i.name }))} />
            </div>
            <div className={n.row2}>
              <span className={n.row2Label}>Shows</span>
              <Popup<'headline' | 'report'> label="What it shows" value={text} onChange={setText} options={[{ value: 'headline', label: 'Its last headline' }, { value: 'report', label: 'Its last report' }]} />
            </div>
          </>
        ) : null}
        {kind === 'chart' ? (
          <div className={n.row2}>
            <span className={n.row2Label}>Draw as</span>
            <Popup<ChartTileKind> label="Draw as" value={chart} onChange={setChart} options={[{ value: 'line', label: 'Lines' }, { value: 'area', label: 'Areas' }, { value: 'bar', label: 'Bars' }]} />
          </div>
        ) : null}
        {kind !== 'divider' ? (
          <div className={n.row2}>
            <span className={n.row2Label}>Width</span>
            <Popup label="Width" value={String(w)} onChange={(v) => setWidth(Number(v) as TileWidth)} options={[{ value: '1', label: 'Narrow (1 of 6)' }, { value: '2', label: 'Medium (2 of 6)' }, { value: '3', label: 'Wide (3 of 6)' }]} />
          </div>
        ) : null}
        <div className={n.row2}>
          <span className={n.row2Label}>Title</span>
          <TextInput value={title} onChange={setTitle} maxLength={80} placeholder={kind === 'divider' ? 'Money' : 'Its metric’s label'} aria-label="Title" />
        </div>
        <Preview kind={kind} picked={picked} chart={chart} title={title} />
      </div>
    </FormSheet>
  );
}

function Preview({ kind, picked, chart, title }: { kind: TileKind; picked: readonly MetricRef[]; chart: ChartTileKind; title: string }) {
  const state = useSentinelState();
  const series = picked.flatMap((r) => metricOf(state, r) ?? []);
  if (kind === 'divider' || kind === 'text' || !series.length) return null;
  return (
    <div className={n.preview} data-testid="tile-preview">
      <div className={n.previewLabel}>Preview</div>
      <div className={n.previewTile}>
        {kind === 'number' ? <NumberTile w={numberWords(series[0]!, 'previous', title.trim() || series[0]!.label)} /> : kind === 'chart' ? <MetricChart series={series} kind={chart} height={160} /> : <RowsTable metric={series[0]!} pageSize={4} />}
      </div>
    </div>
  );
}
