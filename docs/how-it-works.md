# How Klaud works


klaud is one core with two screens. The core (rooms, projects, Claude, terminals) runs in your terminal app's process, or as a background daemon that several screens attach to over a local WebSocket (`127.0.0.1`, a token in `~/.klaud/daemon.json` that only you can read). Every screen gets the same state and the same stream of changes and calls the same list of actions ([src/ipc/api.ts](../src/ipc/api.ts)); what each screen shows is its own. [docs/parity.md](parity.md) lists every action and where each screen offers it.

```
 your computer                                       bob's computer
┌──────────────────────────────┐                   ┌──────────────────────────────┐
│ klaud                        │   encrypted       │ klaud                        │
│  projects · chat · files      │◄─── frames ──────►│  projects · chat · files      │
│  your Claude (your login)     │ direct (P2P) or   │  bob's Claude (bob's login)   │
│                               │ via Cloudflare    │                               │
│  room hub (relay)             │                   │                               │
└──────────────────────────────┘                   └──────────────────────────────┘
```

- **Each Claude runs at home.** The [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) drives each person's own Claude Code, with their own subscription and permissions. Workspace conversations stay on your computer.
- **Room hub.** When you invite people, the host runs a small relay. Friends connect straight to it, peer to peer (Hyperswarm DHT with UDP hole-punching and Noise encryption). If their network blocks that, they fall back to a free Cloudflare quick tunnel that the invite also names. See [docs/p2p.md](p2p.md). The topology is a star through the host, not a mesh. The relay checks the invite secret, forwards messages, and keeps a short history for latecomers.
- **End-to-end encryption.** Every frame is sealed with AES-256-GCM, using keys derived from the invite secret with HKDF. Neither the tunnel nor the relay can read or forge messages. Direct connections are also encrypted underneath with Noise (forward secret), pinned to the host's key from the invite.
- **Limits.**
  - Up to 16 people per room and 120 messages per second per connection.
  - Messages up to 1 MB. Files are sent in 256 KB encrypted chunks, up to 200 MB.
  - Cloudflare quick tunnels have no uptime guarantee. Use ngrok or your own network if you need one.
- **Images** are decoded in a background thread and shrunk before they're drawn, so big photos never freeze the screen.
