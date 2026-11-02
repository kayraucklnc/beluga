/**
 * Tables Claude writes as text (BLG-71): drawn with box characters (┌─┬─┐ │ ├─┼─┤ └─┴─┘), as a
 * `+---+---+` grid with `|` rows, as pipe columns with a header rule (`a | b` over `--|--`), or as
 * columns lined up with spaces over a rule of dashes (`-----  -----`). Read into a heading and
 * rows, so a screen draws them with its table (the same one as Markdown tables and views); one
 * that looks like a table but doesn't read cleanly is kept as it is, to be shown monospaced and
 * never wrapped. Pure and browser-safe (the phone's views use it: src/companion/strip.ts).
 */

export interface TextTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** A run of lines that is a table: read (`table`), or one that only looks like one (`table` missing). */
export interface FoundTable {
  /** The first and last line of it (inclusive), in the lines given. */
  readonly start: number;
  readonly end: number;
  readonly table?: TextTable;
}

/** Column separators: box drawing's verticals and the plain pipe. */
const SEP = /[│┃║|]/;
const SEP_ALL = /[│┃║|]/g;
/** Characters a rule line is made of (box corners and joints, dashes, pluses, colons for alignment). */
const RULE_CHARS = /^[\s─━═\-=+:|│┃║┌┐└┘├┤┬┴┼┏┓┗┛┣┫┳┻╋╔╗╚╝╠╣╦╩╬╒╓╕╖╘╙╛╜╞╟╡╢╤╥╧╨╪╫╭╮╯╰]+$/;
const DASHES = /[─━═\-=]{3,}/;
/** A box table's own characters (not a plain pipe): such a run is a table even when it doesn't read. */
const BOX = /[─━═┌┐└┘├┤┬┴┼┏┓┗┛┣┫┳┻╋╔╗╚╝╠╣╦╩╬│┃║]/;

const MAX_COLUMNS = 30;
const MAX_ROWS = 500;

const isRule = (line: string): boolean => RULE_CHARS.test(line) && DASHES.test(line);
const hasSep = (line: string): boolean => SEP.test(line);
/** `+----+-----+` (a grid's rule, not dashes in a sentence). */
const isGridRule = (line: string): boolean => /^\s*\+[-=+:\s]*\+\s*$/.test(line) && DASHES.test(line);

/** A cell's words: no Markdown emphasis or code ticks around them. */
const clean = (cell: string): string =>
  cell
    .trim()
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^`(.*)`$/, '$1')
    .trim();

/** A row's cells, split on its separators (the empty ones at its edges left out). */
function cellsOf(line: string): string[] {
  const parts = line.split(SEP_ALL);
  if (parts.length && !parts[0]!.trim()) parts.shift();
  if (parts.length && !parts.at(-1)!.trim()) parts.pop();
  return parts.map(clean);
}

/** Separator-column tables (box, grid, pipes): rows of cells between rules. */
function readSeparated(lines: readonly string[]): TextTable | undefined {
  const rows: string[][] = [];
  let ruleAfterHeader = false;
  for (const line of lines) {
    if (isRule(line) || isGridRule(line)) {
      if (rows.length === 1) ruleAfterHeader = true;
      continue;
    }
    if (!hasSep(line)) return undefined;
    rows.push(cellsOf(line));
  }
  const [head, ...body] = rows;
  if (!head || !body.length || head.length < 2 || head.length > MAX_COLUMNS) return undefined;
  // A heading is a heading when a rule sets it apart (or every column is named, as boxes always are).
  if (!ruleAfterHeader && head.some((c) => !c)) return undefined;
  if (body.some((r) => r.length !== head.length)) return undefined;
  return { columns: head, rows: body.slice(0, MAX_ROWS) };
}

/** Columns lined up with spaces over a rule of dash groups (`psql`, `column -t`, Claude's own). */
function readAligned(lines: readonly string[]): TextTable | undefined {
  const [header, rule, ...body] = lines;
  if (!header || !rule || !body.length) return undefined;
  const groups = [...rule.matchAll(/[─━═\-=]{2,}/g)].map((m) => ({ from: m.index!, to: m.index! + m[0].length }));
  if (groups.length < 2 || groups.length > MAX_COLUMNS) return undefined;
  if (rule.replace(/[─━═\-=\s]/g, '')) return undefined;
  const slice = (line: string): string[] => groups.map((g, i) => clean(line.slice(i === 0 ? 0 : g.from, i === groups.length - 1 ? undefined : groups[i + 1]!.from)));
  // Words must not straddle a column's edge (the gap between two dash groups is spaces in every line).
  const straddles = (line: string): boolean => groups.slice(1).some((g) => /\S/.test(line[g.from - 1] ?? ' ') && /\S/.test(line[g.from] ?? ' '));
  if ([header, ...body].some(straddles)) return undefined;
  const columns = slice(header);
  if (columns.some((c) => !c)) return undefined;
  return { columns, rows: body.slice(0, MAX_ROWS).map(slice) };
}

/** A whole block of text (a fenced block's body) read as one table, or undefined. */
export function readTextTable(text: string): TextTable | undefined {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 3) return undefined;
  return readSeparated(lines) ?? readAligned(lines);
}

/** Whether a block of text is drawn like a table (boxes, a grid, pipes over rules) even if it doesn't read. */
export function looksLikeTable(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 3) return false;
  const rules = lines.filter((l) => isRule(l) || isGridRule(l)).length;
  const rows = lines.filter((l) => hasSep(l) && !isRule(l)).length;
  return (rules >= 1 && rows >= 2 && lines.every((l) => isRule(l) || isGridRule(l) || hasSep(l))) || (BOX.test(text) && rules >= 2);
}

/**
 * Tables in prose: each run of lines that is one (read, or only looking like one). Markdown's own
 * tables (`| a | b |` over `|---|---|`) are left to the Markdown they are.
 */
export function findTextTables(lines: readonly string[]): FoundTable[] {
  const found: FoundTable[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // A box, grid or pipe table: a run of rules and rows.
    if ((isRule(line) || isGridRule(line) || hasSep(line)) && line.trim()) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1]!.trim() && (isRule(lines[j + 1]!) || isGridRule(lines[j + 1]!) || hasSep(lines[j + 1]!))) j++;
      const run = lines.slice(i, j + 1);
      // Markdown's own: the whole run stays as it is.
      if (isMarkdownTable(run)) {
        i = j + 1;
        continue;
      }
      if (run.length >= 3 && run.some((l) => isRule(l) || isGridRule(l))) {
        const table = readSeparated(run);
        if (table || looksLikeTable(run.join('\n'))) {
          found.push({ start: i, end: j, ...(table ? { table } : {}) });
          i = j + 1;
          continue;
        }
      }
    }
    // Columns lined up over a dash rule: a heading, its rule, rows until a blank line.
    const next = lines[i + 1];
    if (next !== undefined && line.trim() && /\s{2,}/.test(line.trim()) && /^[\s─━═\-=]+$/.test(next) && (next.match(/[─━═\-=]{2,}/g)?.length ?? 0) >= 2) {
      let j = i + 1;
      while (j + 1 < lines.length && lines[j + 1]!.trim() && !isRule(lines[j + 1]!)) j++;
      const table = j > i + 1 ? readAligned(lines.slice(i, j + 1)) : undefined;
      if (table) {
        found.push({ start: i, end: j, table });
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return found;
}

/** A Markdown table: `|`-edged rows with a `|---|` rule second (no box characters, no `+` grid). */
function isMarkdownTable(run: readonly string[]): boolean {
  return /^\s*\|.*\|\s*$/.test(run[0]!) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(run[1] ?? '') && !run.some((l) => BOX.test(l) || isGridRule(l));
}
