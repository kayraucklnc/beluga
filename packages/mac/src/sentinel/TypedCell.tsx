import type { Cell, Row } from '@beluga/shared/view-spec.js';
import { type MetricColumn, deltaCellOf, personOf, progressOf, ratingOf, sparkOf, storageName } from '@beluga/core/sentinel/columns.js';
import type { MetricSeries } from '@beluga/core/sentinel/model.js';
import { Icon } from '../components/Icon.js';
import { Spark } from '../components/views/Stats.js';
import type { DrawCell } from '../components/views/Table.js';
import { formatNumber } from '../components/views/format.js';
import { useApi } from '../lib/beluga.js';
import { useActions } from '../lib/actions.js';
import { openSheet } from '../lib/sheets.js';
import { keptRow } from './numbers-model.js';
import { useSentinelActions } from './use-sentinel.js';
import n from './numbers.module.css';

/**
 * A kept table's typed cells (BLG-381): what its sentinel said a column holds, drawn so. A document
 * is a chip that opens it in the quiet viewer; a storage object a chip whose link is signed when
 * clicked; progress a bar; a sparkline its line; a change green or rose; a person their initials and
 * name; a rating its stars; an action a button that runs its sentinel with the row. The chat's own
 * kinds (badge, url, currency…) are the table's.
 */
export function typedCells(m: Pick<MetricSeries, 'sentinelId' | 'name' | 'rows'>, typed: ReadonlyMap<string, MetricColumn>): DrawCell | undefined {
  if (!typed.size) return undefined;
  return (cell, col, row) => {
    const t = typed.get(col.key);
    if (!t || cell === null || cell === '') return undefined;
    return <TypedCell m={m} t={t} cell={cell} row={row} />;
  };
}

function TypedCell({ m, t, cell, row }: { m: Pick<MetricSeries, 'sentinelId' | 'name' | 'rows'>; t: MetricColumn; cell: Cell; row: Row }) {
  const api = useApi();
  const a = useSentinelActions();
  const actions = useActions();
  const text = String(cell);
  // A chip or a button in a row opens what it says, not the row.
  const own = (run: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    run();
  };
  switch (t.type) {
    case 'html':
    case 'file':
      return (
        <button type="button" className={n.docChip} title={text} onClick={own(() => openSheet({ kind: 'sentinel_document', sentinelId: m.sentinelId, metric: m.name, column: t.key, name: text }))}>
          <Icon name="file" size={11} />
          <span>{t.button?.trim() || text}</span>
        </button>
      );
    case 'storage':
      return (
        <button
          type="button"
          className={n.docChip}
          title={text}
          onClick={own(
            () =>
              void a.act(async () => {
                const { url } = await api.sentinel.signStorage(m.sentinelId, m.name, t.key, text);
                actions.openLink({ kind: 'url', url });
              }),
          )}
        >
          <Icon name="link" size={11} />
          <span>{t.button?.trim() || storageName(cell)}</span>
        </button>
      );
    case 'progress': {
      const share = progressOf(cell, t.max);
      if (share === undefined) return undefined;
      return (
        <span className={n.progress} title={`${Math.round(share * 100)}%`}>
          <span className={n.progressBar} aria-hidden="true">
            <span style={{ width: `${share * 100}%` }} />
          </span>
          <span className={n.progressValue}>{typeof cell === 'number' ? formatNumber(cell) : text}</span>
        </span>
      );
    }
    case 'sparkline': {
      const values = sparkOf(cell);
      return values ? (
        <span className={n.sparkCell}>
          <Spark values={values} good={undefined} />
        </span>
      ) : undefined;
    }
    case 'delta': {
      const d = deltaCellOf(cell, t.better);
      return d ? (
        <span className={n.deltaCell} data-tone={d.tone}>
          {d.text}
        </span>
      ) : undefined;
    }
    case 'person': {
      const p = personOf(cell);
      return p ? (
        <span className={n.person} title={p.email ?? p.name}>
          <span className={n.initials} aria-hidden="true">
            {p.initials}
          </span>
          <span>{p.name}</span>
        </span>
      ) : undefined;
    }
    case 'rating': {
      const r = ratingOf(cell, t.max);
      return r ? (
        <span className={n.rating} role="img" aria-label={`${r.value} of ${r.max}`}>
          {Array.from({ length: r.max }, (_, i) => (
            <Icon key={i} name="star" size={11} className={i < Math.round(r.value) ? n.starOn : n.starOff} />
          ))}
        </span>
      ) : undefined;
    }
    case 'action': {
      const words = t.button?.trim() || t.label?.trim() || 'Run';
      return (
        <button
          type="button"
          className={n.rowAction}
          onClick={own(() => {
            const kept = keptRow(m.rows, row) ?? row;
            void a.act(() => api.sentinel.runRow(m.sentinelId, m.name, t.key, kept as Record<string, string | number | boolean | null>), `${words}: running`);
          })}
        >
          <Icon name="play" size={10} />
          {words}
        </button>
      );
    }
    default:
      return undefined;
  }
}
