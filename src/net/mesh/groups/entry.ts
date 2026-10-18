import type { Identity } from '../../crypto.js';
import { canonical, sha256 } from '../files.js';
import { signText, verifyText } from '../keys.js';
import { BODIES, type Body, type Entry, EntrySchema, type EntryType, MAX_PARENTS } from '../schemas.js';

/**
 * One entry of a group's log. Its id is the hash of everything in it, and the author signs
 * the id, so nobody can change an entry (or write one in someone else's name) unnoticed.
 * `lamport` is one more than the highest parent's, so sorting by (lamport, id) always puts an
 * entry after its parents and gives every copy of the log the same order.
 */

const SIG_LABEL = 'klaud-entry-v1';

type Unsigned = Omit<Entry, 'id' | 'sig'>;

export const entryId = (e: Unsigned): string =>
  sha256(canonical({ group: e.group, author: e.author, lamport: e.lamport, parents: e.parents, type: e.type, ts: e.ts, body: e.body }));

/** A group's id comes from the entry that created it. */
export const groupIdOf = (genesisId: string): string => genesisId.slice(0, 32);

export function signEntry(identity: Identity, fields: Unsigned): Entry {
  const parents = [...fields.parents].sort();
  const unsigned = { ...fields, parents };
  const id = entryId(unsigned);
  return { ...unsigned, id, sig: signText(identity, SIG_LABEL, id) };
}

/** Shape, size and body of an entry are right, and its id matches its content (no keys needed). */
export function wellFormed(raw: unknown): Entry | undefined {
  try {
    return checkShape(raw);
  } catch {
    return undefined;
  }
}

function checkShape(raw: unknown): Entry | undefined {
  const parsed = EntrySchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const e = parsed.data;
  if (!BODIES[e.type].safeParse(e.body).success) return undefined;
  if (canonical(e.body).length > 64_000) return undefined;
  if (e.parents.length > MAX_PARENTS || new Set(e.parents).size !== e.parents.length) return undefined;
  if ([...e.parents].sort().join() !== e.parents.join()) return undefined;
  if (entryId(e) !== e.id) return undefined;
  if (e.type === 'create' ? e.group !== '' || e.parents.length || e.lamport !== 0 : e.group === '' || !e.parents.length) return undefined;
  return e;
}

export const verifySignature = (e: Entry, publicKey: string): boolean => verifyText(publicKey, SIG_LABEL, e.id, e.sig);

/** An entry's body, typed by its kind (bodies were checked when the entry came in: see wellFormed). */
export const bodyOf = <T extends EntryType>(e: Entry, _type: T): Body<T> => e.body as Body<T>;

/** Order entries the way every copy of the log does. */
export const byOrder = (a: Entry, b: Entry): number => a.lamport - b.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
