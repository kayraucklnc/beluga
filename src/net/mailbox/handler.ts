/**
 * Beluga's mailbox (BLG-272): where a frame waits when the friend it's for and the Mac it's from
 * are never online at the same time. One mailbox per person, addressed by their peer id. It is a
 * blind store: what's in it is sealed to the recipient's box key (only their Mac opens it), and
 * signed by the sender, so the mailbox only learns who wrote to whom, when, and how much.
 *
 * - Putting mail: the sender signs `put:<to>:<id>:<sha256 of the sealed text>` with their identity
 *   key, and their peer id must be that key's. A mail id twice is kept once.
 * - Taking mail and clearing it: only the mailbox's owner, signing `take:<to>:<at>` (or
 *   `done:<to>:<at>:<ids>`) within five minutes of the mailbox's clock.
 * - Mail is kept 7 days, the same as a Mac's own outbox. Caps keep one sender (or one stranger
 *   with a key of their own) from filling someone's mailbox.
 *
 * Plain Web Crypto and fetch types only: the Cloudflare Worker (packages/mailbox) runs this with a
 * Durable Object's storage, the tests with a Map.
 */

export const MAIL_LABEL = 'beluga-mail-v1';
export const MAIL_TTL_MS = 7 * 86_400_000;
export const MAX_SEALED = 1_000_000;
export const MAX_ITEMS = 2_000;
export const MAX_FROM_ONE = 500;
export const MAX_BYTES = 64_000_000;
const TAKE_ITEMS = 50;
const TAKE_BYTES = 4_000_000;
const CLOCK_SKEW_MS = 5 * 60_000;

/** One piece of mail as it's kept and handed back. */
export interface MailItem {
  readonly id: string;
  readonly from: string;
  /** The sender's identity key (base64 SPKI DER). */
  readonly key: string;
  /** The sealed frame (JSON text of a Sealed box). */
  readonly sealed: string;
  readonly sig: string;
  readonly at: number;
}

/** Where one mailbox keeps its mail (a Durable Object's SQLite, or memory). */
export interface MailStore {
  has(id: string): Promise<boolean>;
  put(item: MailItem): Promise<void>;
  /** How many items, from how many bytes, and how many of them from `from`. */
  usage(from: string): Promise<{ readonly items: number; readonly bytes: number; readonly fromOne: number }>;
  /** The oldest items first, up to `limit`. */
  list(limit: number): Promise<readonly MailItem[]>;
  remove(ids: readonly string[]): Promise<void>;
  /** Drop what's older than `before`. */
  expire(before: number): Promise<void>;
}

const PEER = /^[\w-]{32}$/;
const MAIL_ID = /^[\w-]{8,64}$/;
const B64 = /^[A-Za-z0-9+/=]{40,200}$/;

const enc = new TextEncoder();
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (bytes: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const sha256Hex = async (text: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));

/** The peer id a key gives (the same as net/crypto.ts's peerIdFor). */
export const peerIdOf = async (key: string): Promise<string> => b64url(await crypto.subtle.digest('SHA-256', fromB64(key))).slice(0, 32);

/** `sig` is `key`'s signature over `MAIL_LABEL:text` (as net/mesh/keys.ts's signText makes it). */
export async function signedBy(key: string, text: string, sig: string): Promise<boolean> {
  try {
    const pub = await crypto.subtle.importKey('spki', fromB64(key), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, pub, fromB64(sig), enc.encode(`${MAIL_LABEL}:${text}`));
  } catch {
    return false;
  }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refuse = (status: number, error: string): Response => json({ error }, status);

async function bodyOf(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await req.text();
    if (text.length > MAX_SEALED + 4_000) return undefined;
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The mailbox's owner signed this just now. */
async function owner(to: string, b: Record<string, unknown>, text: (at: number) => string, now: number): Promise<boolean> {
  const { key, at, sig } = b;
  if (typeof key !== 'string' || !B64.test(key) || typeof at !== 'number' || typeof sig !== 'string') return false;
  if (Math.abs(now - at) > CLOCK_SKEW_MS) return false;
  return (await peerIdOf(key)) === to && signedBy(key, text(at), sig);
}

/**
 * One mailbox's requests (the Worker has already picked the mailbox by `to`):
 * - `POST /v1/mail/<to>` `{id, from, key, sealed, sig}`: leave mail.
 * - `POST /v1/mail/<to>/take` `{key, at, sig}`: the oldest mail (a page), for its owner.
 * - `POST /v1/mail/<to>/done` `{key, at, sig, ids}`: the owner has it; it's deleted.
 */
export async function handleMailbox(req: Request, to: string, store: MailStore, now = Date.now()): Promise<Response> {
  if (req.method !== 'POST') return refuse(405, 'POST only');
  if (!PEER.test(to)) return refuse(400, 'Not a mailbox');
  const action = new URL(req.url).pathname.split('/')[4] ?? '';
  const b = await bodyOf(req);
  if (!b) return refuse(400, 'Not JSON, or too big');
  await store.expire(now - MAIL_TTL_MS);

  if (action === '') {
    const { id, from, key, sealed, sig } = b;
    if (typeof id !== 'string' || !MAIL_ID.test(id) || typeof from !== 'string' || !PEER.test(from)) return refuse(400, 'Bad mail');
    if (typeof key !== 'string' || !B64.test(key) || typeof sealed !== 'string' || typeof sig !== 'string') return refuse(400, 'Bad mail');
    if (sealed.length > MAX_SEALED) return refuse(413, 'Too big');
    if ((await peerIdOf(key)) !== from) return refuse(403, 'That key isn’t theirs');
    if (!(await signedBy(key, `put:${to}:${id}:${await sha256Hex(sealed)}`, sig))) return refuse(403, 'Not signed');
    if (await store.has(id)) return json({ ok: true, kept: true });
    const use = await store.usage(from);
    if (use.items >= MAX_ITEMS || use.bytes + sealed.length > MAX_BYTES || use.fromOne >= MAX_FROM_ONE) return refuse(507, 'Their mailbox is full');
    await store.put({ id, from, key, sealed, sig, at: now });
    return json({ ok: true });
  }

  if (action === 'take') {
    if (!(await owner(to, b, (at) => `take:${to}:${at}`, now))) return refuse(403, 'Not yours');
    const out: MailItem[] = [];
    let bytes = 0;
    for (const m of await store.list(TAKE_ITEMS)) {
      if (out.length && bytes + m.sealed.length > TAKE_BYTES) break;
      out.push(m);
      bytes += m.sealed.length;
    }
    return json({ mail: out, more: out.length < (await store.usage('')).items });
  }

  if (action === 'done') {
    const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string' && MAIL_ID.test(x)).slice(0, 500) : [];
    if (!(await owner(to, b, (at) => `done:${to}:${at}:${ids.join(',')}`, now))) return refuse(403, 'Not yours');
    await store.remove(ids);
    return json({ ok: true });
  }

  return refuse(404, 'No such thing');
}

/** A mailbox in memory (tests, and a local mailbox for trying things out). */
export class MemoryMailStore implements MailStore {
  private readonly items = new Map<string, MailItem>();
  has = async (id: string): Promise<boolean> => this.items.has(id);
  put = async (item: MailItem): Promise<void> => void this.items.set(item.id, item);
  usage = async (from: string) => {
    const all = [...this.items.values()];
    return { items: all.length, bytes: all.reduce((n, m) => n + m.sealed.length, 0), fromOne: all.filter((m) => m.from === from).length };
  };
  list = async (limit: number): Promise<readonly MailItem[]> => [...this.items.values()].sort((a, b) => a.at - b.at).slice(0, limit);
  remove = async (ids: readonly string[]): Promise<void> => {
    for (const id of ids) this.items.delete(id);
  };
  expire = async (before: number): Promise<void> => {
    for (const [id, m] of this.items) if (m.at < before) this.items.delete(id);
  };
}

/** Many mailboxes in memory, answering like the Worker does: a fetch for tests. */
export function memoryMailboxes(now: () => number = Date.now): { readonly fetch: typeof fetch; readonly boxes: Map<string, MemoryMailStore>; requests: number } {
  const boxes = new Map<string, MemoryMailStore>();
  const self = {
    boxes,
    requests: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      self.requests++;
      const req = new Request(input, init);
      const parts = new URL(req.url).pathname.split('/');
      if (parts[1] !== 'v1' || parts[2] !== 'mail' || !parts[3]) return refuse(404, 'No such thing');
      const store = boxes.get(parts[3]) ?? new MemoryMailStore();
      boxes.set(parts[3], store);
      return handleMailbox(req, parts[3], store, now());
    }) as typeof fetch,
  };
  return self;
}
