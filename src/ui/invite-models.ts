import type { Knock, SharedWorkspace, ShellLine } from '../core/collab-store.js';
import { SHELL_COMMANDS, completions, parseCommand, shownPath } from '../core/guest-shell.js';
import { CAN_INFO } from '../core/project-invites.js';
import { type AppState, peerName } from '../core/store.js';
import type { FsEntry } from '../protocol.js';
import type { Suggestion } from './suggest.js';
import { type Line, type Seg, lineWidth, plain, truncate } from './text.js';
import { SPINNER, glyph, theme } from './theme.js';
import { buttons } from './work-models.js';
import { type Model, type Zone, split } from './workspace-models.js';

// ---------------------------------------------------------------- knock card

/** Someone came to the door with your link: one click to let them in (or as Watch only), or turn them away. */
export function knockCardModel(state: AppState, knock: Knock, width: number): Model {
  const zones: Zone[] = [];
  const name = peerName(state, knock.peerId);
  const link = state.links.find((l) => l.id === knock.linkId);
  const where = link?.label ?? 'a project';
  const can = link?.can ?? 'watch';
  const more = state.knocks.length - 1;
  const lines: Line[] = [
    truncate(
      [
        { text: `${glyph.dot} `, color: theme.info },
        { text: `${name} wants to join ${where}`, color: theme.text, bold: true },
        // The name is whatever they typed: the id is what tells two "alice"s apart.
        { text: ` #${knock.peerId.slice(0, 6)}`, color: theme.muted },
        { text: `  with your link (${CAN_INFO[can].short})`, color: theme.muted },
        { text: more > 0 ? `   +${more} more waiting` : '', color: theme.muted },
      ],
      width,
    ),
  ];
  lines.push(
    buttons(
      [
        { label: `Let in`, action: { type: 'knock', peerId: knock.peerId, pick: 'in' }, hint: `${name} ${CAN_INFO[can].short} in ${where}: ${CAN_INFO[can].detail}`, color: theme.ok },
        ...(can === 'watch' ? [] : [{ label: 'Watch only', action: { type: 'knock', peerId: knock.peerId, pick: 'watch' } as const, hint: `Let ${name} in to ${CAN_INFO.watch.detail} (change it later in People)`, color: theme.info }]),
        { label: 'Decline', action: { type: 'knock', peerId: knock.peerId, pick: 'decline' }, hint: `Turn ${name} away. They can knock again only with a new link`, color: theme.muted },
      ],
      lines.length,
      zones,
      2,
      2,
    ),
  );
  return { lines, zones };
}

/** The first person at the door who is still connected. */
export const firstKnock = (state: AppState): Knock | undefined => state.knocks.find((k) => state.peers.some((p) => p.peerId === k.peerId));

// ---------------------------------------------------------------- the read-only shell

const TONE: Record<NonNullable<ShellLine['tone']>, string> = { dir: theme.info, file: theme.text, error: theme.error, muted: theme.muted, match: theme.text };

/**
 * A guest's Terminal tab: a bar with clickable shortcuts, then the commands and their output,
 * newest at the bottom. Every folder or file name in the output opens when clicked.
 * `scroll` counts lines up from the bottom.
 */
export function guestShellModel(state: AppState, w: SharedWorkspace, width: number, height: number, scroll: number, frame = 0): Model & { maxScroll: number } {
  const shell = state.shells[w.id] ?? { cwd: '', entries: [], busy: false };
  const owner = peerName(state, w.owner);
  const zones: Zone[] = [];
  const run = (cmd: string): { type: 'shell_run'; id: string; cmd: string } => ({ type: 'shell_run', id: w.id, cmd });
  const barZones: Zone[] = [];
  const left: Seg[] = [{ text: `${glyph.folder} ${shownPath(shell.cwd)}  `, color: theme.text, bold: true }];
  const x0 = left.reduce((n, s) => n + s.text.length, 0);
  const bar = buttons(
    [
      { label: '↑ Up', action: shell.cwd ? run('cd ..') : { type: 'none' }, hint: 'Go up one folder', color: theme.muted, active: false },
      { label: 'ls', action: run('ls'), hint: 'List this folder (click a name to open it)', color: theme.muted, active: false },
      { label: 'tree', action: run('tree'), hint: 'Folders and files, a few levels deep', color: theme.muted, active: false },
      { label: 'help', action: run('help'), hint: 'Every command this shell knows', color: theme.muted, active: false },
      { label: 'clear', action: run('clear'), hint: 'Clear the screen', color: theme.muted, active: false },
    ],
    0,
    barZones,
    x0,
  ).slice(1);
  zones.push(...barZones);
  const note = `read-only · nothing runs on ${owner}'s computer`;
  const head = lineWidth([...left, ...bar]) + note.length + 2 <= width ? split([...left, ...bar], [{ text: note, color: theme.muted }], width) : truncate([...left, ...bar], width);

  const body: Array<{ line: Line; open?: ShellLine }> = [];
  for (const [i, e] of shell.entries.entries()) {
    body.push({ line: [{ text: `${shownPath(e.cwd)} `, color: theme.muted }, { text: '$ ', color: theme.accent, bold: true }, { text: e.cmd, color: theme.text }] });
    const last = i === shell.entries.length - 1;
    if (last && shell.busy && !e.out.length) body.push({ line: plain(`${SPINNER[frame % SPINNER.length]} asking ${owner}'s klaud…`, { color: theme.muted }) });
    for (const o of e.out) body.push({ line: plain(o.text, { color: TONE[o.tone ?? 'file'] }), ...(o.open !== undefined ? { open: o } : {}) });
  }
  if (!body.length) body.push({ line: plain(`A read-only view of ${owner}'s ${w.name}. Type a command below, or click ls.`, { color: theme.muted }) });

  const room = Math.max(1, height - 1);
  const maxScroll = Math.max(0, body.length - room);
  const top = Math.max(0, body.length - room - Math.min(scroll, maxScroll));
  const lines: Line[] = [head];
  for (const [i, b] of body.slice(top, top + room).entries()) {
    lines.push(truncate(b.line, width));
    if (b.open) {
      const rel = b.open.open as string;
      const dir = b.open.dir === true;
      zones.push({ x0: 0, x1: Math.min(width, b.open.text.length) - 1, y: i + 1, action: { type: 'shell_open', id: w.id, rel, dir }, hint: dir ? `Open ${shownPath(rel)}` : `Open ${shownPath(rel)} in the viewer` });
    }
  }
  return { lines, zones, maxScroll };
}

/** Tab completion for the shell, as suggestions above the box (only while a name is half typed). */
export function shellSuggestions(buffer: string, cwd: string, listing: (dir: string) => readonly FsEntry[] | undefined): Suggestion[] {
  if (!buffer.trim() || /[\s/]$/.test(buffer)) return [];
  const { name } = parseCommand(buffer);
  const opens = ['cat', 'less', 'more', 'head', 'open', 'view'].includes(name);
  return completions(buffer, cwd, listing)
    .filter((c) => c.value.trim() !== buffer.trim())
    .map((c) => {
      const cmd = buffer.includes(' ') ? undefined : SHELL_COMMANDS.find((x) => x.name === c.label);
      return {
        label: c.label,
        hint: cmd ? cmd.about : c.dir ? 'folder' : opens ? 'Enter opens it' : 'file',
        value: c.value,
        enter: opens && !c.dir ? ('submit' as const) : ('complete' as const),
      };
    });
}
