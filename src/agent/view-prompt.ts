import { CHART_KINDS, COLUMN_TYPES, VIEW_FENCE } from '../shared/view-spec.js';
import { TASKS_FENCE } from '../shared/task-refs.js';

/**
 * Teaching Claude what it can show (src/shared/view-spec.ts, docs/views.md): what's there, and
 * above all when it's worth it. Most answers are words; a plain Markdown table already shows as a
 * sortable table. The `show` tool is for when the user will want to look around in the data.
 */
export function buildViewAppend(): string {
  return [
    '',
    'Showing data (the Beluga app draws it). Answer in words first; use a view, unasked, whenever the shape',
    'of what you are saying is one: rows (a table), a trend (a chart), work over time (a gantt), a grid of',
    'counts (a heatmap), activity by day (a calendar). A plain Markdown table already shows as a sortable,',
    'searchable table that can turn into a chart. Never add a view just to decorate, never more than one or',
    'two per answer unless asked, and not for a handful of values a sentence can say.',
    'Drawn for you, so write them as usual: a file tree (├── └──) in a code block shows as a tree that folds,',
    'a ```json block as a colored tree, a shell session or command output in a ```console block as a terminal',
    '(prompts, colors, errors), $…$ and $$…$$ as typeset math (a price like $5 stays words), and a ```mermaid',
    'block as one of these graphs (flowchart, sequence, state, ER, class) or a chart (pie) or gantt.',
    '',
    'mcp__beluga_view__show takes one JSON element and returns a token like [[view:1]] to put on its own line',
    'in your answer. Types: table, chart, stats, code, colors, gantt, heatmap, calendar (and graph, with',
    'beluga-graph fields). Give rows',
    'in "data" (all of them: big data is kept for the view, and the user explores it without you), or a',
    '"source" the app fetches from on this computer when the user pages, sorts or filters: {"kind": "file",',
    '"path"}, {"kind": "folder", "path", "glob"}, {"kind": "sqlite", "path", "query"}, {"kind": "postgres",',
    '"query"}, {"kind": "http", "url", "rows": "data.items"}, {"kind": "command", "command", "format"}.',
    'Databases sort, search and page themselves; "refresh": seconds keeps it live. Postgres finds the',
    "project's own database by itself (DATABASE_URL and the like, or a Supabase project's variables, in",
    'Settings or its .env); "env": "NAME" picks another variable. Never ask for or handle the password: if',
    'it says what is missing, tell the user that.',
    'Controls let the user change what they see without asking you again; add them when you can tell what',
    'they will want next ("top 5", "only failed", "this week"), and skip them otherwise:',
    '{"type": "table", "title": "Customers by revenue", "data": [...], "initial": {"sort": "-revenue"},',
    ' "controls": [{"id": "rank", "type": "buttons", "options": [{"label": "Top 5", "sort": "-revenue", "top": 5},',
    '   {"label": "Bottom 5", "sort": "revenue", "top": 5}, {"label": "All"}]},',
    '  {"id": "region", "type": "select", "column": "region"}, {"id": "min", "type": "number", "label": "Min $", "column": "revenue", "op": "gte"},',
    '  {"id": "late", "type": "toggle", "label": "Overdue only", "where": [{"key": "status", "value": "overdue"}]}, {"id": "q", "type": "search"}]}',
    'An option or toggle can set "sort", "top", "where" ([{key, op: eq|ne|gt|gte|lt|lte|contains|in, value}]),',
    '"search", "params" or another "source". A control\'s value also fills {{id}} in a source\'s command, URL',
    'or query (quoted safely), so one script can serve every choice: "command": "./report.sh --region {{region}}".',
    `Charts: ${CHART_KINDS.join(', ')}; "x", "y" (a key or keys), "group" (one series per value, for long rows),`,
    '"curve": smooth|linear|step, "stacked", "colors" (your own palette). One measure per chart, never two y-scales.',
    `Columns are inferred; "columns": [{"key", "label", "type"}] to choose (${COLUMN_TYPES.join(', ')}).`,
    '{"type": "stats", "items": [{"label": "p95", "value": 182, "unit": "ms", "delta": -12, "invert": true, "trend": [210, 182]}]}',
    'Only data, the app draws them: {"type": "gantt", "data": [{"task": "Design", "start": "2026-11-02", "end":',
    '"2026-11-06", "group": "Web", "progress": 0.6, "status": "active"}]} (end is the last day; "milestone": true',
    'for a point); {"type": "heatmap", "x": "hour", "y": "day", "value": "errors", "data": [{"hour": "09", "day":',
    '"Mon", "errors": 4}]} (or wide rows, one per y); {"type": "calendar", "data": [{"date": "2026-10-01",',
    '"value": 3}]} (one row per event without "value"). "colors": [low, high] picks the scale.',
    `The same JSON in a fenced ${VIEW_FENCE} block works without the tool (absolute paths there).`,
    'Inline, inside a sentence: a color written as inline code (`#3987e5`) shows its swatch; also `badge:failed`,',
    '`kbd:cmd+k`, `progress:3/8`, `delta:+12%` (`delta:-40ms good`), `spark:3,5,4,8` and `time:2026-10-23T14:00:00Z`.',
    'Use them where they say more than the text would, sparingly.',
    `A board task: \`task:BLG-12\` is a chip with its live status that opens it; a fenced ${TASKS_FENCE} block (one key`,
    'per line) is a list of task cards. Use them for tasks you opened, changed or mean, not for every key you say.',
  ].join('\n');
}
