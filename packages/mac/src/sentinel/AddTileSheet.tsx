import { useMemo, useState } from 'react';
import { type ChartTileKind, type MetricRef, type StepRef, type TileHeight, type TileKind, type TileWidth, DEFAULT_WIDTH, TILE_INFO, TILE_WIDTHS, WIDTH_WORDS, metricOf } from '@beluga/core/sentinel/dashboard-model.js';
import type { Args } from '@beluga/ipc/api.js';
import { Field, FormSheet, Popup, TextArea, TextInput } from '../components/FormSheet.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Segmented } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { MetricChart, NumberTile, RowsTable, SeriesChart } from './NumberParts.js';
import { type MetricChoice, type StepChoice, metricChoices, numberWords, stepChoices } from './numbers-model.js';
import { useSentinelActions, useSentinelState } from './use-sentinel.js';
import n from './numbers.module.css';
import s from './sentinel.module.css';

/**
 * Add a Tile (docs/sentinel.md §10). It opens on one box: describe the tile ("my Stripe revenue
 * per day", "the open PR count", "last night's Claude review summary") and your Claude builds it,
 * setting up a draft sentinel that fetches it when nothing does yet. Pick it yourself is one tap
 * away: the kind, then a metric (every one any sentinel keeps, by project and sentinel) or a step
 * (for an output), its size and title, with the tile as it will look underneath. A tile names a
 * sentinel and a metric or a step, never its source.
 */

type Way = 'describe' | 'pick';

const WAYS: ReadonlyArray<{ readonly value: Way; readonly label: string; readonly icon: IconName; readonly hint: string }> = [
  { value: 'describe', label: 'Describe it', icon: 'claude', hint: 'Say what it should show; Claude puts it together, and sets up a sentinel to fetch it when none does' },
  { value: 'pick', label: 'Pick it yourself', icon: 'grid', hint: 'A number, a series, a table, a step’s output, text or a divider' },
];

const KINDS: ReadonlyArray<{ readonly value: TileKind; readonly label: string; readonly icon: IconName; readonly hint: string }> = [
  { value: 'number', label: 'Number', icon: 'gauge', hint: TILE_INFO.number.hint },
  { value: 'series', label: 'Series', icon: 'chartLine', hint: TILE_INFO.series.hint },
  { value: 'table', label: 'Table', icon: 'table', hint: TILE_INFO.table.hint },
  { value: 'output', label: 'Output', icon: 'file', hint: TILE_INFO.output.hint },
  { value: 'text', label: 'Text', icon: 'outline', hint: TILE_INFO.text.hint },
  { value: 'divider', label: 'Divider', icon: 'minus', hint: TILE_INFO.divider.hint },
];

const key = (r: MetricRef): string => `${r.sentinelId}/${r.metric}`;
const stepKey = (r: StepRef): string => `${r.sentinelId}/${r.stepId}`;

/** The metrics a kind picks from: numbers for a number, numbers or kept arrays for a series, rows for a table, outputs for an output. */
const fits = (kind: TileKind, c: MetricChoice): boolean => (kind === 'number' ? c.kind === 'number' : kind === 'series' ? c.kind === 'number' || c.kind === 'series' : kind === 'table' ? c.kind === 'rows' : kind === 'output' ? c.kind === 'output' : false);

export function AddTileSheet({ dashboardId, close }: { dashboardId: string; close: () => void }) {
  const api = useApi();
  const a = useSentinelActions();
  const state = useSentinelState();
  const projects = useApp((st) => st.projects);
  const d = state.dashboards?.find((x) => x.id === dashboardId);
  const [way, setWay] = useState<Way>('describe');
  const [words, setWords] = useState('');
  const [kind, setKind] = useState<TileKind>('number');
  const [picked, setPicked] = useState<readonly MetricRef[]>([]);
  const [step, setStep] = useState<StepRef>();
  const [sentinelId, setSentinelId] = useState<string>(state.items[0]?.id ?? '');
  const [text, setText] = useState<'headline' | 'report'>('headline');
  const [chart, setChart] = useState<ChartTileKind>('line');
  const [width, setWidth] = useState<TileWidth | undefined>();
  const [height, setHeight] = useState<TileHeight>(1);
  const [title, setTitle] = useState('');
  const projectName = (id: string | undefined): string => projects.find((p) => p.id === id)?.name ?? 'Your Mac';
  const choices = useMemo(() => metricChoices(state, projectName, d), [state, projects, d]);
  const steps = useMemo(() => stepChoices(state, projectName), [state.items, projects]);
  const shown = choices.filter((c) => fits(kind, c));
  // A series draws several numbers over time, or one kept array on its own.
  const many = kind === 'series' && !picked.some((r) => metricOf(state, r)?.kind === 'series');
  const toggle = (c: MetricChoice): void =>
    setPicked((now) => {
      if (now.some((r) => key(r) === key(c.ref))) return now.filter((r) => key(r) !== key(c.ref));
      if (kind === 'series' && c.kind === 'series') return [c.ref];
      return many ? [...now.filter((r) => metricOf(state, r)?.kind !== 'series'), c.ref].slice(0, 8) : [c.ref];
    });
  const changeKind = (k: TileKind): void => {
    setKind(k);
    setWidth(undefined);
    setPicked((now) => now.filter((r) => {
      const c = choices.find((x) => key(x.ref) === key(r));
      return c ? fits(k, c) : false;
    }).slice(0, k === 'series' ? 8 : 1));
    if (k === 'series') setChart((c) => c);
  };
  const w = width ?? DEFAULT_WIDTH[kind];
  const ready = way === 'describe' ? Boolean(words.trim()) : kind === 'divider' ? Boolean(title.trim()) : kind === 'text' ? Boolean(sentinelId) : kind === 'output' ? Boolean(step) || picked.length > 0 : picked.length > 0;
  const own = (): { title?: string; height?: TileHeight } => ({ ...(title.trim() ? { title: title.trim() } : {}), ...(height === 2 ? { height } : {}) });
  const describe = async (): Promise<string | void> => {
    const said = words.trim();
    if (!said) return;
    const went = await a.act(() => api.dashboard.ask(dashboardId, said));
    if (!went) return 'Couldn’t ask Claude: see the message above';
    close();
  };
  const submit = async (): Promise<string | void> => {
    if (way === 'describe') return describe();
    const series = picked.length === 1 && metricOf(state, picked[0]!)?.kind === 'series';
    const tile: Args<'dashboard.addTile'>[1] =
      kind === 'divider'
        ? { kind, title: title.trim() }
        : kind === 'text'
          ? { kind, sentinelId, text, width: w, ...own() }
          : kind === 'output'
            ? step
              ? { kind, step, width: w, ...own() }
              : { kind, metric: picked[0]!, width: w, ...own() }
            : kind === 'series'
              ? { kind, ...(series ? { metric: picked[0]! } : { metrics: [...picked] }), chart, width: w, ...own() }
              : { kind, metric: picked[0]!, width: w, ...own() };
    const done = await a.act(() => api.dashboard.addTile(dashboardId, tile));
    if (!done) return 'Couldn’t add it: see the message above';
    close();
  };
  // Grouped by project, then sentinel, as the list shows them.
  const groups = useMemo(() => groupBy(shown, (c) => `${c.project} · ${c.sentinel}`), [shown]);
  const stepGroups = useMemo(() => groupBy(steps, (c) => `${c.project} · ${c.sentinel}`), [steps]);
  return (
    <FormSheet
      title="Add a Tile"
      icon="gauge"
      intro={d ? `On “${d.name}”. A tile shows anything a sentinel keeps or brings back; drag it into place afterwards.` : undefined}
      submitLabel={way === 'describe' ? 'Ask Claude' : 'Add Tile'}
      canSubmit={ready}
      width={640}
      onCancel={close}
      onSubmit={submit}
    >
      <div className={n.sheet}>
        <div className={s.ways}>
          <Segmented<Way> label="How to add it" value={way} onChange={setWay} options={WAYS} />
        </div>
        {way === 'describe' ? (
          <Field label="What should it show?" htmlFor="tile-words" hint="Claude adds it from what your sentinels keep. When nothing fetches it yet, it sets up a sentinel that does: a draft you look over and turn on first.">
            <TextArea id="tile-words" value={words} onChange={setWords} rows={3} maxLength={8000} placeholder="My Stripe revenue per day · the open PR count · last night’s Claude review summary" data-autofocus aria-label="What should it show?" />
          </Field>
        ) : (
          <>
            <div className={n.kinds}>
              <Segmented<TileKind> label="What kind of tile" value={kind} onChange={changeKind} options={KINDS} />
            </div>
            {kind === 'output' ? (
              <div className={n.picker} role="radiogroup" aria-label="Steps">
                {stepGroups.map((g) => (
                  <div key={g.head} role="presentation">
                    <div className={n.group}>{g.head}</div>
                    {g.items.map((c: StepChoice) => {
                      const on = step !== undefined && stepKey(step) === stepKey(c.ref);
                      return (
                        <button key={stepKey(c.ref)} type="button" role="radio" aria-checked={on} className={n.pick} onClick={() => (setStep(c.ref), setPicked([]))} data-step={c.ref.stepId}>
                          {on ? <Icon name="check" size={13} /> : <span />}
                          <span className={n.pickName}>
                            {c.label}
                            <small>{c.hint}</small>
                          </span>
                          <span className={n.pickValue}>{c.kind === 'claude' ? 'Claude' : c.kind === 'http' ? 'Service' : 'Script'}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
                {groups.length ? <MetricPicks groups={groups} picked={picked} many={false} toggle={(c) => (toggle(c), setStep(undefined))} /> : null}
                {!stepGroups.length && !groups.length ? <p className={n.quiet}>No sentinel has an Ask Claude, Call a service or Run a script step yet.</p> : null}
              </div>
            ) : kind === 'number' || kind === 'series' || kind === 'table' ? (
              shown.length ? (
                <div className={n.picker} role={many ? 'group' : 'radiogroup'} aria-label={kind === 'table' ? 'Tables' : 'Numbers'}>
                  <MetricPicks groups={groups} picked={picked} many={many} toggle={toggle} />
                </div>
              ) : (
                <p className={n.quiet}>{kind === 'table' ? 'No sentinel keeps rows yet: a Keep the numbers step of the kind Rows does.' : 'No numbers yet: a sentinel keeps them with a Keep the numbers step. Or describe the tile and Claude sets one up.'}</p>
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
            {kind === 'series' ? (
              <div className={n.row2}>
                <span className={n.row2Label}>Draw as</span>
                <Popup<ChartTileKind> label="Draw as" value={chart} onChange={setChart} options={[{ value: 'line', label: 'Lines' }, { value: 'area', label: 'Areas' }, { value: 'bar', label: 'Bars' }]} />
              </div>
            ) : null}
            {kind !== 'divider' ? (
              <div className={n.row2}>
                <span className={n.row2Label}>Size</span>
                <Popup label="Width" value={String(w)} onChange={(v) => setWidth(Number(v) as TileWidth)} options={TILE_WIDTHS.map((x) => ({ value: String(x), label: WIDTH_WORDS[x] }))} />
                <Popup label="Height" value={String(height)} onChange={(v) => setHeight(Number(v) as TileHeight)} options={[{ value: '1', label: 'Normal' }, { value: '2', label: 'Tall' }]} />
              </div>
            ) : null}
            <div className={n.row2}>
              <span className={n.row2Label}>Title</span>
              <TextInput value={title} onChange={setTitle} maxLength={80} placeholder={kind === 'divider' ? 'Money' : kind === 'output' ? 'Its step’s name' : 'Its metric’s label'} aria-label="Title" />
            </div>
            <Preview kind={kind} picked={picked} chart={chart} title={title} />
          </>
        )}
      </div>
    </FormSheet>
  );
}

function groupBy<T>(items: readonly T[], head: (t: T) => string): Array<{ readonly head: string; readonly items: T[] }> {
  const out: Array<{ readonly head: string; readonly items: T[] }> = [];
  for (const c of items) {
    const h = head(c);
    const g = out.at(-1);
    if (g?.head === h) g.items.push(c);
    else out.push({ head: h, items: [c] });
  }
  return out;
}

function MetricPicks({ groups, picked, many, toggle }: { groups: ReadonlyArray<{ readonly head: string; readonly items: MetricChoice[] }>; picked: readonly MetricRef[]; many: boolean; toggle: (c: MetricChoice) => void }) {
  return (
    <>
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
                  {c.kind === 'series' ? <small>a kept array</small> : c.kind === 'output' ? <small>a kept output</small> : null}
                  {c.onIt ? <small>on this dashboard</small> : null}
                </span>
                <span className={n.pickValue}>{c.value ?? '—'}</span>
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}

function Preview({ kind, picked, chart, title }: { kind: TileKind; picked: readonly MetricRef[]; chart: ChartTileKind; title: string }) {
  const state = useSentinelState();
  const series = picked.flatMap((r) => metricOf(state, r) ?? []);
  if (kind === 'divider' || kind === 'text' || kind === 'output' || !series.length) return null;
  const first = series[0]!;
  return (
    <div className={n.preview} data-testid="tile-preview">
      <div className={n.previewLabel}>Preview</div>
      <div className={n.previewTile}>
        {kind === 'number' ? (
          <NumberTile w={numberWords(first, 'previous', title.trim() || first.label)} />
        ) : kind === 'series' ? (
          first.kind === 'series' ? (
            <SeriesChart metric={first} kind={chart} height={160} />
          ) : (
            <MetricChart series={series} kind={chart} height={160} />
          )
        ) : (
          <RowsTable metric={first} pageSize={4} />
        )}
      </div>
    </div>
  );
}
