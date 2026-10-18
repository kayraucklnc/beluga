# The klaud network (Mac app)

Friends, direct messages, groups and presence with **no server and no host**: every Mac is its
own infrastructure. It runs in the daemon only when turned on (`"network": true` in
`~/.klaud/settings.json`, or `KLAUD_NETWORK=1`), next to today's rooms, which are unchanged.
Code: `src/net/mesh/` (the node), `src/core/network.ts` (the core service and the `network.*`
API), `src/core/network-store.ts` (the shared state's `network`).

## Your address

Everything is derived from your identity (`~/.klaud/identity.json`) with HKDF, so it is the same
on every run:

- the **address**: an Ed25519 Noise key pair your Mac listens on in the Hyperswarm DHT;
- the **box key**: an X25519 key that group keys are sealed to;
- your **card**: peer id, identity key, address and box key, signed by your identity key. A card
  is checked wherever it's learned (pairing, group entries, the friends file).

Unlike a room's per-run key, the address is stable on purpose (friends find you by it), so DHT
observers can tell when that address is online.

## Adding a friend

An invitation is a one-time link (`klaud://add#<22 chars>`, 128 bits) and a short code
(`K7QM-4XPA`, 40 bits, Crockford base32). Neither contains your address: the inviter listens on a
temporary key pair made from the secret (HKDF for the link, scrypt N=2^15 for the code), so only
someone holding it can find you. On that connection:

```
invitee → pair_hello { profile, proof }   proof = HMAC(auth, "invitee" ‖ Noise handshake hash ‖ profile)
inviter → pair_ok    { profile, proof }   (or pair_refused)
```

The proofs bind both cards to that one connection (no replay, no one in the middle without the
secret), and the invitee must dial with the address on its card. Friend invitations are
single-use and last 24 h; five bad proofs in a minute pause an invitation for the rest of it.
Group invitations (`klaud://join#…`) work the same, are multi-use for 7 days, and either let
people in at once (`auto`) or leave a request for an admin (`network.groups.approve`).

## Links

The daemon keeps one Noise link to every friend and group member who is online: it dials them
(backing off from 1 s to 60 s while they're away) and its firewall accepts only addresses it
knows. Two Macs dialing each other at once keep the same connection (direct over relayed, then
the one dialed by the lower address). Each link has a heartbeat (dropped after 3 missed),
2 MB frames and token-bucket limits on messages and bytes. Messages are versioned JSON (`hello` carries
`proto: 1`; unknown kinds are ignored): `hello`, `presence`, `dm`/`dm_ack`,
`g_heads`/`g_sync`/`g_entries`, `tun_open`/`tun_in`/`tun_data`/`tun_close`.

**Relaying.** When a direct dial fails (both sides behind strict NATs, UDP blocked), your Mac asks
someone linked to both of you (people in a shared group first) to open a tunnel. The relay only
forwards bytes; inside, the two ends run their own Noise handshake with their addresses
(`@hyperswarm/secret-stream`), so the relay sees ciphertext and can't pose as either side. It
does learn that the two of you talk, and how much. HyperDHT's own blind relays (`relayThrough`)
were not used: they can't be exercised on a local test network, while these tunnels are tested.
Limits: 16 tunnels per link, 64 per relay.

## Groups

A group is a signed, append-only log kept on every member's Mac (`~/.klaud/groups/<id>.jsonl`):

- entry: `{ id, group, author, lamport, parents, type, ts, body, sig }`; `id` = SHA-256 of the
  canonical JSON of the rest, `sig` = the author's identity signature over `id`, `lamport` = 1 +
  the highest parent's. Every copy orders entries by `(lamport, id)`, so all copies agree.
- types: `create`, `member_add`, `member_remove`, `admin_add`, `admin_remove`, `rename`,
  `sender_key`, `message`.
- rules, applied in that order: the creator is the first admin; only admins add or remove people
  and make admins; anyone may leave or rename; entries by non-members change nothing; if the last
  admin leaves, the longest-standing member becomes admin. Conflicting changes (two admins
  removing each other) are settled by the order: the first one applied wins. Removal wins over
  anything the removed person wrote without having seen it, so nobody can write themselves back
  in from an old copy. Only an admin's add makes a newcomer's entries checkable at all.
- limits: a sending key belongs to its author (nobody can reuse its id), message numbers may only
  run 1000 ahead of the chain, at most 100 members.
- sync: on link up and every 30 s each side sends its heads; whoever lacks something sends its
  own heads and gets what it's missing oldest first, in batches of 200 entries / 512 KB. New
  entries are passed on to every linked member (gossip), so they reach people you can't link to.
  Someone removed is only sent entries up to their removal.

**Encryption: sender keys.** Each member sends with a chain key sealed for each current member
(ephemeral X25519 + HKDF + AES-256-GCM) in a `sender_key` entry. Every message gets its own key
(`HMAC(chain, 1)`, then `chain = HMAC(chain, 2)`); bodies are AES-256-GCM with the group, author,
chain and number as associated data. Headers are signed, bodies encrypted. Whenever who's in the
group changes, each member starts a new chain at their next message, sealed only for the people
in it now: someone removed can't read what's sent after, and someone added can't read what came
before. Keys never leave the daemon; the shared state and the API only carry views.

## Offline

Direct messages to an offline friend wait in your outbox (`~/.klaud/outbox.json`, 7 days) and
are sent when a link comes up; the receiver acknowledges and de-duplicates. Group entries are
held by every member, so you catch up from whoever is online.

## Presence

`{ state: online | away | dnd | offline, note?, until? }`, sent on link up and on change.
Choosing `offline` means appear offline: links stay up and messages arrive, but others see a
plain `offline`. A status with `until` reverts to online by itself. Idle detection is the
screen's job (`network.presence.set`).

## Known limits (phase 1)

- Logs are never compacted; very long-lived groups grow.
- Removal wins: once someone is removed, entries they wrote without having seen their removal
  don't count (even a message written offline at the same moment). Someone removed while
  offline learns of it from any member who still accepts them (removed people may call in for
  7 days).
- The 8-character code is a short secret: someone watching the DHT for the code's key could try
  to brute-force it (scrypt makes each guess slow) during its 24 hours. The link is 128 bits;
  share it when you can.
- A burst of wrong proofs pauses an invitation for a minute rather than burning it, so nobody
  can kill your invitation, but they can delay it.
- Open invitations (their link and code) are in the shared state, so any screen attached to
  your daemon can show and copy them, as with room invites.
- Appear offline only changes what others are shown: your Mac still links and acknowledges
  messages, so a friend's klaud could tell you're connected.
- The relay learns who talks to whom and how much (not what).
- A join request reaches the admin whose invitation was used, not every admin.
- Groups you didn't ask for are only fetched from friends (an admin adding you directly) and
  from the admin whose invite you used; at most 500 groups and 100 people per group.
- One Mac per identity: a second klaud process with the same `~/.klaud` doesn't start the network.
