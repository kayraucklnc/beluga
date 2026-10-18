import { z } from 'zod';
import { readJson, writeJson } from './files.js';
import { type Card, verifyCard } from './keys.js';
import { CardSchema, NameSchema } from './schemas.js';

/** Your friends on the klaud network, kept in ~/.klaud/friends.json (readable only by you). */

export const FriendRecord = z.object({
  peerId: z.string(),
  /** Their identity key (as on their card). */
  publicKey: z.string(),
  name: NameSchema,
  addedAt: z.number(),
  card: CardSchema,
});
export type FriendRecord = z.infer<typeof FriendRecord>;

const FriendsFile = z.object({ version: z.literal(1), friends: z.array(z.unknown()) });

export class FriendBook {
  private list: readonly FriendRecord[];

  constructor(private readonly file: string) {
    const parsed = FriendsFile.safeParse(readJson(file));
    this.list = (parsed.success ? parsed.data.friends : []).flatMap((raw) => {
      const f = FriendRecord.safeParse(raw);
      // A friend whose card doesn't check out (edited by hand?) is dropped rather than trusted.
      return f.success && verifyCard(f.data.card) && f.data.card.peerId === f.data.peerId ? [f.data] : [];
    });
  }

  all = (): readonly FriendRecord[] => this.list;
  get = (peerId: string): FriendRecord | undefined => this.list.find((f) => f.peerId === peerId);
  has = (peerId: string): boolean => this.list.some((f) => f.peerId === peerId);

  /** Add someone (or refresh their card and name if they're already a friend). */
  add(card: Card, name: string): FriendRecord {
    if (!verifyCard(card)) throw new Error("That person's keys don't check out");
    const existing = this.get(card.peerId);
    const record: FriendRecord = { peerId: card.peerId, publicKey: card.publicKey, name, addedAt: existing?.addedAt ?? Date.now(), card };
    this.save(existing ? this.list.map((f) => (f.peerId === card.peerId ? record : f)) : [...this.list, record]);
    return record;
  }

  remove(peerId: string): boolean {
    if (!this.has(peerId)) return false;
    this.save(this.list.filter((f) => f.peerId !== peerId));
    return true;
  }

  private save(next: readonly FriendRecord[]): void {
    this.list = next;
    writeJson(this.file, { version: 1, friends: next });
  }
}
