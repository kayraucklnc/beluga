# Views (`beluga-view`, Mac app)

Claude can show you data, not just tell you about it. Tables, charts, stat tiles, code and colors appear in its answer as live elements. Claude brings the rows, or says where they come from: a file, a folder, a database, a web address, a command. From then on the window does the rest. Next page, sorting, searching, refreshing and switching a table to a chart all happen without asking Claude again.

- **How to ask:** "show me…", "chart…", "table of…", or anything about data. Claude reaches for a view whenever something is tabular or numeric.
- **Where views show:** answers in any conversation, reports, and Markdown files opened in Beluga.
- **Demo:** the demo daemon (`npm run dev` at the repo root), then *show me the payments dashboard*.

## When Claude uses them

These are optional, and Claude is told to use them sparingly. Most answers are words. A view is for when you asked to see something, or when the data is the answer and you'll want to look around in it. Claude adds at most one or two per answer, and never one just for decoration.

**Plain Markdown tables already look like this.** Claude Code writes tables all the time. Any plain one in an answer (text, numbers, bold, code: no links or pictures) is drawn as a table view without Claude doing anything: sort by a heading, search a long one, switch it to a chart (`97.7%`, `$0.30` and `412 ms` read as numbers). Its tools show on hover.

## The elements

| Type | What it is | What you can do |
|---|---|---|
| `table` | rows and columns | sort by a heading (again: the other way; a third time: as they came), search across every column, page, open a row to see all of it, click links and paths, switch to a line, area or bar chart |
| `chart` | `line`, `area`, `bar`, `pie`, `donut`, `scatter` | hover for every series' value, click the legend to turn series off and on, switch to a table |
| `stats` | a row of big numbers | each tile has its change (green when it's good) and a sparkline |
| `code` | a snippet or a whole file | line numbers from where it starts, highlighted lines, wrap, Copy; long code folds |
| `colors` | swatches, or pickers with `"pick": true` | copy a value, check contrast with white and black text, change and add colors, copy as CSS or JSON, *Use These Colors* puts them in the message box |

### Inline elements

Small ones sit inside a sentence. Claude writes them as inline code, and the window draws what they stand for. Anything that doesn't read as one stays code.

| Claude writes | You see |
|---|---|
| `` `#3987e5` ``, `` `rgb(57 135 229)` ``, `` `hsl(…)` `` | the color's swatch next to its value (click to copy) |
| `` `colors:#2a78d6,#1baf7a,#eda100` `` | a strip of swatches |
| `` `badge:in review` `` | a status pill, colored by its word ("failed" is a problem, "passed" good) |
| `` `kbd:cmd+shift+p` `` | key caps: ⌘ ⇧ P |
| `` `progress:72%` ``, `` `progress:3/8` `` | a small progress bar |
| `` `delta:+12%` ``, `` `delta:-40ms good` `` | a change with its arrow, green when it's good (up, unless it says otherwise) |
| `` `spark:3,5,4,8,12` `` | a sparkline (hover for the numbers) |
| `` `time:2026-10-23T14:00:00Z` `` | "2 hours ago" (hover for the date) |
| `` `task:BLG-12` `` | a board task: its status ring, key and title, live; click to open it (a key the board doesn't have says "not found") |

Several tasks are a fenced `beluga-tasks` block, one key per line (or a JSON array of keys): a stack of cards with each task's key, title, status and priority, read live from the board. Click one to open it.

None of these are required. Claude uses them when they say something faster than words, the way it uses a table or a graph.

Every card also has **Copy as CSV**, **Copy as JSON** and **Open in Full Window** (on hover and in the right-click menu).

## Controls: the next question, answered ahead

When Claude can tell what you'll want next ("now the top five", "only the overdue ones", "just Europe"), it sets up controls instead of waiting to be asked. Each click shows its rows at once. Nothing goes back to Claude: the rows are already here, or the source is asked again.

````
```beluga-view
{
  "type": "table", "title": "Customers by revenue", "data": [ … every row … ],
  "initial": { "sort": "-revenue" },
  "controls": [
    { "id": "rank", "type": "buttons", "options": [
      { "label": "Top 5", "sort": "-revenue", "top": 5 },
      { "label": "Bottom 5", "sort": "revenue", "top": 5 },
      { "label": "All" } ] },
    { "id": "region", "type": "select", "column": "region" },
    { "id": "min", "type": "number", "label": "Min revenue", "column": "revenue", "op": "gte" },
    { "id": "late", "type": "toggle", "label": "Overdue only", "where": [{ "key": "status", "value": "overdue" }] },
    { "id": "q", "type": "search" }
  ]
}
```
````

| `type` | What it is | What it does |
|---|---|---|
| `buttons` | a row of choices | the chosen option's effect |
| `select` | a menu | its options' effects, or (with `column` and no options) one of the column's values |
| `toggle` | a switch | its effect while it's on (or `column` equal to `default`) |
| `number`, `range` | a number, a slider (`min`, `max`, `step`) | `column` compared with `op` (`gte` by default), or `"as": "top"` keeps the first N |
| `search` | a search box | finds the text in every column, or in `column` |

**Effects** (on an option, a toggle, a number, or `initial` for the start):
- `sort`: `"-revenue"` (biggest first), `"name"`, or `{key, dir}`
- `top`: only the first N
- `where`: conditions, `{key, op, value}` with `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`
- `search`
- `params`
- another `source`

`default` says where a control starts (an option's label or value); buttons start on their first option.

**Scripts and queries with slots.** A control's value also fills `{{id}}` in the view's source, so one script or query serves every choice: `"command": "./report.sh --region {{region}} --since {{since}}"`, `"query": "select * from orders where total >= {{min}}"`, `"url": "https://api.example.com/orders?status={{status}}"`. Values are quoted for where they go (the shell, SQL, a URL), so a value is only ever a value.

**All the data at once.** Claude can hand the `show` tool every row it has. More than 200 are kept in a file on this Mac (`~/Library/Caches/Beluga/views`) that the view reads, and the answer carries only the first rows.

With a database, conditions, sorting and the top N run in the query itself.

## Live data

A view with a `source` is live: the window asks for each page as you need it.

- **Databases** (`sqlite`, `postgres`) sort, search and page themselves, so a table can stand for millions of rows. They're opened read-only.
- **A command or a web address** can page too: write `{{limit}}`, `{{offset}}`, `{{page}}`, `{{search}}`, `{{sort}}` or `{{order}}` in it and each page fills them in (quoted for the shell, or encoded for a URL).
- **Everything else** (a file, a folder, a command without those) is fetched whole (up to 50,000 rows), kept for a minute, and sorted, searched and paged here.
- **`"refresh": 10`** fetches it again every 10 seconds while you can see it. The card says **Live**.
- **Refresh** (⟳) fetches it again now. The card says when the rows are from.

### Who it runs for

- A source runs **on the computer of the Claude that wrote it, and only in its owner's window**. When your Claude shows you something, it runs on your Mac.
- Anyone else in the room sees the rows the view came with, and *Live on its owner's computer*.
- **Commands:** one Claude ran through its `show` tool was approved there, the way Bash commands are, so the view just works. One written straight into a block shows a small **Load** button the first time. After that it runs on its own, whatever its controls fill in (remembered in `~/.beluga/view-approvals.json`).
- **A web address that would send one of your variables** (`"Authorization": "Bearer $GITHUB_TOKEN"`) asks the same way. The value is filled in on your Mac and never shows in the chat.
- **Credential files are never read**, and commands that touch them never run (the same rules as Claude's own tools).

## The `show` tool

Claude makes a view with `mcp__beluga_view__show`. It gives the element as JSON, and the tool:

1. checks it, reading near-misses kindly (`"Spline"` is a line, `"db"` a SQLite source),
2. makes paths whole (the view works from any conversation later),
3. runs the source once on this Mac and brings the first rows back to Claude, so Claude knows what's there and everyone sees something,
4. returns a token like `[[view:1]]`.

Claude puts the token on its own line where the view belongs, and Beluga swaps in the block. A view Claude didn't place goes at the end of the answer. `show` also draws [graphs](graphs.md) (`"type": "graph"`).

Asking: a command source asks like Bash. A file, folder or SQLite file outside the shared folders asks like Read. Data, a database query or a plain web address just runs.

Without the tool, the same JSON works in a fenced `beluga-view` block (or `beluga-table`, `beluga-chart`, `beluga-stats`, `beluga-code`, `beluga-colors`, where the tag says the type).

## The format

````
```beluga-view
{
  "type": "table",
  "title": "Newest users",
  "summary": "One short line under the title",
  "source": { "kind": "sqlite", "path": "/Users/me/app/app.db", "query": "select id, email, plan, created_at from users" },
  "columns": [{ "key": "id", "label": "User" }, { "key": "plan", "type": "badge" }],
  "pageSize": 10,
  "link": "url",
  "actions": [{ "label": "Only paying", "source": { "kind": "sqlite", "path": "/Users/me/app/app.db", "query": "select … where plan != 'free'" } }]
}
```
````

### Every view

| Field | Meaning |
|---|---|
| `type` | `table` (the default), `chart`, `stats`, `code`, `colors` |
| `title`, `summary` | shown at the top |
| `data` | rows: objects, arrays (with `columns`), or CSV/TSV text (up to 500) |
| `source` | where to fetch rows from (below) |
| `columns` | which columns, in order: `{key, label?, type?, decimals?, currency?, unit?, align?, hidden?}`, or just keys |
| `pageSize` | rows per page (tables: 10) |
| `total` | how many there are, before the first fetch |
| `actions` | up to 8 buttons: `{label, href}` opens a page or file, `{label, copy}` copies text, `{label, source}` shows other data in the same view (click again to go back) |

**Column types** are worked out from names and values when not given: `text`, `number`, `percent`, `currency`, `bytes`, `date`, `datetime`, `bool`, `url`, `path`, `color`, `image` (a thumbnail: a web image, or a picture on this Mac), `code`, `badge` (a status: "failed" reads as a problem, "paid" as good).

### Sources

| `kind` | Fields | Notes |
|---|---|---|
| `file` | `path`, `format?`, `rows?` | CSV, TSV, JSON, JSON lines, or text by its extension; a code view shows the file as it is |
| `folder` | `path`, `glob?` (`*.png`, `**/*.ts`), `recursive?`, `hidden?` | rows: name, kind, size, modified, path |
| `sqlite` | `path`, `query` | `sqlite3 -readonly` |
| `postgres` | `env` (a variable holding the connection string) or `url`, `query` | `psql` in a read-only transaction; keep passwords out of the chat with `env` (Settings › Environment) |
| `http` | `url`, `method?`, `headers?`, `body?`, `rows?`, `format?` | JSON (finds the one array in it, or `rows`: `"data.items"`), CSV or text; `$NAME` in a header is one of your variables |
| `command` | `command`, `cwd?`, `format?`, `rows?` | `/bin/sh -c`; JSON, JSON lines, CSV, TSV, a table lined up with spaces (`ps`, `docker ps`), or one row per line |

Every source can have `refresh` (seconds) and `timeout` (seconds, up to 120; 30 by default). A string instead of an object is a command.

### Charts

| Field | Meaning |
|---|---|
| `chart` | `line` (the default), `area`, `bar`, `pie`, `donut`, `scatter` |
| `x` | the column along the bottom (default: the first date, else the first text column) |
| `y` | a key, keys, or `{key, label?, color?, type?}` per series (default: the numeric columns of the first one's kind) |
| `group` | long rows (`{day, service, count}`): one series per value; past eight, the smallest fold into "Other" |
| `curve` | `smooth` (the default), `linear`, `step` |
| `stacked`, `horizontal`, `dots`, `legend`, `grid` | the obvious; bars with long names lie down by themselves |
| `colors` | your own series colors, in order |
| `height`, `xLabel`, `yLabel` | |

The default series colors are eight hues in a fixed order, checked for color-blind readers on light and dark backgrounds. A chart never has two y-scales: one measure per chart.

### Stats

`items`: up to 12 `{label, value, delta?, deltaLabel?, invert?, trend?, hint?, status?, type?, unit?, currency?}`. `delta` is a number or text ("+12%"); up is good unless `invert` (latency). `status` is `good`, `warning`, `serious` or `critical`. Without `items`, a source's rows become tiles: a `label` and `value` column, or each numeric column's latest value with its history as the sparkline.

### Code and colors

- **Code:** `code`, `language`, `filename`, `startLine`, `highlight` (line numbers), or a `file` source.
- **Colors:** `swatches`: `{value, name?, note?}` or just values (hex, `rgb()`, `hsl()`), and `pick: true` for pickers.

### When a block is wrong

- Small mistakes are left out, and the card says how many.
- A block that can't be shown says what's wrong and shows its JSON.
- While Claude is still writing the block, the card says *Showing a table…*.

## How it works

- **Format:** `src/shared/view-spec.ts` (zod, browser-safe): the schema, reading rows from text, inferring columns, sorting and paging.
- **Controls:** `src/shared/view-controls.ts` turns what's chosen into one query (the window, and the `show` tool for the first rows).
- **Sources:** `src/core/views/sources.ts` runs them in the daemon. The window asks through `view.fetch` (`src/ipc/views-api.ts`).
- **The tool:** `src/agent/view-tools.ts` (`show`, and `ViewShelf`, which puts views in the answer). It's allowed or asked by `decideShow` in `src/agent/policy.ts`.
- **Teaching Claude:** `src/agent/view-prompt.ts` is added to every run's system prompt.
- **Drawing:** `packages/mac/src/components/views/`:
  - `ViewBlock.tsx`: the card
  - `use-view-data.ts`: pages, sorting, search, refresh, approval
  - `Table.tsx`, `Chart.tsx` (recharts, loaded the first time a chart shows), `Stats.tsx`, `Code.tsx`, `Colors.tsx`
  - `Controls.tsx`: the controls bar
  - `md-table.ts`: plain Markdown tables as views
  - `Inline.tsx` and `inline-model.ts`: the inline elements
  - `format.ts`, `chart-model.ts`, `inline-model.ts`: the pure parts, tested in `tests/mac-views.test.ts`
- **Tests:** `tests/view-spec.test.ts`, `tests/view-sources.test.ts`, `packages/mac/e2e/views.spec.ts`.
- **Demo:** `src/agent/mock-views.ts`.
