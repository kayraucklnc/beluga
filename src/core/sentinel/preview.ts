import type { Row } from '../../shared/view-spec.js';

/**
 * What a sentinel's sources bring back, checked before it's saved and on a test run (BLG-304): the
 * first rows, how empty each column is, and the columns empty in (nearly) every row, so a wrong
 * join shows before the first run rather than as a dashboard of dashes. Pure and browser-safe.
 */

/** Rows shown. */
export const SAMPLE_ROWS = 5;
/** A column empty in at least this share of the rows is flagged. */
export const EMPTY_FLAG = 0.9;
/** A cell shown at most this long. */
const CELL_MAX = 60;

export interface SourcePreview {
  readonly stepId: string;
  readonly stepName: string;
  /** ok: it answered; failed: it didn't (why); not-checked: Claude may not run it alone (why). */
  readonly state: 'ok' | 'failed' | 'not-checked';
  readonly why?: string;
  /** Rows that came back. */
  readonly rows: number;
  readonly columns: readonly string[];
  /** The first rows. */
  readonly sample: readonly Row[];
  /** By column, the share of rows where it's empty (0 to 1). */
  readonly empty: Readonly<Record<string, number>>;
  /** Columns empty in all or nearly all rows. */
  readonly flagged: readonly string[];
  /** The metrics its Keep the numbers step found, and the ones it didn't. */
  readonly kept?: readonly string[];
  readonly missing?: readonly string[];
  /** Its typed columns, in words ("html_content → 6 documents, 81 KB"). */
  readonly typed?: readonly string[];
}

/** Nothing in it: null, an empty or blank string, an empty list. */
export function isEmptyCell(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return !v.trim();
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** By column, the share of rows where it's empty. */
export function columnEmptiness(rows: readonly Row[], columns: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!rows.length) return out;
  for (const c of columns) out[c] = rows.filter((r) => isEmptyCell((r as Record<string, unknown>)[c])).length / rows.length;
  return out;
}

/** Columns empty in all or nearly all rows (at least EMPTY_FLAG of them). */
export function flaggedColumns(empty: Readonly<Record<string, number>>): string[] {
  return Object.entries(empty)
    .filter(([, share]) => share >= EMPTY_FLAG)
    .map(([c]) => c);
}

/** A source's answer as a preview. */
export function previewOf(stepId: string, stepName: string, rows: readonly Row[], columns: readonly string[], measured?: { readonly kept: readonly string[]; readonly missing: readonly string[] }, sample = SAMPLE_ROWS, typed?: readonly string[]): SourcePreview {
  const cols = columns.length ? columns : [...new Set(rows.slice(0, 200).flatMap((r) => Object.keys(r)))];
  const empty = columnEmptiness(rows, cols);
  return { stepId, stepName, state: 'ok', rows: rows.length, columns: cols, sample: rows.slice(0, sample), empty, flagged: flaggedColumns(empty), ...(measured ? { kept: measured.kept, missing: measured.missing } : {}), ...(typed?.length ? { typed } : {}) };
}

/** A source step whose check failed: it didn't answer, or answered rows without the numbers it keeps. */
export const previewBroken = (p: SourcePreview): boolean => p.state === 'failed' || Boolean(p.rows && p.missing?.length);

/** A test run of a sentinel's sources (sentinel.test, Claude's sentinel_test): its run, each source's preview, and both in words. */
export interface SentinelTest {
  readonly runId?: string;
  readonly previews: readonly SourcePreview[];
  readonly text: string;
}

/** A source that didn't answer, or wasn't run. */
export const previewFailed = (stepId: string, stepName: string, state: 'failed' | 'not-checked', why: string): SourcePreview => ({ stepId, stepName, state, why, rows: 0, columns: [], sample: [], empty: {}, flagged: [] });

const percent = (share: number): string => `${Math.round(share * 100)}%`;

const cellText = (v: unknown): string => {
  const t = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const one = t.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
  return one.length > CELL_MAX ? `${one.slice(0, CELL_MAX - 1)}…` : one;
};

/** One source's preview in words and a Markdown table, for Claude to show the user. */
export function describePreview(p: SourcePreview): string {
  if (p.state === 'failed') return `“${p.stepName}”: its source failed: ${p.why ?? 'no answer'}`;
  if (p.state === 'not-checked') return `“${p.stepName}”: not checked: ${p.why ?? ''}`.trim();
  const lines = [`“${p.stepName}”: ${p.rows} ${p.rows === 1 ? 'row' : 'rows'}${p.columns.length ? `, columns ${p.columns.join(', ')}` : ''}.`];
  if (p.kept?.length) lines.push(`Keeps ${p.kept.join(', ')}.`);
  if (p.missing?.length) lines.push(`Didn’t find ${p.missing.join(', ')} in the rows.`);
  if (p.typed?.length) lines.push(`Typed columns: ${p.typed.join('; ')}.`);
  if (!p.rows) {
    lines.push('No rows came back: check the query’s filters (a date, a status) against the data, or say that none is expected yet.');
    return lines.join('\n');
  }
  const empties = p.columns.filter((c) => (p.empty[c] ?? 0) > 0);
  if (empties.length) lines.push(`Empty values: ${empties.map((c) => `${c} ${percent(p.empty[c]!)}`).join(', ')}.`);
  if (p.flagged.length) lines.push(`Flagged: ${p.flagged.join(', ')} ${p.flagged.length === 1 ? 'is' : 'are'} empty in all or nearly all rows: the join or the column is probably wrong. Fix the query (read the schema) or drop ${p.flagged.length === 1 ? 'it' : 'them'}.`);
  const cols = p.columns.slice(0, 16);
  if (cols.length && p.sample.length) {
    lines.push('', `| ${cols.map(cellText).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...p.sample.map((r) => `| ${cols.map((c) => cellText((r as Record<string, unknown>)[c])).join(' | ')} |`));
    if (p.rows > p.sample.length) lines.push(`(the first ${p.sample.length} of ${p.rows})`);
  }
  return lines.join('\n');
}

/** Every source's preview, one after another. */
export const describePreviews = (previews: readonly SourcePreview[]): string => previews.map(describePreview).join('\n\n');
