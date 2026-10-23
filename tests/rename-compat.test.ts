import { createHash, createHmac, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveKeys, generateIdentity, seal, signBox, signNonce } from '../src/net/crypto.js';
import { decodeInvite, encodeInvite, findInvite } from '../src/net/invite.js';
import { codeLinkOf, linkOf, pairProof, pairingSecrets } from '../src/net/mesh/invitations.js';
import { signEntry } from '../src/net/mesh/groups/entry.js';
import { encodeKey } from '../src/net/p2p.js';
import * as old from './fixtures/pre-rename/invite.js';
import { parseTicket as oldParseTicket } from './fixtures/pre-rename/invitations.js';

/** Klaud → Beluga without breaking anyone: a Klaud from before the rename still talks to Beluga (KLD-87). */

describe('an older Klaud opens the invites Beluga makes', () => {
  const key = encodeKey(Buffer.alloc(32, 7));
  const secret = 'tVh65bTGibnD1mD3ofr75-PD';

  it('room invites, direct and with a relay, as the pre-rename parser reads them', () => {
    for (const invite of [{ url: `p2p://${key}`, secret }, { url: `p2p://${key}`, relay: 'wss://calm-river.trycloudflare.com', secret }]) {
      const link = encodeInvite(invite);
      expect(old.decodeInvite(link)).toEqual(invite);
      expect(old.findInvite(`klaud join ${link}`)).toBe(link);
      // And Beluga reads its own link the same way.
      expect(decodeInvite(link)).toEqual(invite);
    }
  });

  it('relay-only room invites never had a scheme to rename', () => {
    const link = encodeInvite({ url: 'wss://calm-river.trycloudflare.com', secret });
    expect(old.decodeInvite(link)).toEqual({ url: 'wss://calm-river.trycloudflare.com', secret });
  });

  it('friend and group invitations: the link and the code as a link', () => {
    const s = 'AAAAAAAAAAAAAAAAAAAAAA';
    for (const kind of ['friend', 'group'] as const) {
      expect(oldParseTicket(linkOf({ kind, secret: s }))).toEqual({ via: 'link', secret: s });
      expect(oldParseTicket(codeLinkOf({ kind, code: 'K7QM4XPAR2TD' }))).toEqual({ via: 'code', code: 'K7QM4XPAR2TD' });
    }
  });

  it('Beluga still reads beluga:// links, should anyone send one', () => {
    expect(decodeInvite(`beluga://${key}#${secret}`)).toEqual({ url: `p2p://${key}`, secret });
    expect(findInvite(`beluga join beluga://${key}#${secret}`)).toBe(`beluga://${key}#${secret}`);
  });
});

/**
 * The words mixed into keys and signatures. Renaming one silently splits Beluga from every Klaud
 * (and from people's saved groups): they stay klaud/klaude forever.
 */
describe('the wire and crypto labels never change', () => {
  const hkdf = (ikm: Buffer, salt: string, info: string): Buffer => Buffer.from(hkdfSync('sha256', ikm, Buffer.from(salt), Buffer.from(info), 32));
  const verifies = (publicKey: string, message: string, signature: string): boolean =>
    verify(null, Buffer.from(message), createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(signature, 'base64'));

  it('room keys: klaude-v1', () => {
    const secret = 'room-secret-long-enough';
    expect(deriveKeys(secret).enc).toEqual(hkdf(Buffer.from(secret), 'klaude-v1', 'enc'));
    expect(deriveKeys(secret).auth).toEqual(hkdf(Buffer.from(secret), 'klaude-v1', 'auth'));
  });

  it('who you are and what you sent: klaude-id, klaud-msg', () => {
    const me = generateIdentity();
    expect(verifies(me.publicKey, `klaude-id:n0nce:${me.peerId}`, signNonce(me, 'n0nce'))).toBe(true);
    const box = seal(deriveKeys('room-secret-long-enough'), { hi: 1 });
    const hash = createHash('sha256').update(box.iv).update(':').update(box.ct).update(':').update(box.tag).digest('base64');
    expect(verifies(me.publicKey, `klaud-msg:${hash}:bob`, signBox(me, box, 'bob'))).toBe(true);
  });

  it('pairing: klaud-pair-link-v1, klaud-pair-v1', async () => {
    const secret = 'AAAAAAAAAAAAAAAAAAAAAA';
    const ikm = Buffer.from(secret, 'base64url');
    const { seed, auth } = await pairingSecrets({ via: 'link', secret });
    expect(seed).toEqual(hkdf(ikm, 'klaud-pair-link-v1', 'seed'));
    expect(auth).toEqual(hkdf(ikm, 'klaud-pair-link-v1', 'auth'));
    const hh = Buffer.alloc(32, 1);
    expect(pairProof(auth, 'invitee', hh, 'me')).toBe(createHmac('sha256', auth).update('klaud-pair-v1:invitee:').update(hh).update(':').update('me').digest('base64'));
  });

  it('group log entries: klaud-entry-v1', () => {
    const me = generateIdentity();
    const entry = signEntry(me, { group: 'g', author: me.peerId, lamport: 1, parents: [], type: 'genesis', ts: 1, body: {} } as unknown as Parameters<typeof signEntry>[1]);
    expect(verifies(me.publicKey, `klaud-entry-v1:${entry.id}`, entry.sig)).toBe(true);
  });

  // The rest sit inside private helpers (or cost 64 MiB of scrypt): pinned where they're written.
  it.each([
    ['src/net/mesh/keys.ts', "Buffer.from('klaud-mesh')"],
    ['src/net/mesh/keys.ts', "Buffer.from('klaud-seal-v1')"],
    ['src/net/mesh/invitations.ts', "'klaud-pair-code-v2'"],
    ['src/net/mesh/groups/sender-keys.ts', '`klaud-msg-v1:${group}'],
    ['src/net/mesh/groups/entry.ts', "SIG_LABEL = 'klaud-entry-v1'"],
    ['src/core/attachment-share.ts', "ATTACHMENT_SHARE = 'klaud-attachments'"],
    ['src/core/attachment-share.ts', "ATTACHMENT_SCHEME = 'klaud-attachment:'"],
  ])('%s keeps %s', (file, text) => {
    expect(readFileSync(path.join(import.meta.dirname, '..', file), 'utf8')).toContain(text);
  });
});
