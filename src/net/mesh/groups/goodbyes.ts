import { z } from 'zod';
import { canonical, readJson, writeJson } from '../files.js';
import { type Entry, type Profile, ProfileSchema } from '../schemas.js';

/**
 * Leaving a group when none of its members was online: nobody heard you go. The entry that
 * says so waits here (~/.beluga/groups/goodbyes.json), with the last few entries before it in
 * case they missed those, and the people to say it to. The first one of them you're linked
 * with gets it and passes it on to the rest, like anything new in a group. Kept even if you
 * delete the group from this Mac.
 */

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_GOODBYES = 100;
/** Entries kept with the goodbye (the removal and what came just before it), and their size. */
const MAX_ENTRIES = 30;
const MAX_BYTES = 256 * 1024;
const MAX_PEOPLE = 64;

const Goodbye = z.object({ groupId: z.string(), entries: z.array(z.unknown()).min(1), to: z.array(ProfileSchema), since: z.number() });
export type Goodbye = Omit<z.infer<typeof Goodbye>, 'entries'> & { readonly entries: readonly unknown[] };

/** The removal last, and as many entries before it as fit. */
export function goodbyeEntries(ordered: readonly Entry[], removal: Entry): Entry[] {
  const before = ordered.filter((e) => e.id !== removal.id).slice(-(MAX_ENTRIES - 1));
  let bytes = canonical(removal).length;
  const kept: Entry[] = [];
  for (const e of [...before].reverse()) {
    bytes += canonical(e).length;
    if (bytes > MAX_BYTES) break;
    kept.unshift(e);
  }
  return [...kept, removal];
}

export class Goodbyes {
  private list: readonly Goodbye[];

  constructor(private readonly file: string) {
    const parsed = z.array(Goodbye).safeParse(readJson(file));
    this.list = parsed.success ? parsed.data.filter((g) => g.since + TTL_MS > Date.now()) : [];
  }

  all = (): readonly Goodbye[] => this.list;

  add(groupId: string, entries: readonly Entry[], to: readonly Profile[]): void {
    if (!to.length) return;
    const goodbye: Goodbye = { groupId, entries, to: to.slice(0, MAX_PEOPLE), since: Date.now() };
    this.save([...this.list.filter((g) => g.groupId !== groupId), goodbye].slice(-MAX_GOODBYES));
  }

  /** Said to someone (or you're back in): nothing more to do. */
  drop(groupId: string): void {
    if (this.list.some((g) => g.groupId === groupId)) this.save(this.list.filter((g) => g.groupId !== groupId));
  }

  private save(list: readonly Goodbye[]): void {
    this.list = list;
    writeJson(this.file, list);
  }
}
