import type { PendingQuestion, SharedWorkspace } from '../core/collab-store.js';
import { type AppState, peerName } from '../core/store.js';
import { ansiToLine } from './ansi.js';
import { renderMarkdownAnsi } from './markdown-render.js';
import { type Line, type Seg, plain, truncate, wrapText } from './text.js';
import { theme } from './theme.js';
import { type Model, type UiAction, type Zone, split } from './workspace-models.js';

/** How many lines of a proposed plan the card shows before "…". */
const PLAN_LINES = 12;
const QUESTION_MAX_LINES = 4;

/** Where a question came from, in words: "Claude in add-auth", "bob's Claude". */
function whoAsks(state: AppState, q: PendingQuestion): string {
  const owner = q.owner === state.self?.peerId ? 'Your Claude' : `${peerName(state, q.owner)}'s Claude`;
  if (q.channel === 'room') return owner;
  const id = q.channel.slice(3);
  const ws = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id) ?? state.shared.find((w) => w.id === id);
  return ws ? `${owner} in ${ws.name}` : owner;
}

/** A row of buttons; returns the line and registers each button's zone at row `y`. */
function buttonRow(buttons: Array<{ label: string; color: string; action: UiAction; hint: string }>, y: number, zones: Zone[], x0 = 0): Line {
  const segs: Seg[] = [];
  let x = x0;
  if (x0) segs.push({ text: ' '.repeat(x0) });
  for (const b of buttons) {
    const text = ` ${b.label} `;
    segs.push({ text, color: b.color, bold: true, inverse: true });
    zones.push({ x0: x, x1: x + text.length - 1, y, action: b.action, hint: b.hint });
    segs.push({ text: '  ' });
    x += text.length + 2;
  }
  return segs;
}

/**
 * The card Claude uses to ask you something: one question at a time with clickable
 * options (numbers work too), or a plan with Approve / Revise. Typing your own answer
 * and pressing Enter works as well.
 */
export function questionModel(state: AppState, q: PendingQuestion, width: number): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  const inner = Math.max(10, width);
  const waiting = state.questions.length - 1;
  const title: Line = [
    { text: '? ', color: theme.info, bold: true },
    { text: whoAsks(state, q), color: theme.info, bold: true },
    { text: q.question.kind === 'plan' ? ' proposes a plan' : ' asks', color: theme.info },
    ...(waiting > 0 ? [{ text: `   +${waiting} more waiting`, color: theme.muted }] : []),
  ];
  lines.push(truncate(title, inner));

  if (q.question.kind === 'plan') {
    const rendered = renderMarkdownAnsi(q.question.plan, inner - 2).map(ansiToLine);
    for (const l of rendered.slice(0, PLAN_LINES)) lines.push(truncate([{ text: '  ' }, ...l], inner));
    if (rendered.length > PLAN_LINES) lines.push(plain(`  … ${rendered.length - PLAN_LINES} more lines: open it full screen (Ctrl+F)`, { color: theme.muted }));
    lines.push([]);
    lines.push(
      buttonRow(
        [
          { label: '✓ Approve plan', color: theme.ok, action: { type: 'answer', qid: q.qid, pick: 'approve' }, hint: 'Claude starts doing the work' },
          { label: 'Keep planning', color: theme.muted, action: { type: 'answer', qid: q.qid, pick: 'revise' }, hint: "Claude won't change anything yet. Type what to change and press Enter" },
          { label: '⛶ Full screen', color: theme.info, action: { type: 'plan_full', qid: q.qid }, hint: 'Read the whole plan full screen (Ctrl+F)' },
        ],
        lines.length,
        zones,
        2,
      ),
    );
    lines.push(plain('  or type what to change and press Enter', { color: theme.muted }));
    return { lines, zones };
  }

  // One question at a time; answered ones are remembered until all are done.
  const current = q.question.questions.find((x) => q.picked[x.question] === undefined) ?? q.question.questions[0]!;
  const index = q.question.questions.indexOf(current);
  const total = q.question.questions.length;
  const head = `${current.header ? `${current.header}: ` : ''}${current.question}${total > 1 ? `  (${index + 1} of ${total})` : ''}`;
  for (const l of wrapText(head, inner - 2).slice(0, QUESTION_MAX_LINES)) lines.push(plain(`  ${l}`, { color: theme.text, bold: true }));
  const chosen = new Set((q.picked[`${current.question}#multi`] ?? '').split('\u0000').filter(Boolean));
  current.options.forEach((o, i) => {
    const mark = current.multiSelect ? (chosen.has(o.label) ? '◉' : '○') : `${i + 1}`;
    const left: Line = [
      { text: `  ${mark} `, color: theme.info, bold: true },
      { text: o.label, color: theme.text, bold: true },
      ...(o.description ? [{ text: `  ${o.description}`, color: theme.muted }] : []),
    ];
    zones.push({ x0: 0, x1: inner - 1, y: lines.length, action: { type: 'answer', qid: q.qid, pick: 'option', label: o.label, question: current.question }, hint: current.multiSelect ? `Select "${o.label}"` : `Answer "${o.label}"` });
    lines.push(truncate(left, inner));
  });
  lines.push(
    buttonRow(
      [
        ...(current.multiSelect ? [{ label: 'Done', color: theme.ok, action: { type: 'answer', qid: q.qid, pick: 'done', question: current.question } as UiAction, hint: 'Send the selected options' }] : []),
        { label: 'Skip', color: theme.muted, action: { type: 'answer', qid: q.qid, pick: 'skip' }, hint: 'Let Claude decide and say what it assumed' },
      ],
      lines.length,
      zones,
      2,
    ),
  );
  lines.push(plain(current.multiSelect ? '  click options to select, or type your own answer and press Enter' : `  press ${current.options.length > 1 ? `1–${current.options.length}` : '1'}, click, or type your own answer and press Enter`, { color: theme.muted }));
  return { lines, zones };
}

/**
 * Claude's plan, full screen: the whole thing, scrollable, with Approve / Keep planning
 * always visible at the bottom. Returns lines for a box `height` rows tall.
 */
export function planFullModel(state: AppState, q: PendingQuestion, width: number, height: number, scroll: number): Model & { maxScroll: number } {
  const zones: Zone[] = [];
  const plan = q.question.kind === 'plan' ? q.question.plan : '';
  const body = renderMarkdownAnsi(plan, Math.max(20, width - 2)).map(ansiToLine);
  const room = Math.max(1, height - 3);
  const maxScroll = Math.max(0, body.length - room);
  const top = Math.min(Math.max(0, scroll), maxScroll);
  const lines: Line[] = body.slice(top, top + room).map((l) => truncate([{ text: ' ' }, ...l], width));
  while (lines.length < room) lines.push([]);
  const more = maxScroll ? `${top > 0 ? '↑' : ' '}${top < maxScroll ? '↓' : ' '} ${Math.round(((top + room) / Math.max(room, body.length)) * 100)}% · ↑↓ PgUp PgDn` : '';
  lines.push(more ? plain(` ${more}`, { color: theme.muted }) : []);
  lines.push(
    buttonRow(
      [
        { label: '✓ Approve plan', color: theme.ok, action: { type: 'answer', qid: q.qid, pick: 'approve' }, hint: 'Claude starts doing the work' },
        { label: 'Keep planning', color: theme.muted, action: { type: 'answer', qid: q.qid, pick: 'revise' }, hint: "Claude won't change anything yet. Type what to change and press Enter" },
        { label: 'Close', color: theme.muted, action: { type: 'plan_full' }, hint: 'Back to the card (Esc)' },
      ],
      lines.length,
      zones,
      1,
    ),
  );
  lines.push(plain(` ${whoAsks(state, q)} proposes this plan · type below what to change and press Enter`, { color: theme.muted }));
  return { lines: lines.slice(0, height), zones, maxScroll };
}

/** SHARED WITH ME: workspaces friends invited you into. */
export function sharedSection(state: AppState, width: number, current?: string): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  if (!state.shared.length) return { lines, zones };
  lines.push([]);
  lines.push([{ text: 'SHARED WITH ME', color: theme.ok, bold: true }]);
  for (const w of state.shared) {
    const selected = current === w.id;
    const left: Line = [
      { text: selected ? '▌' : ' ', color: theme.accent },
      { text: ' ◈ ', color: theme.ok },
      { text: w.name, color: theme.text, bold: selected },
      { text: `  ${peerName(state, w.owner)}`, color: theme.muted },
      ...(state.peers.some((p) => p.peerId === w.owner) ? [] : [{ text: ' (offline)', color: theme.border }]),
    ];
    const menu = '⋯';
    const y = lines.length;
    zones.push({ x0: width - 1, x1: width - 1, y, action: { type: 'shared_menu', owner: w.owner, id: w.id }, hint: `${w.name}: open files, or leave` });
    zones.push({ x0: 0, x1: width - 3, y, action: { type: 'open_shared', owner: w.owner, id: w.id }, hint: `Open ${peerName(state, w.owner)}'s ${w.name}${w.role === 'view' ? ' (following along)' : ''}` });
    lines.push(split(left, [{ text: menu, color: theme.muted }], width));
  }
  return { lines, zones };
}

/** Header for a workspace someone shared with you: Chat / Files, plan mode, and Leave. */
export function sharedHeaderModel(state: AppState, w: SharedWorkspace, width: number): Model {
  const zones: Zone[] = [];
  const view = state.view.kind === 'shared' ? state.view : undefined;
  const owner = peerName(state, w.owner);
  const title: Line = [
    { text: `${owner}'s ${w.project ? `${w.project} › ` : ''}`, color: theme.muted },
    { text: w.name, color: theme.text, bold: true },
    { text: w.branch ? `  ⌥ ${w.branch}` : '', color: theme.muted },
    { text: `   ◈ ${w.role === 'contribute' ? `you're working here with ${owner}` : `you're following along`}`, color: theme.ok },
  ];
  const segs: Seg[] = [];
  let x = 0;
  const add = (text: string, action: UiAction, hint: string, color: string, active = false): void => {
    segs.push({ text, color, bold: true, inverse: active });
    zones.push({ x0: x, x1: x + text.length - 1, y: 1, action, hint });
    segs.push({ text: ' ' });
    x += text.length + 1;
  };
  add(' Chat ', { type: 'open_shared', owner: w.owner, id: w.id, tab: 'chat' }, `The conversation with ${owner}'s Claude`, view?.tab === 'chat' ? theme.text : theme.muted, view?.tab === 'chat');
  add(' Files ', { type: 'open_shared', owner: w.owner, id: w.id, tab: 'files' }, `Browse ${owner}'s worktree`, view?.tab === 'files' ? theme.text : theme.muted, view?.tab === 'files');
  segs.push({ text: '│ ', color: theme.border });
  x += 2;
  add(' Leave ', { type: 'shared_menu', owner: w.owner, id: w.id }, `Leave ${w.name}`, theme.error);
  return { lines: [truncate(title, width), truncate(segs, width), [{ text: '─'.repeat(Math.max(0, width)), color: theme.border }]], zones: zones.filter((z) => z.x0 < width) };
}
