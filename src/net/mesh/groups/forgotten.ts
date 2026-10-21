import { z } from 'zod';
import { readJson, writeJson } from '../files.js';

/**
 * Channels you deleted from this Mac, kept in ~/.klaud/groups/forgotten.json, so a member who
 * still has the channel doesn't hand it back to you on the next catch-up. Each one remembers the
 * entry that took you out: the channel comes back only from a copy that knows you left and has
 * you in it again (someone added you back). Asking to join again forgets the deletion.
 */

const MAX_FORGOTTEN = 1000;

const Forgot = z.object({ groupId: z.string(), removal: z.string(), at: z.number() });
export type Forgot = z.infer<typeof Forgot>;
const ForgottenFile = z.object({ forgotten: z.array(Forgot) });

export class Forgotten {
  private list: readonly Forgot[];

  constructor(private readonly file: string) {
    const parsed = ForgottenFile.safeParse(readJson(file));
    this.list = parsed.success ? parsed.data.forgotten : [];
  }

  get = (groupId: string): Forgot | undefined => this.list.find((f) => f.groupId === groupId);

  add(entry: Forgot): void {
    const others = this.list.filter((f) => f.groupId !== entry.groupId);
    this.save([...others, entry].slice(-MAX_FORGOTTEN));
  }

  drop(groupId: string): void {
    if (this.get(groupId)) this.save(this.list.filter((f) => f.groupId !== groupId));
  }

  private save(list: readonly Forgot[]): void {
    this.list = list;
    writeJson(this.file, { forgotten: list });
  }
}
