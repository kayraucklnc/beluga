import type { AppState, LogItem, ReviewState, WorkspaceTab } from '../core/store.js';
import type { TrustLevel } from '../core/settings.js';
import { describePr } from '../workspaces/pr.js';
import { formatBytes } from '../workspaces/disk.js';
import type { Project, Workspace } from '../workspaces/types.js';
import { worktreeOrigin } from '../workspaces/origin.js';
import { isRunning } from './format.js';
import { type Line, type Seg, formatDuration, lineWidth, pad, plain, truncate } from './text.js';
import { SPINNER, glyph, theme } from './theme.js';

/** Something clickable, in coordinates relative to the model's own top-left corner. */
export interface Zone {
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
  readonly action: UiAction;
  /** Shown in the bottom bar while hovering: what clicking does. */
  readonly hint?: string;
  /** Visible but inactive (e.g. nothing to merge); clicking explains why. */
  readonly disabled?: boolean;
}

export type WorkspaceAction =
  | 'merge'
  | 'fork'
  | 'commit'
  | 'finder'
  | 'archive'
  | 'restore'
  | 'delete'
  | 'review_claude'
  | 'merge_claude'
  | 'compact'
  | 'share'
  | 'pr'
  | 'run'
  | 'stop_run'
  | 'setup'
  | 'handoff';

export type UiAction =
  | { readonly type: 'open_ws'; readonly id: string; readonly tab?: WorkspaceTab }
  | { readonly type: 'toggle_project'; readonly id: string }
  | { readonly type: 'toggle_fold'; readonly key: string }
  | { readonly type: 'agents_menu'; readonly projectId: string }
  | { readonly type: 'toggle_group'; readonly name: string }
  | { readonly type: 'toggle_archive'; readonly projectId: string }
  | { readonly type: 'project_menu'; readonly id: string }
  | { readonly type: 'archived_menu'; readonly id: string }
  | { readonly type: 'new_worktree'; readonly projectId: string }
  | { readonly type: 'new_chat'; readonly projectId: string }
  | { readonly type: 'add_project' }
  | { readonly type: 'view'; readonly view: AppState['view'] }
  | { readonly type: 'close_tab'; readonly id: string }
  | { readonly type: 'ws'; readonly id: string; readonly action: WorkspaceAction }
  | { readonly type: 'review_file'; readonly index: number }
  | { readonly type: 'plan_toggle'; readonly channel: string }
  | { readonly type: 'open_shared'; readonly owner: string; readonly id: string; readonly tab?: 'chat' | 'files' }
  | { readonly type: 'shared_menu'; readonly owner: string; readonly id: string }
  /** Answer a question card: pick an option, skip, approve or revise a plan, or finish a multi-select. */
  | { readonly type: 'answer'; readonly qid: string; readonly pick: 'option' | 'skip' | 'approve' | 'revise' | 'done'; readonly label?: string; readonly question?: string }
  | { readonly type: 'inbox' }
  | { readonly type: 'model_menu'; readonly channel: string }
  | { readonly type: 'template'; readonly id: string }
  | { readonly type: 'templates_menu' }
  | { readonly type: 'trust'; readonly peerId: string; readonly level: TrustLevel }
  | { readonly type: 'trust_later'; readonly peerId: string }
  | { readonly type: 'search_hit'; readonly index: number }
  | { readonly type: 'term_tab'; readonly key: string }
  /** The workspace buttons that didn't fit in the top bar. */
  | { readonly type: 'ws_more'; readonly id: string; readonly actions: ReadonlyArray<{ readonly action: WorkspaceAction; readonly label: string; readonly hint: string }> }
  | { readonly type: 'none' };

export interface Model {
  readonly lines: readonly Line[];
  readonly zones: readonly Zone[];
}

const COMPACT_ANIMATION_MS = 1600;
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

export function findWorkspace(projects: readonly Project[], id: string): Workspace | undefined {
  for (const p of projects) {
    const ws = p.workspaces.find((w) => w.id === id);
    if (ws) return ws;
  }
  return undefined;
}

/** Left / right columns on one line, right side kept visible. */
export function split(left: Line, right: Line, width: number): Line {
  const rw = lineWidth(right);
  return [...pad(left, Math.max(1, width - rw - 1)), { text: ' ' }, ...right];
}

// ---------------------------------------------------------------- state words

export interface WorkspaceState {
  readonly label: string;
  readonly color: string;
  readonly icon: string;
}

/** One plain-language phrase for a workspace's state, used everywhere it's shown. */
export function stateOf(state: AppState, ws: Workspace, frame: number, now = Date.now()): WorkspaceState {
  const act = activityOf(state.log, `ws:${ws.id}`);
  const spin = SPINNER[frame % SPINNER.length] ?? '•';
  if (state.conflicts[ws.id]?.length) return { label: 'Merge conflict', color: theme.error, icon: '!' };
  if (act.awaiting) return { label: 'Needs your approval', color: theme.warn, icon: glyph.wait };
  if (act.running) {
    const extra = act.subagents ? ` · ${act.subagents} sub-agent${act.subagents > 1 ? 's' : ''} running` : act.background ? ' · background task' : '';
    return { label: `Claude working${act.startedAt ? ` ${formatDuration(now - act.startedAt)}` : ''}${extra}`, color: theme.claude, icon: spin };
  }
  if (ws.archived) return { label: 'Archived', color: theme.muted, icon: glyph.ring };
  if (ws.kind === 'chat') return { label: act.lastTs ? `Chat · ${ago(act.lastTs, now)}` : 'New chat', color: theme.muted, icon: '◇' };
  const st = ws.status;
  if (st?.changed) return { label: `${st.changed} uncommitted change${st.changed > 1 ? 's' : ''}`, color: theme.warn, icon: glyph.dot };
  if (ws.kind === 'worktree' && st?.ahead) return { label: `Ready to merge · ${st.ahead} commit${st.ahead > 1 ? 's' : ''}`, color: theme.info, icon: glyph.dot };
  return { label: ws.kind === 'main' ? 'Main folder' : 'Up to date', color: theme.ok, icon: glyph.dot };
}

const BRANCH = '⌥'; // in every common terminal font, and it looks like a fork

// ---------------------------------------------------------------- sidebar

/**
 * Whether a project is unfolded: folded by default (only the one you're in opens itself);
 * `toggled` flips that.
 */
/**
 * Projects start folded, except the one you're working in. Clicking records an explicit
 * choice (`open:<id>` / `closed:<id>`) that wins from then on, so moving between
 * workspaces never flips a project you opened or closed yourself.
 */
export function isProjectOpen(state: AppState, p: Project, toggled: ReadonlySet<string>): boolean {
  if (toggled.has(`open:${p.id}`)) return true;
  if (toggled.has(`closed:${p.id}`)) return false;
  const current = state.view.kind === 'workspace' ? state.view.id : undefined;
  return p.workspaces.some((w) => w.id === current) || !p.root;
}

/** The fold choices after clicking a project's row. */
export function toggleProject(state: AppState, p: Project, choices: readonly string[]): string[] {
  const open = isProjectOpen(state, p, new Set(choices));
  const rest = choices.filter((c) => c !== `open:${p.id}` && c !== `closed:${p.id}`);
  return [...rest, `${open ? 'closed' : 'open'}:${p.id}`];
}

const section = (title: string, color: string): Seg[] => [{ text: title, color, bold: true }];

/**
 * The sidebar: CHATS, then PROJECTS (and your groups). Each project row has compact
 * "+⌥" (new worktree) and "+◇" (new chat) buttons and a "⋯" menu.
 */
export function projectsModel(state: AppState, toggled: ReadonlySet<string>, frame: number, width: number): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  const current = state.view.kind === 'workspace' ? state.view.id : undefined;
  const add = (line: Line, action?: UiAction, hint?: string): void => {
    if (action) zones.push({ x0: 0, x1: width - 1, y: lines.length, action, hint });
    lines.push(line);
  };
  /** A row with extra buttons on the right; each button is its own click target. */
  const addWithButtons = (left: Line, buttons: Array<{ label: string; color: string; action: UiAction; hint: string }>, rowAction: UiAction, rowHint: string): void => {
    const right: Seg[] = [];
    buttons.forEach((b, i) => {
      if (i) right.push({ text: ' ' });
      right.push({ text: b.label, color: b.color });
    });
    const y = lines.length;
    const rw = lineWidth(right);
    let x = width - rw;
    buttons.forEach((b) => {
      zones.push({ x0: x, x1: x + b.label.length - 1, y, action: b.action, hint: b.hint });
      x += b.label.length + 1;
    });
    zones.push({ x0: 0, x1: width - rw - 2, y, action: rowAction, hint: rowHint });
    lines.push(split(left, right, width));
  };

  const wsRow = (ws: Workspace, indent: string): void => {
    const st = stateOf(state, ws, frame);
    const selected = ws.id === current;
    const icon = ws.kind === 'chat' ? '◇' : ws.kind === 'main' ? '⌂' : BRANCH;
    const unread = state.unread[`ws:${ws.id}`];
    const left: Line = [
      { text: selected ? '▌' : ' ', color: theme.accent },
      { text: indent },
      { text: `${icon} `, color: selected ? theme.accent : theme.muted },
      { text: ws.name, color: selected ? theme.text : ws.external ? theme.muted : theme.text, bold: selected },
      ...(unread ? [{ text: ` ${unread}`, color: theme.claude, bold: true }] : []),
    ];
    const right: Line = [{ text: st.icon, color: st.color }];
    add(split(left, right, width), { type: 'open_ws', id: ws.id }, `Open ${ws.name}: ${st.label}`);
  };

  // CHATS
  const chats = state.projects.find((p) => !p.root);
  addWithButtons(section('CHATS', theme.claude), [{ label: '+ new', color: theme.claude, action: { type: 'new_chat', projectId: 'chats' }, hint: 'Start a Claude chat that is not tied to any project' }], { type: 'none' }, '');
  const liveChats = chats?.workspaces.filter((w) => !w.archived) ?? [];
  if (!liveChats.length) add(plain('  Talk to Claude about anything', { color: theme.border }));
  for (const ws of liveChats) wsRow(ws, ' ');
  lines.push([]);

  // PROJECTS, grouped
  const repos = state.projects.filter((p) => p.root);
  const grouped = new Map<string, Project[]>();
  const loose: Project[] = [];
  for (const p of repos) {
    const g = state.projectGroups.find((x) => x.projects.includes(p.root));
    if (g) grouped.set(g.name, [...(grouped.get(g.name) ?? []), p]);
    else loose.push(p);
  }
  const projectBlock = (p: Project): void => {
    const open = isProjectOpen(state, p, toggled);
    const busy = p.workspaces.some((w) => activityOf(state.log, `ws:${w.id}`).running);
    const worktrees = p.workspaces.filter((w) => !w.archived && w.kind !== 'main').length;
    addWithButtons(
      [
        { text: open ? '▾ ' : '▸ ', color: theme.muted },
        { text: '▣ ', color: theme.info },
        { text: p.name, color: theme.text, bold: true },
        ...(busy ? [{ text: ` ${SPINNER[frame % SPINNER.length]}`, color: theme.claude }] : worktrees && !open ? [{ text: ` ${worktrees}`, color: theme.muted }] : []),
      ],
      [
        { label: `+${BRANCH}`, color: theme.info, action: { type: 'new_worktree', projectId: p.id }, hint: `New worktree in ${p.name} from the latest origin` },
        { label: '+◇', color: theme.claude, action: { type: 'new_chat', projectId: p.id }, hint: `New Claude chat in ${p.name}'s main folder` },
        { label: '⋯', color: theme.muted, action: { type: 'project_menu', id: p.id }, hint: `More for ${p.name}: groups, hide, Finder` },
      ],
      { type: 'toggle_project', id: p.id },
      open ? `Collapse ${p.name}` : `Expand ${p.name}`,
    );
    if (!open) return;
    const live = p.workspaces.filter((w) => !w.archived);
    for (const ws of live.filter((w) => worktreeOrigin(w) === 'klaude')) wsRow(ws, '  ');
    // Worktrees other tools made (Claude Code sub-agents, other apps) stay folded so they don't drown yours.
    const foldable: Array<{ key: string; label: string; list: Workspace[]; hint: string; action?: UiAction }> = [
      { key: `agents:${p.id}`, label: 'Claude Code agents', list: live.filter((w) => worktreeOrigin(w) === 'agent'), hint: 'Worktrees Claude Code sub-agents created', action: { type: 'agents_menu', projectId: p.id } },
      { key: `external:${p.id}`, label: 'Other worktrees', list: live.filter((w) => worktreeOrigin(w) === 'external'), hint: 'Worktrees made outside klaude' },
    ];
    for (const f of foldable) {
      if (!f.list.length) continue;
      const showing = toggled.has(f.key) || f.list.some((w) => w.id === current);
      const left: Line = [{ text: `    ${showing ? '▾' : '▸'} ${f.label} `, color: theme.muted }, { text: String(f.list.length), color: theme.muted, bold: true }];
      if (f.action) addWithButtons(left, [{ label: '⋯', color: theme.muted, action: f.action, hint: 'Clean up finished agent worktrees' }], { type: 'toggle_fold', key: f.key }, `${showing ? 'Hide' : 'Show'} ${f.hint.toLowerCase()}`);
      else add(left, { type: 'toggle_fold', key: f.key }, `${showing ? 'Hide' : 'Show'} ${f.hint.toLowerCase()}`);
      if (showing) for (const ws of f.list) wsRow(ws, '    ');
    }
    const archived = p.workspaces.filter((w) => w.archived);
    if (archived.length) {
      const showing = toggled.has(`archive:${p.id}`);
      add(plain(`    ${showing ? '▾' : '▸'} Archived (${archived.length})`, { color: theme.muted }), { type: 'toggle_archive', projectId: p.id }, showing ? 'Hide archived workspaces' : 'Show archived workspaces');
      if (showing) {
        for (const ws of archived) {
          add([{ text: '      ' }, { text: `${glyph.ring} ${ws.name}`, color: theme.muted }], { type: 'archived_menu', id: ws.id }, `${ws.name}: restore, open folder, or delete`);
        }
      }
    }
  };

  addWithButtons(section('PROJECTS', theme.info), [{ label: '+ add', color: theme.info, action: { type: 'add_project' }, hint: 'Add a project, or a folder of projects' }], { type: 'none' }, '');
  if (!repos.length) add(plain('  No projects found yet', { color: theme.border }));
  for (const p of loose) projectBlock(p);
  for (const [name, list] of grouped) {
    lines.push([]);
    const open = !toggled.has(`group:${name}`);
    add([{ text: open ? '▾ ' : '▸ ', color: theme.muted }, { text: name.toUpperCase(), color: theme.accent, bold: true }, { text: ` ${list.length}`, color: theme.muted }], { type: 'toggle_group', name }, open ? `Collapse ${name}` : `Expand ${name}`);
    if (open) for (const p of list) projectBlock(p);
  }
  return { lines, zones };
}

/** Three clear tabs: the group chat with everyone, shared files, and the overview of all work. */
export function tabsModel(state: AppState, width: number): Model {
  const segs: Seg[] = [];
  const zones: Zone[] = [];
  let x = 0;
  const v = state.view;
  const tab = (label: string, active: boolean, action: UiAction, hint: string, badge?: number): void => {
    const text = ` ${label}${badge ? ` (${badge})` : ''} `;
    segs.push({ text, color: active ? theme.text : theme.muted, bold: active, inverse: active });
    zones.push({ x0: x, x1: x + text.length - 1, y: 0, action, hint });
    x += text.length;
    segs.push({ text: '  ' });
    x += 2;
  };
  const solo = state.peers.length <= 1;
  tab(solo ? 'Chat' : 'Group chat', v.kind === 'room', { type: 'view', view: { kind: 'room' } }, solo ? 'Talk with your Claude, or @a-workspace to reach the Claude working there' : 'Chat with everyone in the room and their Claudes', state.unread.room);
  tab('Shared files', v.kind === 'files', { type: 'view', view: { kind: 'files' } }, "Browse folders people in the room share");
  tab('Overview', v.kind === 'overview', { type: 'view', view: { kind: 'overview' } }, 'Every worktree and chat at a glance');
  tab('Search', v.kind === 'search', { type: 'view', view: { kind: 'search' } }, 'Search every conversation');
  tab('Usage', v.kind === 'usage', { type: 'view', view: { kind: 'usage' } }, 'Disk space and Claude usage per workspace');
  if (v.kind === 'workspace') {
    const ws = findWorkspace(state.projects, v.id);
    if (ws) segs.push({ text: `›  ${ws.name}`, color: theme.accent, bold: true });
  }
  if (v.kind === 'draft') segs.push({ text: '›  New chat', color: theme.accent, bold: true });
  if (v.kind === 'draft_worktree') segs.push({ text: '›  New worktree', color: theme.accent, bold: true });
  if (v.kind === 'shared') {
    const w = state.shared.find((x) => x.id === (v as { id: string }).id);
    if (w) segs.push({ text: `›  ${w.name}`, color: theme.ok, bold: true });
  }
  return { lines: [truncate(segs, width), [{ text: '─'.repeat(Math.max(0, width)), color: theme.border }]], zones: zones.filter((z) => z.x0 < width) };
}

// ---------------------------------------------------------------- overview

const CARD_HEIGHT = 5;

/** One clear card per workspace: name, one state phrase, and two or three buttons. */
export function overviewModel(state: AppState, frame: number, width: number, now = Date.now()): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  const all = state.projects.flatMap((p) => p.workspaces.filter((w) => !w.archived && w.kind !== 'main' && worktreeOrigin(w) !== 'agent').map((w) => ({ p, w })));
  const working = all.filter(({ w }) => activityOf(state.log, `ws:${w.id}`).running).length;
  const needsYou = all.filter(({ w }) => state.conflicts[w.id]?.length || activityOf(state.log, `ws:${w.id}`).awaiting).length;
  lines.push([
    { text: `${all.length} active`, color: theme.text, bold: true },
    { text: working ? `   ${SPINNER[frame % SPINNER.length]} ${working} working` : '', color: theme.claude },
    { text: needsYou ? `   ${glyph.wait} ${needsYou} need you` : '', color: theme.warn },
  ]);
  lines.push([]);
  if (!all.length) {
    lines.push(plain('Nothing in progress. Use +⌥ on a project to start a worktree, or + new under CHATS.', { color: theme.muted }));
    return { lines, zones };
  }
  const cols = width >= 120 ? 3 : width >= 76 ? 2 : 1;
  const gap = 2;
  const cardW = Math.floor((width - gap * (cols - 1)) / cols);
  for (let i = 0; i < all.length; i += cols) {
    const rowCards = all.slice(i, i + cols).map(({ p, w }) => card(state, p, w, frame, cardW, now));
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
  }
  return { lines, zones };
}

function card(state: AppState, p: Project, w: Workspace, frame: number, width: number, now: number): Model {
  const inner = width - 4;
  const st = stateOf(state, w, frame, now);
  const border = st.color === theme.ok || st.color === theme.muted ? theme.border : st.color;
  const b = (t: string): Seg => ({ text: t, color: border });
  const icon = w.kind === 'chat' ? '◇' : BRANCH;
  const disk = state.disk[w.id];
  const title: Line = split([{ text: `${icon} `, color: theme.muted }, { text: w.name, color: theme.text, bold: true }, { text: p.root ? `  ${p.name}` : '', color: theme.muted }], disk ? [{ text: formatBytes(disk), color: theme.muted }] : [], inner);
  const pr = state.prs[w.id];
  const setup = state.setup[w.id];
  const extra: Seg[] = pr
    ? [{ text: `  ·  ${describePr(pr)}`, color: pr.checks === 'failing' ? theme.error : pr.state === 'MERGED' ? theme.ok : theme.info }]
    : setup?.status === 'running'
      ? [{ text: '  ·  setting up…', color: theme.info }]
      : setup?.status === 'failed'
        ? [{ text: '  ·  setup failed', color: theme.error }]
        : [];
  const status: Line = [{ text: `${st.icon} `, color: st.color }, { text: st.label, color: st.color }, ...extra];
  const buttons: Array<{ label: string; action: UiAction; hint: string }> = [
    { label: 'Open', action: { type: 'open_ws', id: w.id }, hint: `Open ${w.name}` },
    ...(state.conflicts[w.id]?.length ? [{ label: 'Solve conflict', action: { type: 'ws', id: w.id, action: 'merge_claude' } as UiAction, hint: 'Ask Claude to resolve the merge conflict' }] : []),
    ...(w.kind === 'worktree' && (w.status?.ahead ?? 0) > 0 && !(w.status?.changed ?? 0) && !state.conflicts[w.id]?.length
      ? [{ label: 'Merge', action: { type: 'ws', id: w.id, action: 'merge' } as UiAction, hint: `Merge ${w.branch} into ${p.name}'s main folder` }]
      : []),
    ...(w.kind === 'worktree' && ((w.status?.ahead ?? 0) > 0 || pr) ? [{ label: pr ? `PR #${pr.number}` : 'PR', action: { type: 'ws', id: w.id, action: 'pr' } as UiAction, hint: pr ? describePr(pr) : 'Claude opens a pull request with a short description' }] : []),
  ];
  const zones: Zone[] = [];
  const btnSegs: Seg[] = [];
  let x = 2;
  for (const btn of buttons) {
    const label = ` ${btn.label} `;
    zones.push({ x0: x, x1: x + label.length - 1, y: 3, action: btn.action, hint: btn.hint });
    btnSegs.push({ text: label, color: theme.text, inverse: true }, { text: ' ' });
    x += label.length + 1;
  }
  zones.push({ x0: 0, x1: width - 1, y: 1, action: { type: 'open_ws', id: w.id }, hint: `Open ${w.name}` });
  const rows = [title, status, btnSegs];
  return {
    lines: [[b('╭'), b('─'.repeat(width - 2)), b('╮')], ...rows.map((l) => [b('│ '), ...pad(l, inner), b(' │')]), [b('╰'), b('─'.repeat(width - 2)), b('╯')]],
    zones,
  };
}

// ---------------------------------------------------------------- workspace header

/**
 * Workspace header: where you are + state, the Chat/Files/Diff tabs, and every action as
 * a button. Buttons that can't do anything right now are dimmed and explain why.
 */
/** "Share" (or "Shared · 2") opens who's in this workspace and lets you invite or remove people. */
function sharedButton(state: AppState, wsId: string): { label: string; action: WorkspaceAction; hint: string } {
  const count = Object.keys(state.members[wsId] ?? {}).length;
  const others = state.peers.filter((p) => p.peerId !== state.self?.peerId).length;
  return {
    label: count ? `Shared · ${count}` : 'Share',
    action: 'share',
    hint: count ? `${count} ${count === 1 ? 'person is' : 'people are'} in this workspace: invite or remove people` : others ? 'Invite people in the room to work here with you' : 'Invite a friend to work here with you',
  };
}

export function workspaceHeaderModel(state: AppState, ws: Workspace, width: number, frame = 0): Model {
  const project = state.projects.find((p) => p.id === ws.projectId);
  const view = state.view.kind === 'workspace' ? state.view : undefined;
  const st = stateOf(state, ws, frame);
  const zones: Zone[] = [];
  const title: Line = [
    { text: project?.root ? `${project.name} › ` : '', color: theme.muted },
    { text: ws.name, color: theme.text, bold: true },
    { text: ws.kind === 'chat' ? (ws.projectRoot ? '  chat in main folder' : '  Claude chat') : ws.branch ? `  ${BRANCH} ${ws.branch}` : '', color: theme.muted },
    { text: '   ' },
    { text: `${st.icon} ${st.label}`, color: st.color },
  ];
  const tabs: Array<[string, WorkspaceTab, string]> = [
    ['Chat', 'chat', 'Your conversation with Claude'],
    ['Files', 'files', 'Browse this folder'],
    ...(ws.kind === 'chat' ? [] : ([['Diff', 'review', 'See exactly what changed']] as Array<[string, WorkspaceTab, string]>)),
    ['Terminal', 'terminal', 'A real shell in this folder, plus setup and run'],
  ];
  const changed = ws.status?.changed ?? 0;
  const ahead = ws.status?.ahead ?? 0;
  const conflict = Boolean(state.conflicts[ws.id]?.length);
  const pr = state.prs[ws.id];
  const scripts = project?.scripts;
  const friends = state.peers.some((p) => p.peerId !== state.self?.peerId && p.agent);
  type Btn = { label: string; action: WorkspaceAction; hint: string; disabled?: boolean; danger?: boolean; color?: string };
  const all: Btn[] = ws.archived
    ? [
        { label: 'Restore', action: 'restore', hint: 'Bring this workspace back' },
        { label: 'Delete', action: 'delete', hint: 'Delete permanently', danger: true },
      ]
    : [
        ...(scripts?.run ? ([{ label: 'Run', action: 'run', hint: `Start ${scripts.run.command} in the Terminal tab` }] as Btn[]) : []),
        { label: 'Review', action: 'review_claude', hint: 'Ask Claude to check everything: bugs, security, tests and quality' },
        ...(ws.kind === 'worktree'
          ? ([
              { label: 'Commit', action: 'commit', hint: changed ? `Commit ${changed} changed file(s)` : 'Nothing to commit', disabled: !changed },
              pr
                ? { label: `PR #${pr.number}${pr.checks === 'passing' ? ' ✓' : pr.checks === 'failing' ? ' ✗' : pr.checks === 'pending' ? ' …' : ''}`, action: 'pr', hint: `${describePr(pr)}: open it, fix checks, or update it`, color: pr.checks === 'failing' ? theme.error : pr.state === 'MERGED' ? theme.ok : theme.info }
                : { label: 'PR', action: 'pr', hint: ahead || changed ? 'Claude pushes and opens a pull request with a short description' : 'Nothing to put in a pull request yet', disabled: !ahead && !changed },
              conflict
                ? { label: 'Solve conflict', action: 'merge_claude', hint: 'Ask Claude to resolve the merge conflict and finish the merge' }
                : {
                    label: 'Merge',
                    action: 'merge',
                    hint: changed ? 'Commit your changes first' : ahead ? `Merge ${ahead} commit(s) into ${project?.name ?? 'the'} main folder` : 'Nothing to merge yet',
                    disabled: !ahead || changed > 0,
                  },
              { label: 'Hand off', action: 'handoff', hint: friends ? "Someone else's Claude continues this on their computer" : 'Invite someone first; then they can take this over', disabled: !friends },
            ] as Btn[])
          : []),
        ...(state.context[`ws:${ws.id}`] ? ([{ label: 'Compact', action: 'compact', hint: 'Shrink the conversation so Claude has room to keep going' }] as Btn[]) : []),
        ...(ws.kind !== 'chat' ? ([{ label: 'Fork', action: 'fork', hint: 'Copy this workspace and its conversation into a new worktree' }] as Btn[]) : []),
        { label: 'Finder', action: 'finder', hint: 'Open this folder in Finder' },
        ...(ws.kind !== 'main' ? ([{ label: 'Archive', action: 'archive', hint: 'Put it away; keeps the branch and conversation' }] as Btn[]) : []),
        sharedButton(state, ws.id),
      ];
  // You choose which buttons show (Settings → Workspaces → Top bar buttons); hidden ones still work as /commands.
  // "Solve conflict" is never hidden: it's the way out of a conflict.
  const buttons = all.filter((b) => b.action === 'merge_claude' || !state.prefs.hiddenButtons.includes(b.action));
  const segs: Seg[] = [];
  let x = 0;
  for (const [label, tab, hint] of tabs) {
    const active = view?.tab === tab;
    const text = ` ${label} `;
    segs.push({ text, color: active ? theme.text : theme.muted, bold: active, inverse: active });
    zones.push({ x0: x, x1: x + text.length - 1, y: 1, action: { type: 'open_ws', id: ws.id, tab }, hint });
    x += text.length;
    segs.push({ text: ' ' });
    x += 1;
  }
  segs.push({ text: '│ ', color: theme.border });
  x += 2;
  // Buttons that don't fit go under "⋯ More" (a menu), so nothing is ever cut off.
  const MORE = ' ⋯ More ';
  const widths = buttons.map((b) => b.label.length + 2);
  const total = widths.reduce((n, w) => n + w, 0);
  let fit = buttons.length;
  if (x + total > width) {
    fit = 0;
    let used = x + MORE.length;
    while (fit < buttons.length && used + widths[fit]! <= width) used += widths[fit++]!;
  }
  for (const btn of buttons.slice(0, fit)) {
    const text = ` ${btn.label} `;
    segs.push({ text, color: btn.disabled ? theme.border : btn.danger ? theme.error : btn.label === 'Solve conflict' ? theme.error : (btn.color ?? (btn.action === 'share' ? theme.info : theme.text)), bold: !btn.disabled });
    zones.push({ x0: x, x1: x + text.length - 1, y: 1, action: { type: 'ws', id: ws.id, action: btn.action }, hint: btn.hint, disabled: btn.disabled });
    x += text.length;
  }
  const rest = buttons.slice(fit).filter((b) => !b.disabled);
  if (rest.length) {
    segs.push({ text: MORE, color: theme.muted, bold: true });
    zones.push({ x0: x, x1: x + MORE.length - 1, y: 1, action: { type: 'ws_more', id: ws.id, actions: rest.map((b) => ({ action: b.action, label: b.label, hint: b.hint })) }, hint: rest.map((b) => b.label).join(', ') });
  }
  const third: Line = conflict
    ? [{ text: `! Merge conflict in ${state.conflicts[ws.id]?.join(', ')}`, color: theme.error, bold: true }, { text: '   Click "Solve conflict" and Claude will resolve it', color: theme.muted }]
    : [{ text: '─'.repeat(width), color: theme.border }];
  const meter = state.prefs.contextMeter ? contextMeter(state, `ws:${ws.id}`, 12) : [];
  const disk = state.disk[ws.id];
  const tokens = ws.usage ? ws.usage.input + ws.usage.output + ws.usage.cacheWrite : 0;
  const space: Line = [disk !== undefined ? formatBytes(disk) : '', tokens ? `${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens` : ''].filter(Boolean).length
    ? [{ text: [disk !== undefined ? formatBytes(disk) : '', tokens ? `${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens` : ''].filter(Boolean).join(' · '), color: theme.muted }, { text: meter.length ? '   ' : '' }]
    : [];
  const right: Line = [...space, ...meter];
  const titleLine = right.length ? split(title, right, width) : truncate(title, width);
  return { lines: [titleLine, truncate(segs, width), truncate(third, width)], zones: zones.filter((z) => z.x0 < width) };
}

// ---------------------------------------------------------------- review (diff)

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
