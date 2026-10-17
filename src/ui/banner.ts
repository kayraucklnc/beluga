import type { AppState } from '../core/store.js';
import type { Usage } from '../protocol.js';
import { card, isRunning } from './format.js';
import { type Line, plain, wrapText } from './text.js';
import { SPINNER, colorFor, glyph, theme } from './theme.js';

/** The "invite friends" card shown at the top of the chat while the host is alone. */
export function inviteBanner(state: AppState, cols: number, frame: number): Line[] {
  const { hosting, invite } = state;
  if (!hosting) return [];
  const alone = state.peers.length <= 1;
  if (!alone && (hosting.phase === 'ready' || hosting.phase === 'local')) return [];
  const inner = cols - 4;
  const spin = SPINNER[frame % SPINNER.length];
  const body: Line[] = [];
  let title = 'Invite friends';
  let color: string = theme.info;
  switch (hosting.phase) {
    case 'tunnel':
      body.push(plain(`${spin} Opening a secure tunnel so friends can join from anywhere…`, { color: theme.info }));
      if (hosting.detail) body.push(plain(hosting.detail, { color: theme.muted }));
      break;
    case 'reachable':
      body.push(plain(`${spin} Tunnel is up. Waiting for it to be reachable (usually 10–40s)…`, { color: theme.info }));
      break;
    case 'failed':
      title = 'Remote access unavailable';
      color = theme.warn;
      for (const l of wrapText(hosting.detail ?? 'Could not open a tunnel.', inner)) body.push(plain(l, { color: theme.warn }));
      break;
    case 'ready':
    case 'local':
      if (invite) {
        body.push(plain('Send this to a friend. They paste it into their terminal:', { color: theme.muted }));
        for (const l of wrapText(`klaude join ${invite}`, inner)) body.push(plain(l, { color: theme.text, bold: true }));
        body.push(
          hosting.copied
            ? [
                { text: `${glyph.ok} copied to your clipboard`, color: theme.ok },
                { text: '  ·  /invite copies it again', color: theme.muted },
              ]
            : plain('Type /invite to copy it', { color: theme.muted }),
        );
        if (hosting.phase === 'local') body.push(plain('Local network only. Run without --tunnel none to invite people anywhere.', { color: theme.warn }));
      }
      break;
  }
  return [...card(plain(title, { color, bold: true }), [], body, cols, color), []];
}

export interface PersonRow {
  readonly peerId: string;
  readonly name: string;
  readonly you: boolean;
  readonly color: string;
  readonly agent: Line;
}

/** People list with each person's Claude status. */
export function peopleRows(state: AppState, frame: number): PersonRow[] {
  const spin = SPINNER[frame % SPINNER.length];
  return state.peers.map((p) => {
    const run = [...state.log].reverse().find((l) => l.type === 'agent' && l.owner === p.peerId && isRunning(l.status));
    let agent: Line;
    if (!p.agent) agent = plain(`${glyph.ring} no Claude`, { color: theme.muted });
    else if (run?.type === 'agent' && run.status === 'awaiting_approval') agent = plain(`${glyph.wait} needs approval`, { color: theme.warn });
    else if (run?.type === 'agent') agent = plain(`${spin} working for ${run.requesterName}`, { color: theme.claude });
    else agent = plain(`${glyph.claude} Claude ready`, { color: theme.muted });
    const meter = usageMeter(p.usage);
    return { peerId: p.peerId, name: p.name, you: p.peerId === state.self?.peerId, color: colorFor(p.name), agent: meter ? [...agent, ...meter] : agent };
  });
}

/** Compact "· 5h 42%" meter; turns sand/clay as a window fills up. */
export function usageMeter(usage: Usage | undefined): Line | undefined {
  const w = usage?.fiveHour ?? usage?.week;
  if (!w) return undefined;
  const label = usage?.fiveHour ? '5h' : 'wk';
  const color = w.pct >= 90 ? theme.error : w.pct >= 70 ? theme.warn : theme.muted;
  return [
    { text: ' · ', color: theme.muted },
    { text: `${label} ${w.pct}%`, color },
  ];
}

export const anyActivity = (state: AppState): boolean =>
  state.log.some((l) => l.type === 'agent' && isRunning(l.status)) ||
  state.hosting?.phase === 'tunnel' ||
  state.hosting?.phase === 'reachable';
