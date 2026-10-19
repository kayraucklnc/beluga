import { z } from 'zod';
import { readJson, writeJson } from '../files.js';
import { ProfileSchema } from '../schemas.js';

/**
 * Joining by link, both sides, kept in ~/.klaud/groups/joins.json:
 * - asked: groups you asked to join (and the admin who has your request), until you're in;
 * - requests: people waiting for you, an admin, to let them into one of your groups.
 */

export const JOIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REQUESTS = 200;

const Asked = z.object({ groupId: z.string(), name: z.string(), inviter: ProfileSchema, since: z.number() });
export type Asked = z.infer<typeof Asked>;
const Request = z.object({ groupId: z.string(), profile: ProfileSchema, ts: z.number() });
export type JoinRequest = z.infer<typeof Request>;
const JoinsFile = z.object({ asked: z.array(Asked), requests: z.array(Request) });

export class Joins {
  private asked: readonly Asked[];
  private requests: readonly JoinRequest[];

  constructor(private readonly file: string) {
    const parsed = JoinsFile.safeParse(readJson(file));
    const fresh = (ts: number): boolean => ts + JOIN_TTL_MS > Date.now();
    this.asked = parsed.success ? parsed.data.asked.filter((a) => fresh(a.since)) : [];
    this.requests = parsed.success ? parsed.data.requests.filter((r) => fresh(r.ts)) : [];
  }

  allAsked = (): readonly Asked[] => this.asked;
  askedFor = (groupId: string): Asked | undefined => this.asked.find((a) => a.groupId === groupId);
  requestsFor = (groupId: string): readonly JoinRequest[] => this.requests.filter((r) => r.groupId === groupId);

  ask(entry: Asked): void {
    this.save([...this.asked.filter((a) => a.groupId !== entry.groupId), entry], this.requests);
  }

  joined(groupId: string): void {
    if (this.askedFor(groupId)) this.save(this.asked.filter((a) => a.groupId !== groupId), this.requests);
  }

  request(r: JoinRequest): void {
    const others = this.requests.filter((x) => !(x.groupId === r.groupId && x.profile.card.peerId === r.profile.card.peerId));
    if (others.length >= MAX_REQUESTS) throw new Error('Too many people are waiting to join');
    this.save(this.asked, [...others, r]);
  }

  /** Take someone's request off the list (let in or turned away). */
  settle(groupId: string, peerId: string): JoinRequest | undefined {
    const found = this.requests.find((r) => r.groupId === groupId && r.profile.card.peerId === peerId);
    if (found) this.save(this.asked, this.requests.filter((r) => r !== found));
    return found;
  }

  private save(asked: readonly Asked[], requests: readonly JoinRequest[]): void {
    this.asked = asked;
    this.requests = requests;
    writeJson(this.file, { asked, requests });
  }
}
