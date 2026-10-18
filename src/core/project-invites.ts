import { randomUUID } from 'node:crypto';
import { type RoomKeys, deriveKeys, generateSecret } from '../net/crypto.js';
import type { GuestAccess, GuestGate } from '../net/hub.js';
import type { GuestCan, PeerInfo, WsRole } from '../protocol.js';
import type { Guest, Knock, ProjectLink } from './collab-store.js';
import type { People } from './people.js';
import type { TrustLevel } from './settings.js';
import { type AppState, type Store, peerName } from './store.js';
import type { WorkspaceSharing } from './workspace-sharing.js';

/** How the host's room lets guests in (implemented by the hub). */
export interface GuestControl {
  setGate(gate: GuestGate): void;
  setAccess(peerId: string, access: GuestAccess): void;
  /** Disconnect someone at the door (or a guest you removed). */
  turnAway(peerId: string): void;
}

export interface LinkOptions {
  /** A project id, or 'room' for everything. */
  readonly scope: string;
  readonly can: GuestCan;
  readonly knock: boolean;
  readonly singleUse: boolean;
  /** 0: never expires. */
  readonly expiresInMs: number;
}

export const DAY_MS = 24 * 60 * 60_000;
export const DEFAULT_LINK: Omit<LinkOptions, 'scope'> = { can: 'prompt', knock: true, singleUse: true, expiresInMs: DAY_MS };

export const CAN_INFO: Readonly<Record<GuestCan, { label: string; short: string; detail: string }>> = {
  watch: { label: 'Watch', short: 'can watch', detail: 'see the chat history and browse the files' },
  prompt: { label: 'Prompt', short: 'can prompt', detail: 'talk to your Claude there; edits and commands follow your approval rules' },
  edit: { label: 'Edit', short: 'can edit', detail: 'your Claude edits files in that folder without asking; commands still ask you' },
};

/** Watching is following along; prompting and editing are working there. */
export const roleFor = (can: GuestCan): WsRole => (can === 'watch' ? 'view' : 'contribute');

/** The trust level a guest gets for your Claude (editing inside their projects is allowed separately). */
export const trustFor = (can: GuestCan): TrustLevel => (can === 'watch' ? 'blocked' : can === 'edit' ? 'trusted' : 'ask');

/** Whether a new person may come in with this link right now. */
export function linkUsable(link: Pick<ProjectLink, 'singleUse' | 'used' | 'expiresAt'>, now: number): boolean {
  if (link.expiresAt !== undefined && now >= link.expiresAt) return false;
  return !(link.singleUse && link.used > 0);
}

/** The room's link with a project link's secret in place of the room's. */
export const withSecret = (roomInvite: string, secret: string): string => roomInvite.replace(/#[\w-]+$/, `#${secret}`);

/** "bob-api · can prompt", or "everything · can watch". */
export function guestSummary(guest: Guest, projectName: (id: string) => string): string {
  const where = guest.room ? 'everything' : guest.projects.map(projectName).join(', ') || 'nothing yet';
  return `${where} · ${CAN_INFO[guest.can].short}`;
}

/** "in 23h", "in 40 min", "expired". */
export function expiresIn(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return 'never expires';
  const left = expiresAt - now;
  if (left <= 0) return 'expired';
  return left >= 60 * 60_000 ? `expires in ${Math.round(left / (60 * 60_000))}h` : `expires in ${Math.max(1, Math.round(left / 60_000))} min`;
}

/** Everyone a guest shares a workspace with (they may see and message each other). */
export function contactsFor(peerId: string, members: AppState['members']): string[] {
  const out = new Set<string>();
  for (const people of Object.values(members)) if (people[peerId]) for (const id of Object.keys(people)) if (id !== peerId) out.add(id);
  return [...out];
}

/** Workspaces in a project a guest should be in (not archived, not someone else's checkout). */
export function projectWorkspaces(state: Pick<AppState, 'projects'>, projectId: string): string[] {
  return state.projects.find((p) => p.id === projectId)?.workspaces.filter((w) => !w.archived).map((w) => w.id) ?? [];
}

export interface ProjectInvitesDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly sharing: WorkspaceSharing;
  readonly people: People;
  readonly room?: GuestControl;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  readonly system: (text: string, level?: 'info' | 'warn' | 'error') => void;
  readonly copy: (text: string, success: string) => Promise<void>;
  /** Open remote access (klaud starts solo); the link is copied once it's ready. */
  readonly startInvite?: () => void;
  readonly now?: () => number;
}

/**
 * Links that let someone into one project (all its worktrees and chats) or the whole room.
 * They knock unless the link says otherwise, see only what they were invited to, and can be
 * given more (or less) any time without a new link. Only the host's klaud can make them.
 */
export class ProjectInvites {
  private readonly secrets = new Map<string, { secret: string; keys: RoomKeys }>();
  /** Keys of revoked links: only guests already let in may still reconnect with them. */
  private readonly revoked = new Map<string, RoomKeys>();
  /** Who came to the door with which link (until you decide). */
  private readonly arrivals = new Map<string, string>();
  private pendingCopy?: string;
  private lastProjects: AppState['projects'] = [];

  constructor(private readonly deps: ProjectInvitesDeps) {
    deps.room?.setGate({ keys: () => this.liveKeys(), admit: (id, peerId, closed) => this.admit(id, peerId, closed) });
    deps.sharing.onChange = () => this.syncContacts();
    deps.store.subscribe(() => this.onStore());
  }

  get available(): boolean {
    return Boolean(this.deps.room);
  }

  private get state(): AppState {
    return this.deps.store.getState();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private labelFor(scope: string): string {
    return scope === 'room' ? 'everything' : (this.state.projects.find((p) => p.id === scope)?.name ?? 'a project');
  }

  /** Make a link and copy it (opening remote access first if needed); `copy: false` only makes it (the demo). */
  async create(opts: LinkOptions, { copy = true } = {}): Promise<ProjectLink | undefined> {
    if (!this.deps.room) {
      this.deps.toast('Project links work in rooms you host. Start klaud yourself to invite people into a project', 'warn');
      return undefined;
    }
    const secret = generateSecret();
    const link: ProjectLink = {
      id: randomUUID().slice(0, 8),
      scope: opts.scope,
      label: this.labelFor(opts.scope),
      can: opts.can,
      knock: opts.knock,
      singleUse: opts.singleUse,
      ...(opts.expiresInMs > 0 ? { expiresAt: this.now() + opts.expiresInMs } : {}),
      createdAt: this.now(),
      used: 0,
    };
    this.secrets.set(link.id, { secret, keys: deriveKeys(secret) });
    this.deps.store.dispatch({ type: 'link_set', link });
    if (copy) await this.copyLink(link.id);
    return link;
  }

  /** The link to send, once remote access is up. */
  urlOf(id: string): string | undefined {
    const invite = this.state.invite;
    const secret = this.secrets.get(id)?.secret;
    return invite && secret ? withSecret(invite, secret) : undefined;
  }

  async copyLink(id: string): Promise<void> {
    const link = this.state.links.find((l) => l.id === id);
    const url = this.urlOf(id);
    if (!link) return;
    if (!url) {
      this.pendingCopy = id;
      this.deps.startInvite?.();
      this.deps.toast('Opening a secure link… it will be copied when ready');
      return;
    }
    await this.deps.copy(`klaud join ${url}`, `Link for ${link.label} copied (${CAN_INFO[link.can].short}${link.knock ? ', knocks first' : ''})`);
  }

  /** The link stops working; people already in keep their place until you remove them. */
  revoke(id: string): void {
    const link = this.state.links.find((l) => l.id === id);
    const old = this.secrets.get(id);
    if (old) this.revoked.set(id, old.keys);
    this.secrets.delete(id);
    this.deps.store.dispatch({ type: 'link_remove', id });
    for (const k of this.state.knocks.filter((x) => x.linkId === id)) this.decline(k.peerId, true);
    if (link) this.deps.toast(`The link for ${link.label} no longer works`, 'success');
  }

  private liveKeys(): Array<{ id: string; keys: RoomKeys }> {
    return [...[...this.secrets.entries()].map(([id, s]) => ({ id, keys: s.keys })), ...[...this.revoked.entries()].map(([id, keys]) => ({ id, keys }))];
  }

  /** The hub asks: may this person come in with link `id`? (Synchronous: single-use links are consumed here.) */
  admit(id: string, peerId: string, closed: boolean): (GuestAccess & { room?: string }) | undefined {
    const guest = this.state.guests[peerId];
    const host = this.state.self?.name ?? 'host';
    // Someone you already let in, reconnecting.
    if (guest) return { full: guest.room, contacts: contactsFor(peerId, this.state.members), room: `${host}'s ${guest.room ? 'room' : guest.projects.map((p) => this.labelFor(p)).join(', ')}` };
    const link = this.state.links.find((l) => l.id === id);
    if (!link || closed || peerId === this.deps.selfId()) return undefined;
    // Already at the door (a reconnect while you decide) doesn't use the link up again.
    if (this.arrivals.get(peerId) !== id) {
      if (!linkUsable(link, this.now())) return undefined;
      this.deps.store.dispatch({ type: 'link_set', link: { ...link, used: link.used + 1 } });
      this.arrivals.set(peerId, id);
    }
    return { full: false, contacts: [], room: `${host}'s ${link.label}` };
  }

  /** New people appeared: knock, or let them straight in when the link says so. */
  onPeers(peers: readonly PeerInfo[]): void {
    for (const p of peers) {
      const linkId = this.arrivals.get(p.peerId);
      if (!linkId || !p.guest || this.state.guests[p.peerId] || this.state.knocks.some((k) => k.peerId === p.peerId)) continue;
      const link = this.state.links.find((l) => l.id === linkId);
      if (!link) continue;
      if (!link.knock) this.letIn(p.peerId);
      else {
        const knock: Knock = { peerId: p.peerId, linkId, ts: this.now() };
        this.deps.store.dispatch({ type: 'knock', knock, show: true });
        this.deps.toast(`${p.name} is at the door of ${link.label}`);
      }
    }
  }

  /** Let someone at the door in, with what the link offered or less (`can`). */
  letIn(peerId: string, can?: GuestCan): void {
    const linkId = this.arrivals.get(peerId);
    const link = this.state.links.find((l) => l.id === linkId);
    const peer = this.state.peers.find((p) => p.peerId === peerId);
    this.deps.store.dispatch({ type: 'knock', knock: { peerId, linkId: linkId ?? '', ts: 0 }, show: false });
    if (!link || !peer) return;
    this.arrivals.delete(peerId);
    const guest: Guest = { peerId, name: peer.name, projects: link.scope === 'room' ? [] : [link.scope], room: link.scope === 'room', can: can ?? link.can };
    this.apply(guest);
    this.deps.toast(`${peer.name} is in ${guest.room ? 'the room' : link.label} (${CAN_INFO[guest.can].short})`, 'success');
  }

  decline(peerId: string, quiet = false): void {
    const name = peerName(this.state, peerId);
    this.arrivals.delete(peerId);
    this.deps.store.dispatch({ type: 'knock', knock: { peerId, linkId: '', ts: 0 }, show: false });
    this.deps.room?.turnAway(peerId);
    if (!quiet) this.deps.toast(`You turned ${name} away`, 'success');
  }

  /** Give a guest more (another project, or everything) or change what they can do. */
  change(peerId: string, patch: { addProject?: string; room?: boolean; can?: GuestCan }): void {
    const guest = this.state.guests[peerId];
    if (!guest) return;
    const next: Guest = {
      ...guest,
      projects: patch.addProject && !guest.projects.includes(patch.addProject) ? [...guest.projects, patch.addProject] : guest.projects,
      room: patch.room ?? guest.room,
      can: patch.can ?? guest.can,
    };
    this.apply(next);
    const what = patch.room ? 'everything: the room chat and what you share' : patch.addProject ? this.labelFor(patch.addProject) : CAN_INFO[next.can].short;
    this.deps.toast(`${guest.name}: ${what}`, 'success');
  }

  /** Take away everything you gave a guest and disconnect them. */
  remove(peerId: string): void {
    const guest = this.state.guests[peerId];
    if (!guest) return;
    for (const wsId of Object.keys(this.state.members)) this.deps.sharing.remove(wsId, peerId, true);
    this.deps.store.dispatch({ type: 'guest_set', peerId });
    // The trust that came with the link goes too: coming back by another link starts from your default.
    this.deps.people.forget(peerId);
    this.deps.room?.turnAway(peerId);
    this.deps.toast(`${guest.name} was removed`, 'success');
  }

  /** Is this person a guest who only sees what they were invited to? */
  isRestricted(peerId: string): boolean {
    const guest = this.state.guests[peerId];
    if (guest) return !guest.room;
    if (this.arrivals.has(peerId)) return true;
    return this.state.peers.find((p) => p.peerId === peerId)?.guest === true;
  }

  /** May this guest's Claude requests in `channel` edit and run commands without asking? */
  canEditIn(peerId: string, channel: string): boolean {
    const guest = this.state.guests[peerId];
    if (!guest || guest.can !== 'edit' || !channel.startsWith('ws:')) return false;
    const id = channel.slice(3);
    return guest.projects.some((p) => projectWorkspaces(this.state, p).includes(id));
  }

  private apply(guest: Guest): void {
    this.deps.store.dispatch({ type: 'guest_set', peerId: guest.peerId, guest });
    this.deps.people.setTrust(guest.peerId, trustFor(guest.can), true);
    this.deps.store.dispatch({ type: 'trust_prompt', peerId: guest.peerId, show: false });
    this.syncWorkspaces(guest);
    this.syncContacts();
  }

  /** Put a guest in every workspace of their projects (with the right role). */
  private syncWorkspaces(guest: Guest): void {
    const role = roleFor(guest.can);
    for (const projectId of guest.projects) {
      for (const wsId of projectWorkspaces(this.state, projectId)) {
        if (this.state.members[wsId]?.[guest.peerId] === role) continue;
        this.deps.sharing.invite(wsId, guest.peerId, role, { quiet: true, can: guest.can });
      }
    }
  }

  /** Tell the hub who each guest may reach: the people they share a workspace with. */
  syncContacts(): void {
    const room = this.deps.room;
    if (!room) return;
    for (const g of Object.values(this.state.guests)) room.setAccess(g.peerId, { full: g.room, contacts: contactsFor(g.peerId, this.state.members) });
  }

  private onStore(): void {
    const state = this.state;
    if (this.pendingCopy && state.invite) {
      const id = this.pendingCopy;
      this.pendingCopy = undefined;
      void this.copyLink(id);
    }
    // New worktrees and chats in a project: its guests are in them too.
    if (state.projects !== this.lastProjects) {
      this.lastProjects = state.projects;
      for (const id of Object.keys(state.guests)) {
        queueMicrotask(() => {
          const g = this.state.guests[id];
          if (g?.projects.length) this.syncWorkspaces(g);
        });
      }
    }
  }
}
