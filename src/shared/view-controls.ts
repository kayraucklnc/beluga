import type { Cell, Condition, Control, QueryPatch, Row, View } from './view-spec.js';

/**
 * A view's controls (buttons, menus, toggles, numbers, search) as what they do to its rows: one
 * query patch (a sort, a top N, conditions, a search, values for the source's {{slots}}, another
 * source) from what's chosen now. Claude sets the controls up once; every click after that is
 * worked out here, without Claude. Pure and browser-safe (the window and the `show` tool use it).
 */

/** What's chosen in each control, by its id: an option's index for buttons and menus with options, else the value. */
export type ControlState = Readonly<Record<string, Cell | undefined>>;

const hasOptions = (c: Control): boolean => Boolean(c.options?.length);

/** Where each control starts: its `default` (an option's value or label), else the first button, nothing chosen in a menu. */
export function initialState(view: Pick<View, 'controls'>): ControlState {
  const out: Record<string, Cell | undefined> = {};
  for (const c of view.controls) {
    if (hasOptions(c)) {
      const i = c.default === undefined ? -1 : c.options!.findIndex((o) => o.value === c.default || o.label === c.default);
      out[c.id] = i >= 0 ? i : c.type === 'buttons' ? 0 : undefined;
    } else if (c.type === 'toggle') out[c.id] = c.default === true;
    else out[c.id] = c.default ?? (c.type === 'search' ? '' : undefined);
  }
  return out;
}

/** The rows' query from what's chosen (over the view's `initial`). */
export function resolveControls(view: Pick<View, 'controls' | 'initial'>, state: ControlState): QueryPatch {
  let out: Mutable = { ...(view.initial ?? {}), where: [...(view.initial?.where ?? [])], params: { ...(view.initial?.params ?? {}) } };
  for (const c of view.controls) {
    const v = state[c.id];
    if (hasOptions(c)) {
      if (typeof v !== 'number' || !c.options![v]) continue;
      const opt = c.options![v]!;
      out = merge(out, c);
      out = merge(out, opt);
      const value = opt.value === undefined ? opt.label : opt.value;
      out.params[c.id] = value === null ? '' : value;
      if (c.column && opt.value !== undefined && opt.value !== null && opt.value !== '') out.where.push({ key: c.column, op: c.op ?? 'eq', value: opt.value });
      continue;
    }
    switch (c.type) {
      case 'toggle':
        out.params[c.id] = v === true;
        if (v !== true) break;
        out = merge(out, c);
        if (c.column) out.where.push({ key: c.column, op: c.op ?? 'eq', value: c.default === undefined || c.default === true || c.default === false ? true : c.default });
        break;
      case 'number':
      case 'range': {
        if (typeof v !== 'number' || !Number.isFinite(v)) break;
        out.params[c.id] = v;
        out = merge(out, c);
        if (c.as === 'top') out.top = out.top ? Math.min(out.top, Math.max(1, Math.round(v))) : Math.max(1, Math.round(v));
        else if (c.column) out.where.push({ key: c.column, op: c.op ?? 'gte', value: v });
        break;
      }
      case 'search': {
        const t = typeof v === 'string' ? v.trim() : '';
        out.params[c.id] = t;
        if (!t) break;
        if (c.column) out.where.push({ key: c.column, op: c.op ?? 'contains', value: t });
        else out.search = t;
        break;
      }
      default: {
        // A menu of a column's values: the one chosen.
        if (v === undefined || v === null || v === '') break;
        out.params[c.id] = v;
        if (c.column) out.where.push({ key: c.column, op: c.op ?? 'eq', value: v });
      }
    }
  }
  const { where, params, ...rest } = out;
  return { ...rest, ...(where.length ? { where } : {}), ...(Object.keys(params).length ? { params } : {}) };
}

type Mutable = { sort?: QueryPatch['sort']; top?: number; where: Condition[]; search?: string; params: Record<string, string | number | boolean>; source?: QueryPatch['source'] };

function merge(out: Mutable, p: Partial<QueryPatch> & { where?: readonly Condition[] | undefined }): Mutable {
  return {
    ...out,
    ...(p.sort ? { sort: p.sort } : {}),
    ...(p.top ? { top: out.top ? Math.min(out.top, p.top) : p.top } : {}),
    ...(p.search ? { search: p.search } : {}),
    ...(p.source ? { source: p.source } : {}),
    where: [...out.where, ...(p.where ?? [])],
    params: { ...out.params, ...(p.params ?? {}) },
  };
}

/** A menu without options offers its column's values (from the rows there are), most common first. */
export function columnChoices(column: string, rows: readonly Row[], max = 60): Cell[] {
  const counts = new Map<string, { v: Cell; n: number }>();
  for (const r of rows) {
    const v = r[column] ?? null;
    if (v === null || v === '') continue;
    const k = String(v);
    const hit = counts.get(k);
    if (hit) hit.n++;
    else counts.set(k, { v, n: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || String(a.v).localeCompare(String(b.v), undefined, { numeric: true }))
    .slice(0, max)
    .map((x) => x.v);
}
