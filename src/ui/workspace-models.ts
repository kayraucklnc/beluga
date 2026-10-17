import type { AppState, LogItem, ReviewState } from '../core/store.js';
import type { Project, Workspace } from '../workspaces/types.js';
import { isRunning } from './format.js';
import { type Line, type Seg, formatDuration, lineWidth, pad, plain, truncate } from './text.js';
import { SPINNER, glyph, theme } from './theme.js';

/** Something clickable, in coordinates relative to the model's own top-left corner. */
export interface Zone {
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
  readonly action: UiAction;
}

export type WorkspaceAction = 'merge' | 'fork' | 'commit' | 'finder' | 'archive' | 'restore' | 'delete' | 'review_claude' | 'merge_claude' | 'compact';

const COMPACT_ANIMATION_MS = 1600;

/**
 * A context meter: "context ▰▰▰▰▱▱▱▱ 48% · 96k/200k". Right after a compaction it animates
 * shrinking from the old size to the new one.
 */
export function contextMeter(state: AppState, channel: string, width: number, now = Date.now()): Line {
  const info = state.context[channel];
  if (!info) return [];
  const compaction = state.compactions[channel];
  const sinceCompact = compaction ? now - compaction.at : Infinity;
  let used = info.used;
  let label = '';
  if (compaction && sinceCompact < COMPACT_ANIMATION_MS) {
    const t = Math.max(0, sinceCompact) / COMPACT_ANIMATION_MS;
    const eased = 1 - (1 - t) ** 3;
    used = Math.round(compaction.pre + (compaction.post - compaction.pre) * eased);
    label = ' compacting…';
  } else if (compaction && sinceCompact < COMPACT_ANIMATION_MS + 4000) {
    label = ` compacted ${fmtK(compaction.pre)}→${fmtK(compaction.post)}`;
  }
  const pct = Math.max(0, Math.min(100, Math.round((used / Math.max(1, info.window)) * 100)));
  const cells = Math.max(6, Math.min(16, width));
  const filled = Math.round((pct / 100) * cells);
  const color = label === ' compacting…' ? theme.info : pct >= 90 ? theme.error : pct >= 70 ? theme.warn : theme.muted;
  return [
    { text: 'context ', color: theme.muted },
    { text: '▰'.repeat(filled), color },
    { text: '▱'.repeat(cells - filled), color: theme.border },
    { text: ` ${pct}% · ${fmtK(used)}/${fmtK(info.window)}`, color },
    { text: label, color: theme.info },
  ];
}

const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** True while a compaction animation is playing somewhere (keeps frames ticking). */
export const isCompacting = (state: AppState, now = Date.now()): boolean =>
  Object.values(state.compactions).some((c) => now - c.at < COMPACT_ANIMATION_MS + 4000);

export type UiAction =
  | { readonly type: 'open_ws'; readonly id: string; readonly tab?: 'chat' | 'files' | 'review' }
  | { readonly type: 'toggle_project'; readonly id: string }
  | { readonly type: 'new_worktree'; readonly projectId: string }
  | { readonly type: 'new_chat'; readonly projectId: string }
  | { readonly type: 'add_project' }
  | { readonly type: 'view'; readonly view: AppState['view'] }
  | { readonly type: 'close_tab'; readonly id: string }
  | { readonly type: 'ws'; readonly id: string; readonly action: WorkspaceAction }
  | { readonly type: 'review_file'; readonly index: number };

export interface Model {
  readonly lines: readonly Line[];
  readonly zones: readonly Zone[];
}

const ago = (ts: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
};

export interface Activity {
  readonly running: boolean;
  readonly awaiting: boolean;
  readonly subagents: number;
  readonly background: number;
  readonly startedAt?: number;
  readonly last?: string;
  readonly lastTs?: number;
}

/** What Claude is doing in a workspace, derived from its conversation. */
export function activityOf(log: readonly LogItem[], channel: string): Activity {
  let last: LogItem | undefined;
  let run: Extract<LogItem, { type: 'agent' }> | undefined;
  for (const item of log) {
    if (item.channel !== channel) continue;
    last = item;
    if (item.type === 'agent' && isRunning(item.status)) run = item;
  }
  const lastText = last?.type === 'agent' ? last.text || last.steps.at(-1) : last?.type === 'chat' ? last.text : undefined;
  return {
    running: Boolean(run),
    awaiting: run?.status === 'awaiting_approval',
    subagents: run?.subagents.filter((s) => s.status === 'running' && s.kind !== 'background').length ?? 0,
    background: run?.subagents.filter((s) => s.status === 'running' && s.kind === 'background').length ?? 0,
    startedAt: run?.ts,
    last: lastText?.split('\n').find((l) => l.trim())?.replace(/[*_`#>]/g, '').trim(),
    lastTs: last?.ts,
  };
}

/** Status chips for a workspace: ahead, changed, archived, external. */
function chips(ws: Workspace): Seg[] {
  const out: Seg[] = [];
  if (ws.archived) return [{ text: 'archived', color: theme.muted }];
  if (ws.kind === 'chat') return [{ text: 'chat', color: theme.muted }];
  const st = ws.status;
  if (st?.ahead) out.push({ text: `↑${st.ahead}`, color: theme.info });
  if (st?.behind) out.push({ text: `↓${st.behind}`, color: theme.muted });
  if (st?.changed) out.push({ text: `✎${st.changed}`, color: theme.warn });
  if (!out.length && ws.kind !== 'main') out.push({ text: '✓', color: theme.muted });
  return out.flatMap((c, i) => (i ? [{ text: ' ' }, c] : [c]));
}

function dotFor(ws: Workspace, act: Activity, frame: number): Seg {
  if (act.awaiting) return { text: glyph.wait, color: theme.warn };
  if (act.running) return { text: SPINNER[frame % SPINNER.length] ?? '•', color: theme.claude };
  if (ws.archived) return { text: glyph.ring, color: theme.border };
  return { text: ws.kind === 'chat' ? '◇' : ws.kind === 'main' ? glyph.dot : glyph.dot, color: ws.kind === 'main' ? theme.text : theme.muted };
}

/** Left / right columns on one line, right side kept visible. */
function split(left: Line, right: Line, width: number): Line {
  const rw = lineWidth(right);
  return [...pad(left, Math.max(1, width - rw - 1)), { text: ' ' }, ...right];
}

/** The Projects tree: projects, their worktrees/chats with live status, and add buttons. */
/**
 * Whether a project is unfolded. By default projects with worktrees/chats (or the one you're in)
 * are open and plain ones are folded when you have many; `toggled` flips that default.
 */
export function isProjectOpen(state: AppState, p: Project, toggled: ReadonlySet<string>): boolean {
  const current = state.view.kind === 'workspace' ? state.view.id : undefined;
  const busy = p.workspaces.some((w) => !w.archived && w.kind !== 'main') || p.workspaces.some((w) => w.id === current);
  const byDefault = busy || !p.root || state.projects.length <= 6;
  return toggled.has(p.id) ? !byDefault : byDefault;
}

export function projectsModel(state: AppState, collapsed: ReadonlySet<string>, frame: number, width: number): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  const current = state.view.kind === 'workspace' ? state.view.id : undefined;
  const row = (line: Line, action?: UiAction): void => {
    if (action) zones.push({ x0: 0, x1: width - 1, y: lines.length, action });
    lines.push(line);
  };
  if (!state.projects.some((p) => p.root)) {
    row(plain('No projects found yet.', { color: theme.muted }));
    row(plain('Add one with the button below.', { color: theme.muted }));
  }
  for (const p of state.projects) {
    const open = isProjectOpen(state, p, collapsed);
    const active = p.workspaces.filter((w) => activityOf(state.log, `ws:${w.id}`).running).length;
    row(
      split(
        [{ text: open ? '▾ ' : '▸ ', color: theme.muted }, { text: p.name, bold: true, color: theme.text }],
        active ? [{ text: `${SPINNER[frame % SPINNER.length]} ${active}`, color: theme.claude }] : p.error ? [{ text: '!', color: theme.error }] : [],
        width,
      ),
      { type: 'toggle_project', id: p.id },
    );
    if (!open) continue;
    for (const ws of p.workspaces.filter((w) => !w.archived)) {
      const act = activityOf(state.log, `ws:${ws.id}`);
      const selected = ws.id === current;
      const name: Seg = { text: ws.name, color: selected ? theme.accent : ws.external ? theme.muted : theme.text, bold: selected };
      const unread = state.unread[`ws:${ws.id}`];
      row(
        split(
          [{ text: selected ? '▌' : ' ' , color: theme.accent }, { text: ' ' }, dotFor(ws, act, frame), { text: ' ' }, name, ...(unread ? [{ text: ` ${unread}`, color: theme.claude }] : [])],
          chips(ws),
          width,
        ),
        { type: 'open_ws', id: ws.id },
      );
    }
    const archived = p.workspaces.filter((w) => w.archived).length;
    if (p.root) row([{ text: '   + ', color: theme.muted }, { text: 'New worktree', color: theme.muted }], { type: 'new_worktree', projectId: p.id });
    row([{ text: '   + ', color: theme.muted }, { text: p.root ? 'New chat' : 'New Claude chat', color: p.root ? theme.muted : theme.text }], { type: 'new_chat', projectId: p.id });
    if (archived) row(plain(`     ${archived} archived · /overview`, { color: theme.border }), { type: 'view', view: { kind: 'overview' } });
  }
  row([]);
  row([{ text: '+ ', color: theme.accent }, { text: 'Add project or folder', color: theme.text }], { type: 'add_project' });
  return { lines, zones };
}

/** Tabs across the top of the main area. */
export function tabsModel(state: AppState, width: number): Model {
  const segs: Seg[] = [];
  const zones: Zone[] = [];
  let x = 0;
  const tab = (label: string, active: boolean, action: UiAction, close?: UiAction, badge?: number): void => {
    const text = ` ${label}${badge ? ` ${badge}` : ''} `;
    segs.push({ text, color: active ? theme.text : theme.muted, bold: active, inverse: false });
    zones.push({ x0: x, x1: x + text.length - 1, y: 0, action });
    x += text.length;
    if (close) {
      segs.push({ text: '✕ ', color: theme.border });
      zones.push({ x0: x, x1: x + 1, y: 0, action: close });
      x += 2;
    }
    segs.push({ text: '│', color: theme.border });
    x += 1;
  };
  const v = state.view;
  tab('# Room', v.kind === 'room', { type: 'view', view: { kind: 'room' } }, undefined, state.unread.room);
  tab('▤ Shared files', v.kind === 'files', { type: 'view', view: { kind: 'files' } });
  tab('▦ Overview', v.kind === 'overview', { type: 'view', view: { kind: 'overview' } });
  for (const id of state.tabs) {
    const ws = findWorkspace(state.projects, id);
    if (!ws) continue;
    const active = v.kind === 'workspace' && v.id === id;
    tab(ws.name, active, { type: 'open_ws', id }, { type: 'close_tab', id }, state.unread[`ws:${id}`]);
  }
  const underline: Line = [{ text: '─'.repeat(Math.max(0, width)), color: theme.border }];
  return { lines: [truncate(segs, width), underline], zones: zones.filter((z) => z.x0 < width) };
}

export function findWorkspace(projects: readonly Project[], id: string): Workspace | undefined {
  for (const p of projects) {
    const ws = p.workspaces.find((w) => w.id === id);
    if (ws) return ws;
  }
  return undefined;
}

const CARD_HEIGHT = 7;

/** One card per workspace across all projects: the glance view. */
export function overviewModel(state: AppState, frame: number, width: number, now = Date.now()): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  const all = state.projects.flatMap((p) => p.workspaces.map((w) => ({ p, w })));
  const live = all.filter(({ w }) => !w.archived);
  const archived = all.filter(({ w }) => w.archived);
  const working = live.filter(({ w }) => activityOf(state.log, `ws:${w.id}`).running).length;
  lines.push([
    { text: `${state.projects.filter((p) => p.root).length} projects · ${live.length} workspaces`, color: theme.text, bold: true },
    { text: working ? `  ·  ${working} with Claude working` : '', color: theme.claude },
  ]);
  lines.push([]);
  if (!live.length) {
    lines.push(plain('No workspaces yet. Use "+ New worktree" under a project on the left.', { color: theme.muted }));
    return { lines, zones };
  }
  const cols = width >= 120 ? 3 : width >= 76 ? 2 : 1;
  const gap = 2;
  const cardW = Math.floor((width - gap * (cols - 1)) / cols);
  for (let i = 0; i < live.length; i += cols) {
    const rowCards = live.slice(i, i + cols).map(({ p, w }) => card(state, p, w, activityOf(state.log, `ws:${w.id}`), frame, cardW, now));
    const top = lines.length;
    for (let r = 0; r < CARD_HEIGHT; r++) {
      const segs: Seg[] = [];
      rowCards.forEach((c, ci) => {
        if (ci) segs.push({ text: ' '.repeat(gap) });
        segs.push(...(c.lines[r] ?? pad([], cardW)));
      });
      lines.push(segs);
    }
    rowCards.forEach((c, ci) => {
      const x = ci * (cardW + gap);
      for (const z of c.zones) zones.push({ ...z, x0: z.x0 + x, x1: z.x1 + x, y: z.y + top });
    });
    lines.push([]);
  }
  if (archived.length) {
    lines.push(plain(`Archived (${archived.length})`, { color: theme.muted, bold: true }));
    for (const { p, w } of archived) {
      const y = lines.length;
      lines.push([
        { text: `  ${glyph.ring} ${p.name} › ${w.name}`, color: theme.muted },
        { text: '   Restore', color: theme.info },
        { text: '   Delete', color: theme.error },
      ]);
      const base = `  ${glyph.ring} ${p.name} › ${w.name}`.length;
      zones.push({ x0: base + 3, x1: base + 9, y, action: { type: 'ws', id: w.id, action: 'restore' } });
      zones.push({ x0: base + 13, x1: base + 18, y, action: { type: 'ws', id: w.id, action: 'delete' } });
    }
  }
  return { lines, zones };
}

function card(state: AppState, p: Project, w: Workspace, act: Activity, frame: number, width: number, now: number): Model {
  const inner = width - 4;
  const border = act.awaiting ? theme.warn : act.running ? theme.claude : theme.border;
  const b = (t: string): Seg => ({ text: t, color: border });
  const title: Line = [{ text: p.name, color: theme.muted }, { text: ' › ', color: theme.border }, { text: w.name, color: theme.text, bold: true }];
  const sub: Line = w.kind === 'chat' ? plain(p.root ? 'chat in main folder' : 'Claude chat', { color: theme.muted }) : [{ text: w.branch ?? 'detached', color: theme.muted }, { text: '  ' }, ...chips(w)];
  const status: Line = act.awaiting
    ? [{ text: `${glyph.wait} needs your approval`, color: theme.warn }]
    : act.running
      ? [
          { text: `${SPINNER[frame % SPINNER.length]} Claude working`, color: theme.claude },
          { text: act.startedAt ? ` · ${formatDuration(now - act.startedAt)}` : '', color: theme.muted },
          { text: act.subagents ? ` · ${act.subagents} sub-agent${act.subagents > 1 ? 's' : ''}` : '', color: theme.claude },
          { text: act.background ? ` · ${act.background} in background` : '', color: theme.info },
        ]
      : [{ text: act.lastTs ? `idle · ${ago(act.lastTs, now)}` : 'no conversation yet', color: theme.muted }];
  const ctx = contextMeter(state, `ws:${w.id}`, 8, now);
  const last: Line = ctx.length ? ctx : plain(act.last ? `"${act.last}"` : ' ', { color: theme.muted, italic: true });
  const buttons: Array<{ label: string; action: UiAction }> = [
    { label: 'Open', action: { type: 'open_ws', id: w.id } },
    ...(w.kind !== 'chat' ? [{ label: 'Review', action: { type: 'open_ws', id: w.id, tab: 'review' } as UiAction }] : []),
    ...(w.kind === 'worktree' ? [{ label: 'Merge', action: { type: 'ws', id: w.id, action: 'merge' } as UiAction }] : []),
  ];
  const zones: Zone[] = [];
  const btnSegs: Seg[] = [];
  let x = 2;
  for (const btn of buttons) {
    zones.push({ x0: x, x1: x + btn.label.length + 1, y: 5, action: btn.action });
    btnSegs.push({ text: `[${btn.label}]`, color: theme.info }, { text: ' ' });
    x += btn.label.length + 3;
  }
  zones.push({ x0: 0, x1: width - 1, y: 1, action: { type: 'open_ws', id: w.id } });
  const rows = [title, sub, status, last, btnSegs];
  return {
    lines: [
      [b('╭'), b('─'.repeat(width - 2)), b('╮')],
      ...rows.map((l) => [b('│ '), ...pad(l, inner), b(' │')]),
      [b('╰'), b('─'.repeat(width - 2)), b('╯')],
    ],
    zones,
  };
}

/** Workspace header: where you are, its state, and every action as a button. */
export function workspaceHeaderModel(state: AppState, ws: Workspace, width: number): Model {
  const project = state.projects.find((p) => p.id === ws.projectId);
  const view = state.view.kind === 'workspace' ? state.view : undefined;
  const zones: Zone[] = [];
  const title: Line = [
    { text: project?.name ?? '', color: theme.muted },
    { text: ' › ', color: theme.border },
    { text: ws.name, color: theme.text, bold: true },
    { text: ws.kind === 'chat' ? (ws.projectRoot ? '   chat in main folder' : '   Claude chat · its own folder') : `   ${ws.branch ?? ''}${ws.base ? ` from ${ws.base}` : ''}`, color: theme.muted },
    { text: '   ' },
    ...chips(ws),
    ...(ws.external ? [{ text: '   made outside klaude', color: theme.muted }] : []),
  ];
  const tabs: Array<[string, 'chat' | 'files' | 'review']> = ws.kind === 'chat' ? [['Chat', 'chat'], ['Files', 'files']] : [['Chat', 'chat'], ['Files', 'files'], ['Review', 'review']];
  const actions: Array<[string, WorkspaceAction]> = ws.archived
    ? [['Restore', 'restore'], ['Delete', 'delete']]
    : [
        ...(state.context[`ws:${ws.id}`] ? ([['Compact', 'compact']] as Array<[string, WorkspaceAction]>) : []),
        ...(ws.kind === 'worktree' ? ([['Merge', 'merge'], ['Commit', 'commit']] as Array<[string, WorkspaceAction]>) : []),
        ...(ws.kind !== 'chat' ? ([['Fork', 'fork']] as Array<[string, WorkspaceAction]>) : []),
        ['Finder', 'finder'],
        ...(ws.kind !== 'main' ? ([['Archive', 'archive']] as Array<[string, WorkspaceAction]>) : []),
      ];
  const segs: Seg[] = [];
  let x = 0;
  for (const [label, tab] of tabs) {
    const active = view?.tab === tab;
    const text = active ? `▍${label} ` : ` ${label} `;
    segs.push({ text, color: active ? theme.accent : theme.muted, bold: active });
    zones.push({ x0: x, x1: x + text.length - 1, y: 1, action: { type: 'open_ws', id: ws.id, tab } });
    x += text.length + 1;
    segs.push({ text: ' ' });
  }
  segs.push({ text: '   ' });
  x += 3;
  for (const [label, action] of actions) {
    const text = `${label}`;
    segs.push({ text, color: action === 'delete' ? theme.error : theme.text });
    zones.push({ x0: x, x1: x + text.length - 1, y: 1, action: { type: 'ws', id: ws.id, action } });
    segs.push({ text: '  ·  ', color: theme.border });
    x += text.length + 5;
  }
  // Context meter on the right of the title line.
  const meter = contextMeter(state, `ws:${ws.id}`, 12);
  const titleLine = meter.length ? split(title, meter, width) : truncate(title, width);
  return { lines: [titleLine, truncate(segs.slice(0, -1), width), [{ text: '─'.repeat(width), color: theme.border }]], zones: zones.filter((z) => z.x0 < width) };
}

/** Review screen: changed files on the left, the selected file's diff on the right. */
export function reviewModel(review: ReviewState | undefined, width: number, height: number): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  if (!review || review.loading) return { lines: [plain('Loading changes…', { color: theme.muted })], zones };
  if (review.error) return { lines: [plain(review.error, { color: theme.error })], zones };
  const data = review.data;
  if (!data || (!data.files.length && !data.commits.length)) {
    return { lines: [plain('No changes yet compared to the base branch.', { color: theme.muted })], zones };
  }
  const listW = Math.min(44, Math.max(26, Math.floor(width * 0.34)));
  const diffW = width - listW - 3;
  const left: Line[] = [];
  left.push(plain(`${data.commits.length} commit${data.commits.length === 1 ? '' : 's'} · ${data.files.length} file${data.files.length === 1 ? '' : 's'}`, { bold: true, color: theme.text }));
  for (const c of data.commits.slice(0, 5)) left.push([{ text: `${c.hash} `, color: theme.muted }, { text: c.subject, color: theme.text }]);
  if (data.commits.length > 5) left.push(plain(`…${data.commits.length - 5} more`, { color: theme.muted }));
  left.push([]);
  const fileStart = left.length;
  data.files.forEach((f, i) => {
    const sel = i === review.selected;
    const mark = f.state === 'added' || f.state === 'untracked' ? '+' : f.state === 'deleted' ? '−' : '~';
    const counts: Line = f.state === 'untracked' ? [{ text: 'new', color: theme.ok }] : [{ text: `+${f.added}`, color: theme.ok }, { text: ` −${f.removed}`, color: theme.error }];
    left.push(split([{ text: sel ? '▸ ' : '  ', color: theme.accent }, { text: `${mark} `, color: theme.muted }, { text: f.path, color: sel ? theme.text : theme.muted, bold: sel }], counts, listW));
  });
  const right: Line[] = [];
  const diff = review.diff;
  if (diff === undefined) right.push(plain('Loading diff…', { color: theme.muted }));
  else {
    for (const raw of diff.split('\n').slice(review.diffScroll)) {
      if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(raw)) continue;
      const color = raw.startsWith('+') ? theme.ok : raw.startsWith('-') ? theme.error : raw.startsWith('@@') ? theme.info : theme.muted;
      right.push(plain(raw.replace(/\t/g, '  '), { color }));
    }
  }
  for (let r = 0; r < Math.max(1, height); r++) {
    const l = left[r] ?? [];
    const d = right[r] ?? [];
    lines.push([...pad(l, listW), { text: ' │ ', color: theme.border }, ...truncate(d, diffW)]);
  }
  data.files.forEach((_f, i) => zones.push({ x0: 0, x1: listW - 1, y: fileStart + i, action: { type: 'review_file', index: i } }));
  return { lines, zones };
}
