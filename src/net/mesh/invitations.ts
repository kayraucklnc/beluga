import { createHmac, hkdfSync, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { readJson, writeJson } from './files.js';

/**
 * Invitations: a one-time link (`beluga://add#…`, or `beluga://join#…` for a group) and a short
 * code (`K7QM-4XPA-R2TD`) that do the same thing. Neither names your address: the secret in them
 * is stretched into a temporary key pair you listen on while the invitation is open, so only
 * someone holding the secret can even find you, and both sides prove they know it.
 *
 * The code is 60 bits, stretched with memory-hard scrypt (64 MiB per guess), and only works for
 * an hour (the link: a day, a week for groups). Someone watching the DHT for the code's key
 * would need on the order of a billion GPUs to guess it in that hour (docs/network.md).
 */

/** Crockford base32: no I, L, O or U, so it reads aloud and types without mix-ups. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
export const FRIEND_TTL_MS = 24 * 60 * 60 * 1000;
/** A code works for an hour (or less, if the invitation itself is shorter). */
export const CODE_TTL_MS = 60 * 60 * 1000;
/** scrypt cost for codes: 2^16 × 128 × 8 bytes = 64 MiB per guess (~0.1 s on a Mac). */
const SCRYPT = { N: 1 << 16, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
export const GROUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Wrong proofs an invitation takes per minute; after that it refuses everyone until the minute is up. */
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 60_000;
/** Invitations open at once. */
export const MAX_OPEN = 20;

export type InviteKind = 'friend' | 'group';

export const InvitationRecord = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  kind: z.enum(['friend', 'group']),
  groupId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  secret: z.string().regex(/^[\w-]{22}$/),
  code: z.string().regex(/^[0-9A-Z]{12}$/),
  createdAt: z.number(),
  expiresAt: z.number(),
  /** When the code stops working (the link lasts until `expiresAt`). */
  codeExpiresAt: z.number(),
  uses: z.number().int().min(0),
  failures: z.number().int().min(0),
  /** Group invites: let people in without asking an admin. */
  auto: z.boolean().optional(),
  /** Only this person may use it (a friend request sent to someone in your room). */
  for: z.string().regex(/^[\w-]{32}$/).optional(),
});
export type InvitationRecord = z.infer<typeof InvitationRecord>;

/** Links are made as beluga://; klaud:// ones from before the rename still open. */
export const LINK_SCHEME = 'beluga://';

export const formatCode = (code: string): string => (code.match(/.{1,4}/g) ?? []).join('-');
export const linkOf = (r: Pick<InvitationRecord, 'kind' | 'secret'>): string => `${LINK_SCHEME}${r.kind === 'friend' ? 'add' : 'join'}#${r.secret}`;

export function newInvitation(kind: InviteKind, opts: { groupId?: string; auto?: boolean; ttlMs?: number; codeTtlMs?: number; for?: string } = {}): InvitationRecord {
  const now = Date.now();
  const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return {
    id: randomBytes(8).toString('hex'),
    kind,
    ...(opts.groupId ? { groupId: opts.groupId } : {}),
    secret: randomBytes(16).toString('base64url'),
    code,
    createdAt: now,
    expiresAt: now + (opts.ttlMs ?? (kind === 'friend' ? FRIEND_TTL_MS : GROUP_TTL_MS)),
    codeExpiresAt: now + Math.min(opts.codeTtlMs ?? CODE_TTL_MS, opts.ttlMs ?? CODE_TTL_MS, CODE_TTL_MS),
    uses: 0,
    failures: 0,
    ...(opts.auto ? { auto: true } : {}),
    ...(opts.for ? { for: opts.for } : {}),
  };
}

/** What someone typed or pasted: a link's secret or a code. */
export type Ticket = { readonly via: 'link'; readonly secret: string } | { readonly via: 'code'; readonly code: string };

/** A typed code, read loosely: any case, dashes or spaces anywhere, O for 0, I or L for 1. */
function readCode(typed: string): string | undefined {
  const compact = typed
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return compact.length === CODE_LENGTH && [...compact].every((c) => ALPHABET.includes(c)) ? compact : undefined;
}

/** The code as a link (`beluga://add?code=K7QM-4XPA-R2TD`): clicking it is the same as typing it. */
export const codeLinkOf = (r: Pick<InvitationRecord, 'kind' | 'code'>): string => `${LINK_SCHEME}${r.kind === 'friend' ? 'add' : 'join'}?code=${formatCode(r.code)}`;

/** Read an invitation out of pasted text ("beluga://add#…", "beluga://add?code=…", the same with klaud:// from before the rename, "K7QM-4XPA-R2TD", "k7qm 4xpa r2td"…). */
export function parseTicket(text: string): Ticket | undefined {
  const link = /(?:beluga|klaud):\/\/(?:add|join)\/?#([\w-]{22})(?![\w-])/.exec(text);
  if (link) return { via: 'link', secret: link[1]! };
  const codeLink = /(?:beluga|klaud):\/\/(?:add|join)\/?\?code=([0-9A-Za-z%+-]{12,40})/.exec(text);
  if (codeLink) {
    let raw = codeLink[1]!;
    try {
      raw = decodeURIComponent(raw.replace(/\+/g, ' '));
    } catch {
      return undefined;
    }
    const code = readCode(raw);
    return code ? { via: 'code', code } : undefined;
  }
  const code = readCode(text);
  return code ? { via: 'code', code } : undefined;
}

/** The temporary key pair seed and the proof key an invitation's secret turns into. */
export interface PairingSecrets {
  readonly seed: Buffer;
  readonly auth: Buffer;
}

const scryptAsync = (pass: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(pass, salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));

export async function pairingSecrets(ticket: Ticket): Promise<PairingSecrets> {
  if (ticket.via === 'code') {
    const key = await scryptAsync(ticket.code, 'klaud-pair-code-v2');
    return { seed: key.subarray(0, 32), auth: key.subarray(32) };
  }
  const ikm = Buffer.from(ticket.secret, 'base64url');
  const derive = (info: string): Buffer => Buffer.from(hkdfSync('sha256', ikm, Buffer.from('klaud-pair-link-v1'), Buffer.from(info), 32));
  return { seed: derive('seed'), auth: derive('auth') };
}

/** The proof one side of a pairing sends: bound to its role, this connection and what it says about itself. */
export const pairProof = (auth: Buffer, role: 'invitee' | 'inviter', handshakeHash: Buffer, about: string): string =>
  createHmac('sha256', auth).update(`klaud-pair-v1:${role}:`).update(handshakeHash).update(':').update(about).digest('base64');

export function checkProof(auth: Buffer, role: 'invitee' | 'inviter', handshakeHash: Buffer, about: string, proof: string): boolean {
  const expected = Buffer.from(pairProof(auth, role, handshakeHash, about), 'base64');
  const actual = Buffer.from(proof, 'base64');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Your open invitations, kept in ~/.beluga/invitations.json (0600: they hold secrets). */
export class InvitationBook {
  private list: readonly InvitationRecord[];

  constructor(private readonly file: string) {
    const raw = readJson(file);
    const items = Array.isArray(raw) ? raw : [];
    this.list = items.flatMap((r) => {
      const parsed = InvitationRecord.safeParse(r);
      return parsed.success && parsed.data.expiresAt > Date.now() ? [parsed.data] : [];
    });
  }

  all = (): readonly InvitationRecord[] => this.list.filter((r) => r.expiresAt > Date.now());
  get = (id: string): InvitationRecord | undefined => this.all().find((r) => r.id === id);

  add(record: InvitationRecord): void {
    if (this.all().length >= MAX_OPEN) throw new Error(`You have ${MAX_OPEN} open invitations; cancel some first`);
    this.save([...this.all(), record]);
  }

  update(id: string, patch: Partial<Pick<InvitationRecord, 'uses' | 'failures'>>): InvitationRecord | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.save(this.all().map((r) => (r.id === id ? next : r)));
    return next;
  }

  remove(id: string): boolean {
    const before = this.list.length;
    this.save(this.list.filter((r) => r.id !== id));
    return this.list.length !== before;
  }

  private save(next: readonly InvitationRecord[]): void {
    this.list = next;
    writeJson(this.file, next);
  }
}
