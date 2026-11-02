import path from 'node:path';
import { readJson, writeJson } from '../../net/mesh/files.js';

/**
 * Who's on a project's team, the same on every Mac (BLG-510). Teaming up is still done in pairs
 * (two friends with the repository say yes), but a team is the whole group those pairs join: a
 * friend of Ata's who teams up with Ata is on the team with you too, though you two aren't friends.
 * Each Mac passes on what it knows of the group over its own team links, the way the board does
 * (board-sync.ts), so everyone ends up with the same roster.
 *
 * Each member's line is last-writer-wins on `at`: "on" when they joined, "off" when they left the
 * whole team (Leave Team). A Mac is the only one who says it's on; one leaving is said by them, or
 * by a teammate they told. A teammate can claim anything about others (teammates are trusted friends).
 *
 * File: `team-roster.json` (each project's members as this Mac knows them).
 */

export interface Member {
  readonly peerId: string;
  readonly name: string;
  /** When they joined the team. */
  readonly since: number;
  /** false: they left the whole team. */
  readonly on: boolean;
  /** When this line was last true (the newer line wins). */
  readonly at: number;
}

export type Roster = Readonly<Record<string, Member>>;

/** Whether `x` wins over `y`: the newer line, and on a tie, leaving. */
export const newerMember = (x: Member, y: Member | undefined): boolean => !y || x.at > y.at || (x.at === y.at && !x.on && y.on);

/** Take in a teammate's lines (never one about me: I say whether I'm on). → the roster, and the lines that won. */
export function mergeRoster(mine: Roster, theirs: readonly Member[], self: string): { readonly roster: Roster; readonly won: readonly Member[] } {
  const next: Record<string, Member> = { ...mine };
  const won: Member[] = [];
  for (const m of theirs) {
    if (m.peerId === self || !newerMember(m, next[m.peerId])) continue;
    // A name only travels with a line that's newer: keep the one we had if theirs is blank.
    next[m.peerId] = { ...m, name: m.name || next[m.peerId]?.name || 'Teammate' };
    won.push(next[m.peerId]!);
  }
  return { roster: next, won };
}

export class TeamRosters {
  private rosters: Record<string, Roster> = {};

  constructor(private readonly dir: string | null) {
    this.load();
  }

  of(projectId: string): Roster {
    return this.rosters[projectId] ?? {};
  }

  /** Members on the team now (not me), oldest first. */
  members(projectId: string, self: string): Member[] {
    return Object.values(this.of(projectId))
      .filter((m) => m.on && m.peerId !== self)
      .sort((a, b) => a.since - b.since);
  }

  /** Set one line here (mine, or what I saw myself: a link forming, a teammate saying they left). → whether it changed. */
  put(projectId: string, m: Member): boolean {
    const had = this.of(projectId)[m.peerId];
    if (had && had.on === m.on && had.name === m.name) return false;
    if (had && !newerMember(m, had)) return false;
    this.rosters = { ...this.rosters, [projectId]: { ...this.of(projectId), [m.peerId]: m } };
    this.save();
    return true;
  }

  merge(projectId: string, theirs: readonly Member[], self: string): readonly Member[] {
    const { roster, won } = mergeRoster(this.of(projectId), theirs, self);
    if (won.length) {
      this.rosters = { ...this.rosters, [projectId]: roster };
      this.save();
    }
    return won;
  }

  /** Not on that team any more: forget who was. */
  forget(projectId: string): void {
    if (!this.rosters[projectId]) return;
    const { [projectId]: _gone, ...rest } = this.rosters;
    this.rosters = rest;
    this.save();
  }

  private load(): void {
    if (!this.dir) return;
    const saved = readJson(path.join(this.dir, 'team-roster.json')) as { rosters?: unknown } | undefined;
    if (!saved?.rosters || typeof saved.rosters !== 'object') return;
    for (const [projectId, list] of Object.entries(saved.rosters as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const ok = (list as Member[]).filter((m) => m && typeof m.peerId === 'string' && typeof m.name === 'string' && typeof m.at === 'number' && typeof m.on === 'boolean');
      this.rosters[projectId] = Object.fromEntries(ok.map((m) => [m.peerId, { ...m, since: typeof m.since === 'number' ? m.since : m.at }]));
    }
  }

  private save(): void {
    if (!this.dir) return;
    try {
      writeJson(path.join(this.dir, 'team-roster.json'), { rosters: Object.fromEntries(Object.entries(this.rosters).map(([p, r]) => [p, Object.values(r)])) });
    } catch {
      // Best effort: it's in memory, and written again on the next change.
    }
  }
}
