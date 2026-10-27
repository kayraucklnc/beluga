import { createHash, randomBytes } from 'node:crypto';
import { MAIL_LABEL, type MailItem } from '../mailbox/handler.js';
import { type Card, type MeshKeys, type Sealed, openSealed, sealTo, signText, verifyText } from './keys.js';

/**
 * Your Mac's side of the mailbox (src/net/mailbox/handler.ts, a Cloudflare Worker): for when a
 * friend and you are never online at the same time. A frame nobody acknowledged for a while
 * (`afterMs`) is sealed to their box key, signed, and left in their mailbox; their Mac takes its
 * mail when it starts, when it wakes, and every `checkMs` while any friend is offline, opens it
 * and hands it on as if it came over the link. Its acknowledgement comes back the same way.
 *
 * Only friends' mail is opened: a stranger's (or anything that doesn't check out) is deleted
 * unread. The mailbox sees who wrote to whom and how much, never what.
 */

/** The mailbox anyone's Mac uses unless told otherwise (packages/mailbox, deployed on Cloudflare); none until it is. */
export const DEFAULT_MAILBOX_URL: string | undefined = undefined;
/** A frame nobody took for this long goes to the mailbox. */
export const MAIL_AFTER_MS = 2 * 60_000;
/** How often to look for mail while some friend is offline. */
export const CHECK_MS = 3 * 60_000;

export interface MailboxOptions {
  readonly url: string;
  readonly afterMs?: number;
  readonly checkMs?: number;
  /** Tests: an in-memory mailbox. */
  readonly fetch?: typeof fetch;
}

/** The kinds of frame that may go by mail (the link's `t`). */
export type MailChannel = 'gw' | 'share' | 'team';
const CHANNELS = new Set<string>(['gw', 'share', 'team']);

interface Inside {
  readonly v: 1;
  readonly from: string;
  readonly to: string;
  readonly t: MailChannel;
  readonly p: unknown;
}

const TIMEOUT_MS = 15_000;
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

export class Mailbox {
  readonly afterMs: number;
  readonly checkMs: number;
  private readonly fetch: typeof fetch;
  private readonly base: string;
  private checking: Promise<number> | undefined;

  constructor(
    private readonly keys: Pick<MeshKeys, 'identity' | 'card' | 'boxPrivate'>,
    opts: MailboxOptions,
    private readonly deps: {
      /** A friend's card (undefined: not a friend, their mail isn't opened). */
      readonly cardOf: (peerId: string) => Card | undefined;
      /** Mail that checked out, handed on as if it came over their link. */
      readonly deliver: (from: string, t: MailChannel, p: unknown) => void;
    },
  ) {
    this.base = opts.url.replace(/\/+$/, '');
    this.afterMs = opts.afterMs ?? MAIL_AFTER_MS;
    this.checkMs = opts.checkMs ?? CHECK_MS;
    this.fetch = opts.fetch ?? fetch;
  }

  private get me(): string {
    return this.keys.identity.peerId;
  }

  /** Leave a frame in a friend's mailbox; true once the mailbox has it. */
  async post(to: string, t: MailChannel, p: unknown): Promise<boolean> {
    const card = this.deps.cardOf(to);
    if (!card) return false;
    const inside: Inside = { v: 1, from: this.me, to, t, p };
    const sealed = JSON.stringify(sealTo(card.box, Buffer.from(JSON.stringify(inside)), `${MAIL_LABEL}:${to}`));
    const id = randomBytes(12).toString('base64url');
    const sig = signText(this.keys.identity, MAIL_LABEL, `put:${to}:${id}:${sha256Hex(sealed)}`);
    const res = await this.call(to, '', { id, from: this.me, key: this.keys.identity.publicKey, sealed, sig });
    return Boolean(res?.ok);
  }

  /** Take everything in your mailbox (one check at a time); how many frames were handed on. */
  check(): Promise<number> {
    this.checking ??= this.takeAll().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async takeAll(): Promise<number> {
    let handed = 0;
    for (let page = 0; page < 20; page++) {
      const at = Date.now();
      const res = await this.call(this.me, 'take', { key: this.keys.identity.publicKey, at, sig: signText(this.keys.identity, MAIL_LABEL, `take:${this.me}:${at}`) });
      const mail = Array.isArray(res?.mail) ? (res.mail as MailItem[]) : [];
      if (!mail.length) break;
      const done: string[] = [];
      for (const m of mail) {
        if (typeof m?.id !== 'string') continue;
        done.push(m.id);
        const opened = this.open(m);
        if (!opened) continue;
        try {
          this.deps.deliver(opened.from, opened.t, opened.p);
          handed++;
        } catch {
          // A frame its part couldn't take is still gone from the mailbox: it would fail again.
        }
      }
      const at2 = Date.now();
      await this.call(this.me, 'done', { key: this.keys.identity.publicKey, at: at2, ids: done, sig: signText(this.keys.identity, MAIL_LABEL, `done:${this.me}:${at2}:${done.join(',')}`) });
      if (!res?.more) break;
    }
    return handed;
  }

  /** Mail from a friend, signed by them and sealed to you; undefined for anything else. */
  private open(m: MailItem): Inside | undefined {
    const card = this.deps.cardOf(m.from);
    if (!card || card.publicKey !== m.key || typeof m.sealed !== 'string' || typeof m.sig !== 'string') return undefined;
    if (!verifyText(m.key, MAIL_LABEL, `put:${this.me}:${m.id}:${sha256Hex(m.sealed)}`, m.sig)) return undefined;
    let sealed: Sealed;
    try {
      sealed = JSON.parse(m.sealed) as Sealed;
    } catch {
      return undefined;
    }
    const plain = openSealed(this.keys, sealed, `${MAIL_LABEL}:${this.me}`);
    if (!plain) return undefined;
    try {
      const inside = JSON.parse(plain.toString('utf8')) as Inside;
      if (inside.v !== 1 || inside.from !== m.from || inside.to !== this.me || !CHANNELS.has(inside.t)) return undefined;
      return inside;
    } catch {
      return undefined;
    }
  }

  private async call(box: string, action: string, body: unknown): Promise<Record<string, unknown> | undefined> {
    try {
      const res = await this.fetch(`${this.base}/v1/mail/${box}${action ? `/${action}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return undefined;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      // Offline, or the mailbox is down: it's tried again later.
      return undefined;
    }
  }
}
