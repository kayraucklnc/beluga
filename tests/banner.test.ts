import { describe, expect, it } from 'vitest';
import { initialState, reduce, type AppState } from '../src/core/store.js';
import type { PeerInfo } from '../src/protocol.js';
import { anyActivity, inviteBanner, peopleRows } from '../src/ui/banner.js';

const peers: PeerInfo[] = [
  { peerId: 'me', name: 'kay', agent: true, shares: [] },
  { peerId: 'b', name: 'bob', agent: true, shares: [] },
  { peerId: 'c', name: 'cat', agent: false, shares: [] },
];
const text = (lines: readonly (readonly { text: string }[])[]) => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const withPeers = (n: number): AppState =>
  reduce(reduce(initialState('r'), { type: 'peers', peers: peers.slice(0, n) }), { type: 'welcome', self: peers[0]! });
const hosting = (s: AppState, phase: 'tunnel' | 'reachable' | 'ready' | 'local' | 'failed', detail?: string, copied?: boolean) =>
  reduce(s, { type: 'hosting', hosting: { phase, detail, copied } });

describe('inviteBanner', () => {
  it('is empty for joiners', () => {
    expect(inviteBanner(withPeers(1), 60, 0)).toEqual([]);
  });

  it('walks through tunnel phases', () => {
    expect(text(inviteBanner(hosting(withPeers(1), 'tunnel', 'Downloading…'), 70, 0))).toContain('Opening a direct, end-to-end encrypted connection');
    const relay = reduce(hosting(withPeers(1), 'tunnel', 'Downloading…'), { type: 'prefs', prefs: { tunnel: 'cloudflared' } });
    expect(text(inviteBanner(relay, 70, 0))).toContain('Opening a secure tunnel');
    expect(text(inviteBanner(hosting(withPeers(1), 'tunnel', 'Downloading…'), 70, 0))).toContain('Downloading…');
    expect(text(inviteBanner(hosting(withPeers(1), 'reachable'), 70, 0))).toContain('Waiting for it to be reachable');
    expect(text(inviteBanner(hosting(withPeers(1), 'failed', 'no network'), 70, 0))).toContain('no network');
  });

  it('shows the copyable join command, then hides once friends arrive', () => {
    const ready = reduce(hosting(withPeers(1), 'ready', undefined, true), { type: 'invite', invite: 'https://x.trycloudflare.com#abc' });
    const out = text(inviteBanner(ready, 70, 0));
    expect(out).toContain('klaud join https://x.trycloudflare.com#abc');
    expect(out).toContain('copied to your clipboard');
    expect(text(inviteBanner(hosting(ready, 'ready', undefined, false), 70, 0))).toContain('Type /invite to copy it');
    expect(text(inviteBanner(hosting(ready, 'local'), 70, 0))).toContain('Local network only');
    expect(inviteBanner(reduce(ready, { type: 'peers', peers: peers.slice(0, 2) }), 70, 0)).toEqual([]);
  });
});

describe('peopleRows', () => {
  it("shows each person's Claude status", () => {
    let s = withPeers(3);
    s = reduce(s, { type: 'agent_event', owner: 'b', requestId: 'r', requester: 'me', event: 'started', text: '', ts: 1 });
    const rows = peopleRows(s, 0);
    expect(rows.map((r) => r.name)).toEqual(['kay', 'bob', 'cat']);
    expect(rows[0]).toMatchObject({ you: true });
    expect(text([rows[0]!.agent])).toContain('Claude ready');
    expect(text([rows[1]!.agent])).toContain('working for kay');
    expect(text([rows[2]!.agent])).toContain('no Claude');
    expect(anyActivity(s)).toBe(true);
    s = reduce(s, { type: 'agent_event', owner: 'b', requestId: 'x', requester: 'me', event: 'awaiting_approval', text: '', ts: 2 });
    expect(text([peopleRows(s, 0)[1]!.agent])).toContain('needs approval');
    expect(anyActivity(withPeers(1))).toBe(false);
    expect(anyActivity(hosting(withPeers(1), 'tunnel'))).toBe(true);
  });
});
