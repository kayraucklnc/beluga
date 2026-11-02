/**
 * What `/invite` does (BLG-203): on its own it adds a friend (the Add a Friend sheet: link, code,
 * QR). With friends named (`/invite @ata @bo`) it adds them to what you're looking at: a channel
 * (as members), a DM (it offers a new channel with the three of you), a project or a worktree
 * (shared with them). Plain functions: the Mac's message boxes and the core read it the same way.
 */

export interface InviteFriend {
  readonly peerId: string;
  readonly name: string;
}

/** What's on screen, as far as inviting goes. */
export type InvitePlace =
  | { readonly kind: 'dm'; readonly peerId: string; readonly name: string }
  | { readonly kind: 'group'; readonly groupId: string; readonly name: string; readonly members: readonly string[]; readonly admin: boolean; readonly active: boolean }
  | { readonly kind: 'workspace'; readonly workspaceId: string; readonly projectId?: string; readonly name: string }
  | { readonly kind: 'project'; readonly projectId: string; readonly name: string }
  | { readonly kind: 'none' };

export type InviteRoute =
  /** The Add a Friend sheet. */
  | { readonly kind: 'add_friend' }
  /** Add them to this channel. */
  | { readonly kind: 'add_members'; readonly groupId: string; readonly group: string; readonly friends: readonly InviteFriend[] }
  /** In a DM: offer a new channel with the person you're talking to and them (`with`: everyone but you). */
  | { readonly kind: 'new_channel'; readonly with: readonly InviteFriend[] }
  /** Share this project or worktree with them. */
  | { readonly kind: 'share'; readonly friends: readonly InviteFriend[]; readonly projectId?: string; readonly workspaceId?: string; readonly where: string }
  /** It can't be done: why, in words. */
  | { readonly kind: 'error'; readonly text: string };

/** "/invite", "/invite @ata", "/invite @ata bo," → the names (without @); undefined for anything else. */
export function parseInvite(text: string): { readonly names: readonly string[] } | undefined {
  const m = /^\/invite(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return undefined;
  const names = (m[1] ?? '')
    .split(/[\s,]+/)
    .map((n) => n.replace(/^@+/, '').replace(/[.;:!?]+$/, ''))
    .filter((n) => n && !/^(and|to|&)$/i.test(n));
  return { names: [...new Set(names)] };
}

const lower = (s: string): string => s.toLowerCase();

/** A friend's @handle, as suggest.ts's friendMention writes it ("Mia Chen" → "MiaChen"); kept here because the core reads /invite too and can't import the ui. */
const handleOf = (name: string): string => name.replace(/[^\p{L}\p{N}_.-]+/gu, '');

/** The friend a name means: their @handle or their name, any case. */
export function friendNamed(name: string, friends: readonly InviteFriend[]): InviteFriend | undefined {
  const n = lower(name);
  return friends.find((f) => lower(handleOf(f.name)) === n) ?? friends.find((f) => lower(f.name) === n);
}

/** "ata", "ata and bo", "ata, bo and cy". */
export const namesLine = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** What `/invite <names>` should do here. */
export function inviteRoute(place: InvitePlace, names: readonly string[], friends: readonly InviteFriend[]): InviteRoute {
  if (!names.length) return { kind: 'add_friend' };
  const unknown = names.filter((n) => !friendNamed(n, friends));
  if (unknown.length) {
    const who = namesLine(unknown);
    return { kind: 'error', text: `${who} ${unknown.length === 1 ? 'isn’t' : 'aren’t'} your friend${unknown.length === 1 ? '' : 's'} yet. Type /invite on its own to send a friend link` };
  }
  const picked = [...new Map(names.map((n) => friendNamed(n, friends)!).map((f) => [f.peerId, f])).values()];
  switch (place.kind) {
    case 'group': {
      if (!place.active) return { kind: 'error', text: `You’re no longer in ${place.name}` };
      if (!place.admin) return { kind: 'error', text: `Only an admin of ${place.name} can add people` };
      const fresh = picked.filter((f) => !place.members.includes(f.peerId));
      if (!fresh.length) return { kind: 'error', text: `${namesLine(picked.map((f) => f.name))} ${picked.length === 1 ? 'is' : 'are'} already in ${place.name}` };
      return { kind: 'add_members', groupId: place.groupId, group: place.name, friends: fresh };
    }
    case 'dm': {
      const others = picked.filter((f) => f.peerId !== place.peerId);
      if (!others.length) return { kind: 'error', text: `You’re already talking with ${place.name}` };
      return { kind: 'new_channel', with: [{ peerId: place.peerId, name: place.name }, ...others] };
    }
    case 'workspace':
      return { kind: 'share', friends: picked, workspaceId: place.workspaceId, ...(place.projectId ? { projectId: place.projectId } : {}), where: place.name };
    case 'project':
      return { kind: 'share', friends: picked, projectId: place.projectId, where: place.name };
    case 'none':
      return { kind: 'error', text: `Open the chat, channel, project or worktree to add ${namesLine(picked.map((f) => f.name))} to, and type it there` };
  }
}

/** "New channel with you, ata and bo". */
export const newChannelLine = (people: readonly InviteFriend[]): string => `New channel with you, ${namesLine(people.map((p) => p.name))}`;
