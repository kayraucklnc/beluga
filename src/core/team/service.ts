import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { type BelugaInfo, type Feature, TEAM_FEATURES, cannotTake } from '../../net/mesh/features.js';
import { readJson, writeJson } from '../../net/mesh/files.js';
import type { GitHubRepo } from '../../workspaces/github.js';
import { Courier } from '../friend-share/courier.js';
import type { NoticeEvent } from '../notify.js';
import type { Action, Store } from '../store.js';
import { fingerprint, pairKey, repoKey, repoLabel } from './fingerprint.js';
import type { ProjectTeam, TeamOffer, TeamState } from './model.js';
import { type TeamMsg, parseTeamFrame } from './protocol.js';

/**
 * Team boards (docs/tasks-and-plans.md, "Sharing with friends — phase 3"). Friends who each have
 * the same GitHub repository as a project on their own Mac can work on it as a team without
 * sharing the project: once both said yes, the two projects keep one board between them (tasks,
 * briefs, status, comments, who's on which issue), and plan drafts can be shared for review.
 * Chats and worktrees never travel (a conversation can be shared on purpose: friend-share).
 *
 * This part finds teammates and keeps who's in a team (BLG-221):
 * - On every link to a friend, each side sends fingerprints of its GitHub projects keyed for that
 *   pair (fingerprint.ts). A match is an offer on both Macs ("Ata also works on acme/api").
 * - Saying yes sends an invite; the team forms only when both said yes (an `accept`, or two
 *   invites crossing, which settle on the smaller link id). Either can leave; Not Now hides the
 *   offer until they ask.
 * - A team is the set of pairwise links for one project: three friends on one repo are three
 *   links, and changes reach everyone (board-sync.ts passes on what it hasn't seen).
 *
 * Files: `teams.json` (links and offers), `team-outbox.json` (what waits for a teammate's Mac).
 */

/** What the service needs from the mesh node (net/mesh/mesh.ts). */
export interface TeamMesh {
  readonly peerId: string;
  isFriend(peerId: string): boolean;
  isLinked(peerId: string): boolean;
  nameFor(peerId: string): string;
  belugaOf(peerId: string): BelugaInfo | undefined;
  sendTeam(peerId: string, payload: unknown): boolean;
  /** Mail what still waits before this Mac leaves the network. */
  onLeaving?(fn: () => Promise<unknown>): () => void;
  /** Leave a frame in their mailbox (BLG-272; none: no mailbox). */
  mail?(peerId: string, t: 'team', payload: unknown): Promise<boolean>;
  /** How long a frame waits for their link before it's mailed (undefined: no mailbox). */
  readonly mailAfterMs?: number | undefined;
  offer(features: readonly Feature[], on: boolean): void;
  on(event: 'team', fn: (from: string, payload: unknown) => void): unknown;
  on(event: 'link', fn: (peerId: string) => void): unknown;
  off(event: 'team', fn: (from: string, payload: unknown) => void): unknown;
  off(event: 'link', fn: (peerId: string) => void): unknown;
}

export interface TeamDeps {
  readonly store: Store;
  readonly mesh: TeamMesh;
  /** Where its files live (normally ~/.beluga); null: memory only (tests). */
  readonly dir: string | null;
  /** A project's GitHub repository, from its origin remote. */
  readonly repoOf: (projectId: string) => Promise<GitHubRepo | undefined>;
  readonly notify?: (e: NoticeEvent) => void;
  readonly toast?: (text: string, level: 'info' | 'success' | 'warn' | 'error') => void;
  readonly now?: () => number;
}

/** One pair of teammates on one project: the id both Macs use for it. */
export interface TeamLink {
  readonly id: string;
  readonly peerId: string;
  readonly projectId: string;
  /** Their project's name on their Mac (their Claude's requests name it). */
  readonly theirProject: string;
  readonly since: number;
}

interface OfferRec {
  readonly peerId: string;
  readonly projectId: string;
  readonly state: TeamOffer['state'];
  readonly at: number;
  /** Asked (yours) or invited (theirs): the link id it would become. */
  readonly link?: string;
  readonly theirProject?: string;
  /** Not now: hidden until they ask. */
  readonly dismissed?: boolean;
}

/** What other parts of team boards add to the state, and hear about links (board-sync.ts, plan-share.ts). */
export interface TeamPart {
  /** A link formed (or was there at start): catch up with that teammate. */
  joined?(link: TeamLink, fresh: boolean): void;
  /** A link went (someone left). */
  left?(link: TeamLink): void;
  /** A teammate's Mac came online. */
  linkUp?(peerId: string): void;
  /** A message this part handles; true when it took it. */
  receive?(from: string, m: TeamMsg): boolean;
  /** Its share of the state screens see. */
  view?(): Partial<TeamState>;
  onAction?(action: Action): void;
  stop?(): void;
}

const REPOS_GAP_MS = 5_000;
const keyOf = (peerId: string, projectId: string): string => `${peerId}|${projectId}`;
const newLink = (): string => `tl_${randomBytes(9).toString('base64url')}`;

export class TeamBoards {
  readonly courier: Courier<TeamMsg>;
  private links: Record<string, TeamLink> = {};
  private offers: Record<string, OfferRec> = {};
  /** Project id → its repository (key and label), as its remote says. */
  private repos = new Map<string, { readonly key: string; readonly label: string }>();
  /** What each friend's Mac sent: fingerprints of its repositories (for the two of you). */
  private readonly theirs = new Map<string, Set<string>>();
  private readonly reposSent = new Map<string, number>();
  private readonly parts: TeamPart[] = [];
  private readonly offs: Array<() => void> = [];
  private reposTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  readonly now: () => number;

  constructor(readonly deps: TeamDeps) {
    this.now = deps.now ?? Date.now;
    const { mesh } = deps;
    this.courier = new Courier<TeamMsg>(
      { isLinked: (p) => mesh.isLinked(p), send: (p, payload) => mesh.sendTeam(p, payload), parse: parseTeamFrame, mail: (p, payload) => mesh.mail?.(p, 'team', payload) ?? Promise.resolve(false), mailAfterMs: () => mesh.mailAfterMs },
      deps.dir ? path.join(deps.dir, 'team-outbox.json') : undefined,
      // Who has which change shows on the tasks (BLG-273).
      () => this.publish(),
    );
    this.courier.onMailed = () => this.publish();
  }

  get self(): string {
    return this.deps.mesh.peerId;
  }

  /** Add a part (before start). */
  use(part: TeamPart): void {
    this.parts.push(part);
  }

  /** The part of a kind (TeamAssign, TeamPlans…), for the API. */
  part<T extends TeamPart>(kind: abstract new (...args: never[]) => T): T {
    const found = this.parts.find((p): p is T => p instanceof kind);
    if (!found) throw new Error('That part of team boards isn’t running');
    return found;
  }

  async start(): Promise<void> {
    this.load();
    const { mesh, store } = this.deps;
    const onTeam = (from: string, payload: unknown): void => this.onFrame(from, payload);
    const onLink = (peerId: string): void => this.linkUp(peerId);
    mesh.on('team', onTeam);
    mesh.on('link', onLink);
    this.offs.push(() => {
      mesh.off('team', onTeam);
      mesh.off('link', onLink);
    });
    this.offs.push(store.onAction((action) => this.onAction(action)));
    mesh.offer(TEAM_FEATURES, true);
    this.offs.push(() => mesh.offer(TEAM_FEATURES, false));
    if (mesh.onLeaving) this.offs.push(mesh.onLeaving(() => this.courier.mailAll()));
    this.courier.start();
    for (const link of Object.values(this.links)) for (const p of this.parts) p.joined?.(link, false);
    this.publish();
    await this.refreshRepos();
    for (const peer of this.linkedFriends()) this.sendRepos(peer, true);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reposTimer);
    this.courier.stop();
    for (const off of this.offs.splice(0)) off();
    for (const p of this.parts) p.stop?.();
    this.deps.store.dispatch({ type: 'team_off' });
  }

  // ------------------------------------------------------------------ reading

  /** Every link (pair of teammates on a project). */
  allLinks(): readonly TeamLink[] {
    return Object.values(this.links).filter((l) => this.deps.mesh.isFriend(l.peerId));
  }

  linkById(id: string): TeamLink | undefined {
    const link = this.links[id];
    return link && this.deps.mesh.isFriend(link.peerId) ? link : undefined;
  }

  /** The links of one project. */
  linksOf(projectId: string): readonly TeamLink[] {
    return this.allLinks().filter((l) => l.projectId === projectId);
  }

  /** Whether a project is worked on as a team. */
  teamed(projectId: string): boolean {
    return this.linksOf(projectId).length > 0;
  }

  nameOf(peerId: string): string {
    return this.deps.mesh.nameFor(peerId);
  }

  /** Why a teammate's Beluga can't take this (said the cannotTake way), or undefined. */
  cannot(peerId: string, feature: Feature): string | undefined {
    const { mesh } = this.deps;
    return cannotTake(mesh.nameFor(peerId), mesh.belugaOf(peerId), feature, mesh.isLinked(peerId));
  }

  /** A message for a teammate that must arrive (it waits for their Mac). */
  send(to: string, m: TeamMsg, key?: string): void {
    this.courier.send(to, m, { reliable: true, ...(key ? { key } : {}) });
  }

  // ------------------------------------------------------------------ teaming up

  /** Team Up (yes) or Not Now (no) on an offer. */
  answer(peerId: string, projectId: string, yes: boolean): void {
    const rec = this.offers[keyOf(peerId, projectId)];
    const repo = this.repos.get(projectId);
    if (!rec || !repo) throw new Error('That offer isn’t here any more');
    const print = this.printFor(peerId, projectId);
    if (!yes) {
      // Not now to their invite, or taking yours back: they hear it either way.
      if (rec.state === 'invited' || rec.state === 'asked') this.send(peerId, { k: 'decline', print });
      this.offers = { ...this.offers, [keyOf(peerId, projectId)]: { ...rec, state: 'found', dismissed: true, link: undefined } };
      this.save();
      this.publish();
      return;
    }
    const { mesh } = this.deps;
    if (!mesh.isFriend(peerId)) throw new Error('Add them as a friend first');
    const why = this.cannot(peerId, 'team.board');
    if (why) throw new Error(why);
    const project = this.projectName(projectId);
    if (rec.state === 'invited' && rec.link) {
      this.send(peerId, { k: 'accept', print, link: rec.link, project });
      this.join(peerId, projectId, rec.link, rec.theirProject ?? '');
      return;
    }
    const link = rec.state === 'asked' && rec.link ? rec.link : newLink();
    this.offers = { ...this.offers, [keyOf(peerId, projectId)]: { ...rec, state: 'asked', link, at: this.now(), dismissed: false } };
    this.save();
    this.publish();
    this.send(peerId, { k: 'invite', print, link, project });
    this.deps.toast?.(`Asked ${mesh.nameFor(peerId)} to team up on ${repo.label}`, 'success');
  }

  /** Leave a project's team (one teammate, or all of them). Your tasks stay on your board. */
  leave(projectId: string, peerId?: string): void {
    const gone = this.linksOf(projectId).filter((l) => !peerId || l.peerId === peerId);
    if (!gone.length) return;
    for (const link of gone) {
      this.send(link.peerId, { k: 'leave', link: link.id });
      this.drop(link);
    }
    const repo = this.repos.get(projectId)?.label ?? this.projectName(projectId);
    this.deps.toast?.(gone.length === 1 ? `You left the team with ${this.nameOf(gone[0]!.peerId)} on ${repo}` : `You left the team on ${repo}`, 'success');
  }

  private join(peerId: string, projectId: string, id: string, theirProject: string): void {
    const already = Object.values(this.links).find((l) => l.peerId === peerId && l.projectId === projectId);
    if (already) return;
    const link: TeamLink = { id, peerId, projectId, theirProject: theirProject.slice(0, 200), since: this.now() };
    this.links = { ...this.links, [id]: link };
    const { [keyOf(peerId, projectId)]: _done, ...rest } = this.offers;
    this.offers = rest;
    this.save();
    const repo = this.repos.get(projectId)?.label ?? this.projectName(projectId);
    this.deps.notify?.({ kind: 'people', tag: 'joined', title: `You and ${this.nameOf(peerId)} are a team on ${repo}`, body: 'Your tasks for it stay in step from now on. Chats stay on your own Mac.', key: `team:${id}` });
    for (const p of this.parts) p.joined?.(link, true);
    this.publish();
  }

  private drop(link: TeamLink): void {
    const { [link.id]: _gone, ...rest } = this.links;
    this.links = rest;
    // Not offered again by itself: it waits until either of you asks.
    this.offers = { ...this.offers, [keyOf(link.peerId, link.projectId)]: { peerId: link.peerId, projectId: link.projectId, state: 'found', at: this.now(), dismissed: true } };
    this.save();
    for (const p of this.parts) p.left?.(link);
    this.publish();
  }

  // ------------------------------------------------------------------ the link

  private linkedFriends(): string[] {
    const { mesh, store } = this.deps;
    return store
      .getState()
      .network.friends.map((f) => f.peerId)
      .filter((p) => mesh.isFriend(p) && mesh.isLinked(p));
  }

  private linkUp(peerId: string): void {
    if (!this.deps.mesh.isFriend(peerId)) return;
    this.sendRepos(peerId, true);
    this.courier.flush(peerId, true);
    for (const p of this.parts) p.linkUp?.(peerId);
  }

  /** My repositories' fingerprints for this friend (only friends; nothing for Macs that aren't). */
  private sendRepos(peerId: string, force = false): void {
    const last = this.reposSent.get(peerId) ?? 0;
    if (!force && this.now() - last < REPOS_GAP_MS) return;
    const key = pairKey(this.self, peerId);
    const prints = [...new Set([...this.repos.values()].map((r) => fingerprint(key, r.key)))].slice(0, 500);
    if (this.deps.mesh.isLinked(peerId) && this.courier.send(peerId, { k: 'repos', prints }, { reliable: false })) this.reposSent.set(peerId, this.now());
  }

  private printFor(peerId: string, projectId: string): string {
    const repo = this.repos.get(projectId);
    if (!repo) throw new Error('That project isn’t on GitHub');
    return fingerprint(pairKey(this.self, peerId), repo.key);
  }

  /** My project whose repository has this fingerprint for this friend (one not teamed with them first). */
  private projectForPrint(peerId: string, print: string): string | undefined {
    const key = pairKey(this.self, peerId);
    const hits = [...this.repos.entries()].filter(([, r]) => fingerprint(key, r.key) === print).map(([id]) => id);
    return hits.find((id) => !this.linksOf(id).some((l) => l.peerId === peerId)) ?? hits[0];
  }

  private onFrame(from: string, payload: unknown): void {
    if (this.stopped || !this.deps.mesh.isFriend(from)) return;
    const got = this.courier.receive(from, payload);
    if (!got) return;
    const { m } = got;
    switch (m.k) {
      case 'repos':
        return this.onRepos(from, m.prints);
      case 'invite':
        return this.onInvite(from, m.print, m.link, m.project);
      case 'accept':
        return this.onAccept(from, m.print, m.link, m.project);
      case 'decline':
        return this.onDecline(from, m.print);
      case 'leave': {
        const link = this.links[m.link];
        if (!link || link.peerId !== from) return;
        this.drop(link);
        this.deps.toast?.(`${this.nameOf(from)} left the team on ${this.repos.get(link.projectId)?.label ?? this.projectName(link.projectId)}`, 'info');
        return;
      }
      default:
        for (const p of this.parts) if (p.receive?.(from, m)) return;
    }
  }

  private onRepos(from: string, prints: readonly string[]): void {
    this.theirs.set(from, new Set(prints));
    // They may not have mine yet (their link came up first): say it back, not too often.
    this.sendRepos(from);
    this.findOffers();
  }

  /** Friends with one of my repositories that we aren't a team on yet: an offer each (once). */
  private findOffers(): void {
    let changed = false;
    for (const [peerId, prints] of this.theirs) {
      if (!this.deps.mesh.isFriend(peerId)) continue;
      const key = pairKey(this.self, peerId);
      for (const [projectId, repo] of this.repos) {
        if (!prints.has(fingerprint(key, repo.key))) continue;
        if (this.linksOf(projectId).some((l) => l.peerId === peerId)) continue;
        if (this.offers[keyOf(peerId, projectId)]) continue;
        this.offers = { ...this.offers, [keyOf(peerId, projectId)]: { peerId, projectId, state: 'found', at: this.now() } };
        changed = true;
        this.deps.notify?.({ kind: 'people', tag: 'invited', title: `${this.nameOf(peerId)} also works on ${repo.label}`, body: 'Team up to keep your tasks for it in step. Nothing is shared until you both say yes.', need: `team:${peerId}:${projectId}`, key: `team-offer:${peerId}:${projectId}` });
      }
    }
    if (changed) {
      this.save();
      this.publish();
    }
  }

  private onInvite(from: string, print: string, link: string, theirProject: string): void {
    const projectId = this.projectForPrint(from, print);
    if (!projectId) return;
    const joined = this.linksOf(projectId).find((l) => l.peerId === from);
    if (joined) {
      // Already a team (an accept of ours got lost): say it again.
      this.send(from, { k: 'accept', print, link: joined.id, project: this.projectName(projectId) });
      return;
    }
    const rec = this.offers[keyOf(from, projectId)];
    if (rec?.state === 'asked' && rec.link) {
      // Both said yes at once: the smaller id is the team's.
      const id = rec.link < link ? rec.link : link;
      this.send(from, { k: 'accept', print, link: id, project: this.projectName(projectId) });
      this.join(from, projectId, id, theirProject);
      return;
    }
    this.offers = { ...this.offers, [keyOf(from, projectId)]: { peerId: from, projectId, state: 'invited', at: this.now(), link, theirProject: theirProject.slice(0, 200) } };
    this.save();
    this.publish();
    const repo = this.repos.get(projectId)?.label ?? this.projectName(projectId);
    this.deps.notify?.({ kind: 'needsYou', tag: 'invited', title: `${this.nameOf(from)} wants to team up on ${repo}`, body: 'Your tasks for it would stay in step. Chats stay on your own Mac.', need: `team:${from}:${projectId}`, key: `team-invite:${link}` });
  }

  private onAccept(from: string, print: string, link: string, theirProject: string): void {
    const projectId = this.projectForPrint(from, print);
    if (!projectId) return;
    if (this.linksOf(projectId).some((l) => l.peerId === from)) return;
    const rec = this.offers[keyOf(from, projectId)];
    if (rec?.state !== 'asked') {
      // We'd left (or never asked): they hear so.
      this.send(from, { k: 'leave', link });
      return;
    }
    this.join(from, projectId, link, theirProject);
  }

  private onDecline(from: string, print: string): void {
    const projectId = this.projectForPrint(from, print);
    if (!projectId) return;
    const rec = this.offers[keyOf(from, projectId)];
    if (rec?.state === 'invited') {
      // They took their invite back: it's a plain offer again.
      this.offers = { ...this.offers, [keyOf(from, projectId)]: { ...rec, state: 'found', link: undefined } };
      this.save();
      this.publish();
      return;
    }
    if (rec?.state !== 'asked') return;
    this.offers = { ...this.offers, [keyOf(from, projectId)]: { ...rec, state: 'found', link: undefined, dismissed: true } };
    this.save();
    this.publish();
    this.deps.toast?.(`${this.nameOf(from)} said not now to teaming up on ${this.repos.get(projectId)?.label ?? this.projectName(projectId)}`, 'info');
  }

  // ------------------------------------------------------------------ projects and their repositories

  private projectName(projectId: string): string {
    return this.deps.store.getState().projects.find((p) => p.id === projectId)?.name ?? projectId;
  }

  /** Which projects are on GitHub, and where (asked again when projects change). */
  async refreshRepos(): Promise<void> {
    const projects = this.deps.store.getState().projects.filter((p) => p.root);
    const next = new Map<string, { key: string; label: string }>();
    for (const p of projects) {
      const repo = await this.deps.repoOf(p.id).catch(() => undefined);
      if (repo) next.set(p.id, { key: repoKey(repo), label: repoLabel(repo) });
    }
    if (this.stopped) return;
    const same = next.size === this.repos.size && [...next].every(([id, r]) => this.repos.get(id)?.key === r.key);
    this.repos = next;
    if (same) return;
    for (const peer of this.linkedFriends()) this.sendRepos(peer, true);
    this.findOffers();
    this.publish();
  }

  private onAction(action: Action): void {
    if (action.type === 'projects') {
      clearTimeout(this.reposTimer);
      this.reposTimer = setTimeout(() => void this.refreshRepos(), 500);
      this.reposTimer.unref?.();
    }
    if (action.type === 'net_summary') this.publish();
    for (const p of this.parts) p.onAction?.(action);
  }

  // ------------------------------------------------------------------ state and files

  /** Tell every screen (and the phone) what's what now. */
  publish(): void {
    if (this.stopped) return;
    const { mesh } = this.deps;
    const projects = new Set(this.deps.store.getState().projects.map((p) => p.id));
    const offers: TeamOffer[] = Object.values(this.offers)
      .filter((o) => !o.dismissed && projects.has(o.projectId) && mesh.isFriend(o.peerId) && this.repos.has(o.projectId))
      .map((o) => ({ peerId: o.peerId, name: mesh.nameFor(o.peerId), projectId: o.projectId, repo: this.repos.get(o.projectId)!.label, state: o.state, at: o.at }));
    const teams: Record<string, ProjectTeam> = {};
    for (const link of this.allLinks()) {
      const t = teams[link.projectId] ?? { projectId: link.projectId, repo: this.repos.get(link.projectId)?.label ?? this.projectName(link.projectId), mates: [] };
      teams[link.projectId] = { ...t, mates: [...t.mates, { peerId: link.peerId, name: mesh.nameFor(link.peerId), since: link.since }] };
    }
    let state: TeamState = { enabled: true, offers, teams, working: {}, waiting: {}, assigned: [], plans: [], planShares: {} };
    for (const p of this.parts) state = { ...state, ...p.view?.() };
    const before = this.deps.store.getState().team;
    if (JSON.stringify(before) !== JSON.stringify(state)) this.deps.store.dispatch({ type: 'team_state', state });
  }

  private load(): void {
    if (!this.deps.dir) return;
    const saved = readJson(path.join(this.deps.dir, 'teams.json')) as { links?: unknown; offers?: unknown } | undefined;
    if (!saved || typeof saved !== 'object') return;
    const links = Array.isArray(saved.links) ? (saved.links as TeamLink[]).filter((l) => l && typeof l.id === 'string' && typeof l.peerId === 'string' && typeof l.projectId === 'string') : [];
    this.links = Object.fromEntries(links.map((l) => [l.id, { ...l, theirProject: typeof l.theirProject === 'string' ? l.theirProject : '' }]));
    const offers = Array.isArray(saved.offers) ? (saved.offers as OfferRec[]).filter((o) => o && typeof o.peerId === 'string' && typeof o.projectId === 'string') : [];
    this.offers = Object.fromEntries(offers.map((o) => [keyOf(o.peerId, o.projectId), o]));
  }

  private save(): void {
    if (!this.deps.dir) return;
    try {
      writeJson(path.join(this.deps.dir, 'teams.json'), { links: Object.values(this.links), offers: Object.values(this.offers) });
    } catch {
      // Best effort: it's in memory, and written again on the next change.
    }
  }
}
