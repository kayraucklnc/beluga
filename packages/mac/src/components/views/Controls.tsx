import { useEffect, useMemo, useState } from 'react';
import type { Cell, Control, View } from '@beluga/shared/view-spec.js';
import { columnChoices } from '@beluga/shared/view-controls.js';
import { Icon } from '../Icon.js';
import { Select } from '../Select.js';
import { cx } from '../ui.js';
import type { ViewData } from './use-view-data.js';
import { formatCell, headingOf } from './format.js';
import v from './views.module.css';

/**
 * The controls Claude set up on a view, in one row above it: buttons ("Top 5 · Bottom 5 · All"),
 * menus (a column's values, or Claude's own choices), toggles, numbers and sliders, search. Each
 * change shows its rows at once: worked out here, or asked of the source, never of Claude.
 */
export function ControlsBar({ view, data }: { view: View; data: ViewData }) {
  if (!view.controls.length) return null;
  return (
    <div className={v.controls} role="toolbar" aria-label="Controls">
      {view.controls.map((c) => (
        <ControlView key={c.id} control={c} view={view} data={data} />
      ))}
    </div>
  );
}

function ControlView({ control: c, view, data }: { control: Control; view: View; data: ViewData }) {
  const value = data.controls[c.id];
  const set = (x: Cell | undefined): void => data.setControl(c.id, x);
  const label = c.label ?? (c.column ? headingOf({ key: c.column }) : undefined);
  if (c.options?.length && (c.type === 'buttons' || c.type === 'toggle')) {
    return (
      <span className={v.control}>
        {label ? <span className={v.controlLabel}>{label}</span> : null}
        <span className={v.chips} role="radiogroup" aria-label={label ?? c.id}>
          {c.options.map((o, i) => (
            <button key={i} type="button" role="radio" aria-checked={value === i} className={cx(v.chipOpt, value === i && v.chipOn)} onClick={() => set(i)}>
              {o.label}
            </button>
          ))}
        </span>
      </span>
    );
  }
  if (c.type === 'select' || (c.options?.length && c.type !== 'search')) {
    return <Menu control={c} label={label} value={value} set={set} rows={view.rows.length ? view.rows : data.rows} data={data} />;
  }
  if (c.type === 'toggle') {
    return (
      <button type="button" role="switch" aria-checked={value === true} className={cx(v.toggle, value === true && v.toggleOn)} onClick={() => set(value !== true)}>
        <span className={v.switchTrack}>
          <span className={v.switchKnob} />
        </span>
        {label ?? c.id}
      </button>
    );
  }
  if (c.type === 'number' || c.type === 'range') return <NumberControl control={c} label={label} value={value} set={set} />;
  return <SearchControl control={c} label={label} value={value} set={set} />;
}

function Menu({ control: c, label, value, set, rows, data }: { control: Control; label: string | undefined; value: Cell | undefined; set: (x: Cell | undefined) => void; rows: ViewData['rows']; data: ViewData }) {
  const withOptions = Boolean(c.options?.length);
  // A menu of a column's values: the ones there are (kept as they grow, so a choice doesn't vanish).
  const [seen, setSeen] = useState<Cell[]>([]);
  const fresh = useMemo(() => (withOptions || !c.column ? [] : columnChoices(c.column, rows)), [withOptions, c.column, rows]);
  useEffect(() => setSeen((now) => [...now, ...fresh.filter((x) => !now.includes(x))].slice(0, 80)), [fresh]);
  const col = data.columns.find((x) => x.key === c.column);
  // Beluga's own menu (no native pop-ups): '' is "All", an option by its index, a value by its text.
  const ALL = '\u0000all';
  const options = withOptions
    ? [...(c.type === 'select' && c.default === undefined ? [{ value: ALL, label: c.placeholder ?? 'All' }] : []), ...c.options!.map((o, i) => ({ value: String(i), label: o.label }))]
    : [{ value: ALL, label: c.placeholder ?? 'All' }, ...seen.map((x) => ({ value: String(x), label: col ? formatCell(x, col) : String(x) }))];
  const now = value === undefined || value === null || value === '' ? ALL : String(value);
  return (
    <span className={v.control}>
      {label ? <span className={v.controlLabel}>{label}</span> : null}
      <Select
        size="small"
        label={label ?? c.id}
        value={now}
        options={options}
        onChange={(raw) => {
          if (raw === ALL) set(undefined);
          else if (withOptions) set(Number(raw));
          else set(seen.find((x) => String(x) === raw) ?? raw);
        }}
      />
    </span>
  );
}

function NumberControl({ control: c, label, value, set }: { control: Control; label: string | undefined; value: Cell | undefined; set: (x: Cell | undefined) => void }) {
  const [text, setText] = useState(value === undefined || value === null ? '' : String(value));
  useEffect(() => {
    const t = setTimeout(() => {
      const n = text.trim() === '' ? undefined : Number(text);
      if (n === undefined || Number.isFinite(n)) set(n);
    }, c.type === 'range' ? 60 : 300);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <label className={v.control}>
      {label ? <span className={v.controlLabel}>{label}</span> : null}
      {c.type === 'range' ? (
        <>
          <input type="range" className={v.range} min={c.min ?? 0} max={c.max ?? 100} step={c.step ?? 1} value={text || String(c.min ?? 0)} onChange={(e) => setText(e.target.value)} />
          <span className={v.rangeValue}>{text || '—'}</span>
        </>
      ) : (
        <input type="number" className={v.numberInput} min={c.min} max={c.max} step={c.step} placeholder={c.placeholder ?? (c.as === 'top' ? 'All' : '')} value={text} onChange={(e) => setText(e.target.value)} />
      )}
    </label>
  );
}

function SearchControl({ control: c, label, value, set }: { control: Control; label: string | undefined; value: Cell | undefined; set: (x: Cell | undefined) => void }) {
  const [text, setText] = useState(typeof value === 'string' ? value : '');
  useEffect(() => {
    const t = setTimeout(() => set(text), 250);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <label className={cx(v.search, v.controlSearch)}>
      <Icon name="search" size={12} />
      <input type="search" placeholder={c.placeholder ?? label ?? 'Search'} value={text} onChange={(e) => setText(e.target.value)} aria-label={label ?? 'Search'} />
    </label>
  );
}
