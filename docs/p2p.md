# Direct peer-to-peer connections

Beluga can connect friends straight to the host's computer, with no tunnel provider in the
path. It uses the Hyperswarm DHT (`hyperdht`): UDP hole-punching plus a Noise-encrypted stream.
The room is still a star through the host's hub; each friend just gets a direct line to it.

## Remote access settings

| Setting       | What friends dial                                                    |
| ------------- | -------------------------------------------------------------------- |
| `auto`        | Direct first. A Cloudflare (then ngrok) relay starts in the background and is added to the invite as the fallback. |
| `p2p`         | Direct only.                                                         |
| `cloudflared` | A Cloudflare quick tunnel (relay only, as before).                   |
| `ngrok`       | ngrok (relay only).                                                  |
| `none`        | Your local network (`ws://<lan-ip>:<port>`).                         |

With `auto`, a direct invite is ready about 1-2 s after you click Invite (the time to announce
on the DHT). The Cloudflare fallback usually follows 5-20 s later. The invite on screen is then
updated, and so is your clipboard if it still holds the first link. A friend holding the
direct-only link can still join directly; they just have no fallback.

## Invite format

```
klaud://<host key>#<secret>                           direct only
klaud://<host key>?relay=https://x.trycloudflare.com#<secret>   direct + fallback relay
https://x.trycloudflare.com#<secret>                  relay only (unchanged, still accepted)
```

Invites are made as `klaud://` so a Klaud from before the rename can open them; `beluga://` is
read the same way.

- `<host key>` is the host's 32-byte Ed25519 DHT public key in z-base-32 (52 characters).
- The secret stays in the `#fragment`. Browsers and proxies never send fragments, and the
  secret never goes to the DHT or to the relay.
- `findInvite` finds all three forms inside pasted text. Older base64 invite codes still work.

## What is encrypted where

1. **Transport (direct).** A Noise IK handshake (the dialer already knows the host's static key
   from the invite), carried through the DHT. Then a secretstream (XChaCha20-Poly1305) over UDX,
   hyperdht's reliable UDP. Ephemeral keys give the session **forward secrecy**. The handshake
   only completes with whoever holds the private key matching the invite's key.
   Someone in the middle (a DHT node, a router, a forged announcement) can't pose as the host.
2. **Transport (relay).** TLS to Cloudflare. Cloudflare terminates the TLS, so it sees the
   frames, but they are sealed by layer 3.
3. **App layer (always, on both transports).** Every message body is sealed with AES-256-GCM,
   using keys derived from the invite secret with HKDF. Joining needs an HMAC proof of the
   secret plus an Ed25519 signature over the hub's challenge. This is unchanged. Even if the
   transport were broken, frames stay sealed and can't be forged.

Frames on the Noise stream are `[u32 length][u8 kind][payload]` (text, close, ping, pong). The
hub enforces the same limits on both transports: 1 MB per message (refused from the length
header alone, before it is buffered), 16 KB before auth, 32 pending handshakes, rate limits,
and the auth timeout. Close codes (4001 auth, 4008 closed, 4010 removed, …) travel in a close
frame, so a removed peer stops reconnecting over P2P exactly as it does over websockets.

## What the DHT and bootstrap nodes can see

- **Your IP address and port**, and the host's **public key**. The host announces under its
  key, and dialers look it up. Bootstrap and DHT nodes route those lookups and help with
  hole-punching, so they learn who is connecting to which key and when.
- **Not** the secret, the room name, people's names, or any message content.
- The host key is **fresh for every run**. It isn't persisted, because the invite secret
  changes every run anyway, so a stable key wouldn't keep invites stable. A long-lived key
  would only let DHT observers link your sessions together.
- By default this is the public Hyperswarm network (bootstrap: `node1-3.hyperdht.org`).
  Tests use a local testnet and never touch it.

## NAT traversal limits

Hole-punching works on most home and mobile networks. It fails when **both** sides are behind
randomizing (symmetric) NATs, and on networks that block UDP (some offices, schools, hotels).
Then the dial errors out (often within a second, e.g. `HOLEPUNCH_ABORTED`), or it is dropped
after **10 s**. The client then tries the relay in the invite, with no backoff. Whichever
transport worked is tried first on the next reconnect. With `p2p` (no relay), those friends
can't join. Use `auto`.

## Remaining risks

- **The invite is the key.** Anyone with the link can join until you replace it or close the
  room. The host key alone isn't enough (the secret is needed too), but it does reveal your IP
  address to whoever has it.
- **IP exposure.** Direct connections show the host and friends each other's IP addresses
  (the relay hides them from each other, but Cloudflare sees both).
- **Availability.** The DHT is a public commons. An attacker who floods it could slow lookups
  down; the relay fallback covers that.
- **Native code.** `sodium-native` and `udx-native` ship prebuilt binaries (prebuildify). They
  load without install scripts. If no binary exists for a platform, P2P is unavailable and
  `auto` falls back to the relay alone.
