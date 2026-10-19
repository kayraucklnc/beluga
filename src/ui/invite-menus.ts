import type { Guest } from '../core/collab-store.js';
import { CAN_INFO, expiresIn, guestSummary } from '../shared/invites.js';
import type { AppState } from '../core/store.js';
import type { GuestCan } from '../protocol.js';
import type { MenuOption, MenuSpec } from './menus.js';

/** The Invite flow's choices; each click re-opens the menu with one of them changed. */
export interface InviteChoice {
  /** A project id, or 'room' for everything. */
  readonly scope: string;
  readonly can: GuestCan;
  readonly knock: boolean;
  readonly singleUse: boolean;
  readonly expires: boolean;
  /** The project it was opened from (offered as "This project"). */
  readonly from?: string;
}

export type InviteMenuKind =
  | ({ readonly kind: 'invite_link' } & InviteChoice)
  /** From a guest in People: put them into one more project. */
  | { readonly kind: 'guest_add'; readonly peerId: string };

export const CAN_ORDER: readonly GuestCan[] = ['watch', 'prompt', 'edit'];

/** Fresh choices: this project when opened from one (else everything), they can prompt, knock, single use, 24h. */
export function inviteChoice(from?: string): InviteChoice {
  return { scope: from ?? 'room', can: 'prompt', knock: true, singleUse: true, expires: true, ...(from ? { from } : {}) };
}

const projectName = (state: AppState, id: string): string => (id === 'room' ? 'everything' : (state.projects.find((p) => p.id === id)?.name ?? 'a project'));
const radio = (on: boolean): string => (on ? '◉' : '○');
const check = (on: boolean): string => (on ? '☑' : '☐');
/** Labels line up in two columns: the question, then the choice. */
const row = (head: string, text: string): string => `${head.padEnd(11)}${text}`;

/** Projects you can invite into (folders with a git root, not the loose chats). */
const invitable = (state: AppState) => state.projects.filter((p) => p.root);

/**
 * One Invite flow: where to (this project or everything), what they can do, how the link
 * behaves, then Copy. Links you made are listed below it to turn off.
 */
export function inviteMenu(state: AppState, c: InviteChoice, available: boolean): MenuSpec {
  if (!available) {
    return {
      title: 'Invite someone',
      intro: ["Links for one project work in rooms you host. You joined someone else's room, so you can pass on its invite."],
      options: [...(state.invite ? [{ id: 'invite', label: 'Copy the room invite', hint: 'they join the whole room' }] : []), { id: 'close', label: 'Cancel', hint: 'Esc' }],
    };
  }
  const where = c.from ? [c.from] : invitable(state).slice(0, 6).map((p) => p.id);
  const scopes = c.from ? [...where, 'room'] : ['room', ...where];
  const options: MenuOption[] = [
    ...scopes.map((s, i) => ({
      id: `il-scope:${s}`,
      label: row(i === 0 ? 'Invite to' : '', `${radio(c.scope === s)} ${s === 'room' ? 'Everything (the whole room)' : s === c.from ? `This project · ${projectName(state, s)}` : projectName(state, s)}`),
      hint: s === 'room' ? 'the room chat and everything you share' : 'all its worktrees and chats, nothing else',
    })),
    ...CAN_ORDER.map((can, i) => ({ id: `il-can:${can}`, label: row(i === 0 ? 'They can' : '', `${radio(c.can === can)} ${CAN_INFO[can].label}`), hint: CAN_INFO[can].detail })),
    { id: 'il-knock', label: row('The link', `${check(c.knock)} Knock first`), hint: c.knock ? 'you let them in from a card' : 'they come straight in' },
    { id: 'il-single', label: row('', `${check(c.singleUse)} One person only`), hint: c.singleUse ? 'stops working after the first person' : 'anyone with the link can come' },
    { id: 'il-expires', label: row('', `${check(c.expires)} Expires in 24 hours`), hint: c.expires ? '' : 'works until you turn it off or quit klaud' },
    { id: 'il-copy', label: `▸ Copy invite link`, hint: `${projectName(state, c.scope)} · ${CAN_INFO[c.can].short}${c.knock ? ' · knocks first' : ''}` },
    ...linkOptions(state),
    ...(state.invite ? [{ id: 'invite', label: "Copy the room's open link instead", hint: 'anyone with it joins everything, no knock' }] : []),
    { id: 'close', label: 'Cancel', hint: 'Esc' },
  ];
  return {
    title: 'Invite someone',
    intro: ['They run klaud join <link>. Files stream as they open them; secrets (.env, keys) never leave.'],
    options,
  };
}

/** Index of "Copy invite link" (where the menu opens, so Enter copies right away). */
export const copyIndex = (spec: MenuSpec): number => Math.max(0, spec.options.findIndex((o) => o.id === 'il-copy'));

/** Links you made, each one click to turn off. */
function linkOptions(state: AppState, now = Date.now()): MenuOption[] {
  return state.links.map((l) => ({
    id: `il-revoke:${l.id}`,
    label: `Turn off link: ${l.label} · ${CAN_INFO[l.can].short}`,
    hint: `${expiresIn(l.expiresAt, now)} · ${l.used ? `used by ${l.used}` : 'not used yet'}${l.singleUse ? ' · one person' : ''}`,
  }));
}

/** "mia · bob-api · can prompt" */
export const guestLine = (state: AppState, g: Guest): string => `${g.name} · ${guestSummary(g, (id) => projectName(state, id))}`;

/** A guest in People: what they're in and can do, and how to give them more (or less), no new link needed. */
export function guestPersonMenu(state: AppState, g: Guest): MenuSpec {
  const more = invitable(state).some((p) => !g.projects.includes(p.id));
  return {
    title: g.name,
    intro: [guestLine(state, g), g.room ? 'Invited to everything: the room chat and what you share.' : 'Came in with a link: they only see what you invited them to.'],
    options: [
      ...CAN_ORDER.map((can, i) => ({ id: `g-can:${can}`, label: row(i === 0 ? 'They can' : '', `${radio(g.can === can)} ${CAN_INFO[can].label}`), hint: CAN_INFO[can].detail })),
      ...(more && !g.room ? [{ id: 'g-add', label: 'Add to another project…', hint: 'same link, nothing to send' }] : []),
      ...(g.room ? [] : [{ id: 'g-room', label: 'Invite to everything', hint: 'room chat + what you share' }]),
      { id: 'g-remove', label: `Remove ${g.name}`, hint: 'they are disconnected and lose access' },
      { id: 'close', label: 'Close', hint: 'Esc' },
    ],
  };
}

/** Pick one more project for a guest. */
export function guestAddMenu(state: AppState, peerId: string): MenuSpec | undefined {
  const g = state.guests[peerId];
  if (!g) return undefined;
  return {
    title: `Add ${g.name} to…`,
    intro: [`${g.name} gets the project's worktrees and chats (${CAN_INFO[g.can].short}).`],
    options: [
      ...invitable(state).map((p) => ({ id: `ga:${p.id}`, label: p.name, hint: g.projects.includes(p.id) ? 'already in' : '' })),
      { id: 'close', label: 'Cancel', hint: 'Esc' },
    ],
  };
}
