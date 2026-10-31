import { describe, expect, it } from 'vitest';
import { parseInput, parseLocation } from '../src/core/mentions.js';
import { CLAUDE_AGENT, type PeerInfo } from '../src/protocol.js';

const peers: PeerInfo[] = [
  { peerId: 'me', name: 'kay', agent: true, shares: [{ name: 'app', writable: true }] },
  { peerId: 'b', name: 'bob', agent: true, shares: [{ name: 'api', writable: false }] },
  { peerId: 'c', name: 'cat', agent: false, shares: [] },
];

describe('parseInput', () => {
  it('handles empty, chat and commands', () => {
    expect(parseInput('   ', 'me', peers)).toEqual({ kind: 'empty' });
    expect(parseInput('hello @bob', 'me', peers)).toEqual({ kind: 'chat', text: 'hello @bob' });
    expect(parseInput(':Follow bob', 'me', peers)).toEqual({ kind: 'command', name: 'follow', args: ['bob'] });
  });

  it('routes @claude to self', () => {
    expect(parseInput('@claude fix tests', 'me', peers)).toMatchObject({ kind: 'agent', targets: ['me'], prompt: 'fix tests' });
  });

  it('routes @claude:peer to that peer case-insensitively', () => {
    expect(parseInput('@claude:BOB look', 'me', peers)).toMatchObject({ targets: ['b'], unknown: [] });
  });

  it('routes @claudes to every agent, deduped', () => {
    expect(parseInput('@claudes @claude review', 'me', peers)).toMatchObject({ targets: ['me', 'b'] });
  });

  it('reports unknown peers', () => {
    expect(parseInput('@claude:zed hi', 'me', peers)).toMatchObject({ targets: [], unknown: ['zed'] });
  });

  it('treats a bare mention as chat', () => {
    expect(parseInput('@claude', 'me', peers)).toEqual({ kind: 'chat', text: '@claude' });
  });
});

describe('parseLocation', () => {
  it('parses peer:share/path', () => {
    expect(parseLocation('bob:api/src/a.ts', peers)).toEqual({ owner: 'b', share: 'api', path: 'src/a.ts' });
    expect(parseLocation('bob:api', peers)).toEqual({ owner: 'b', share: 'api', path: '' });
  });

  it('rejects unknown peers or shares', () => {
    expect(parseLocation('bob:nope/x', peers)).toBeUndefined();
    expect(parseLocation('zed:api/x', peers)).toBeUndefined();
    expect(parseLocation('garbage', peers)).toBeUndefined();
  });
});

describe('parseInput: @person grammar (BLG-443)', () => {
  const codex = { runtime: 'codex', label: 'Codex' } as const;
  const claude = { runtime: 'claude', label: 'Claude' } as const;
  const room: PeerInfo[] = [
    { peerId: 'me', name: 'kay', agent: true, shares: [], agents: [claude], defaultAgent: claude },
    { peerId: 'b', name: 'bob', agent: true, shares: [], agents: [codex, claude], defaultAgent: codex },
    { peerId: 'o', name: 'old', agent: true, shares: [] },
    { peerId: 'c', name: 'cat', agent: false, shares: [] },
  ];

  it('@bob asks bob\'s published default agent', () => {
    expect(parseInput('@bob fix it', 'me', room)).toMatchObject({ kind: 'agent', prompt: 'fix it', targets: ['b'], to: [{ peerId: 'b', agent: codex }], notes: [] });
    expect(parseInput('@BOB hi', 'me', room)).toMatchObject({ to: [{ peerId: 'b', agent: codex }] });
  });

  it('@bob:codex and @bob:claude pick one of bob\'s agents', () => {
    expect(parseInput('@bob:claude hi', 'me', room)).toMatchObject({ to: [{ peerId: 'b', agent: claude }], notes: [] });
    expect(parseInput('@bob:codex hi', 'me', room)).toMatchObject({ to: [{ peerId: 'b', agent: codex }], notes: [] });
  });

  it('an agent they do not run falls back to their default, with a note', () => {
    const p = parseInput('@kay:codex hi', 'me', room);
    expect(p).toMatchObject({ to: [{ peerId: 'me', agent: claude }] });
    expect(p.kind === 'agent' && p.notes[0]).toMatch(/don't run codex/);
  });

  it('a person without a published default gets their Claude, with a note', () => {
    const p = parseInput('@old look', 'me', room);
    expect(p).toMatchObject({ to: [{ peerId: 'o', agent: CLAUDE_AGENT }] });
    expect(p.kind === 'agent' && p.notes).toEqual(["old hasn't chosen a default agent, so their Claude will answer"]);
  });

  it('@agents hits every person\'s default; @claudes every Claude, as before', () => {
    expect(parseInput('@agents review', 'me', room)).toMatchObject({
      targets: ['me', 'b', 'o'],
      to: [{ peerId: 'me', agent: claude }, { peerId: 'b', agent: codex }, { peerId: 'o', agent: CLAUDE_AGENT }],
    });
    expect(parseInput('@claudes review', 'me', room)).toMatchObject({ targets: ['me', 'b', 'o'], to: [{ agent: claude }, { agent: claude }, { agent: CLAUDE_AGENT }] });
  });

  it('old forms still parse exactly as before', () => {
    expect(parseInput('@claude fix tests', 'me', room)).toMatchObject({ kind: 'agent', targets: ['me'], unknown: [], prompt: 'fix tests' });
    expect(parseInput('@claude:bob look', 'me', room)).toMatchObject({ targets: ['b'], to: [{ peerId: 'b', agent: claude }], unknown: [] });
    expect(parseInput('@claudes @claude review', 'me', room)).toMatchObject({ targets: ['me', 'b', 'o'] });
    expect(parseInput('@claude:zed hi', 'me', room)).toMatchObject({ targets: [], unknown: ['zed'] });
    expect(parseInput('@claude', 'me', room)).toEqual({ kind: 'chat', text: '@claude' });
    expect(parseInput('hello @bob', 'me', room)).toEqual({ kind: 'chat', text: 'hello @bob' });
  });

  it('mixes people and aliases, each asked once', () => {
    expect(parseInput('@bob @claude:bob @kay hi', 'me', room)).toMatchObject({ targets: ['b', 'me'], to: [{ peerId: 'b', agent: codex }, { peerId: 'me' }] });
  });

  it('an unknown name is reported with a suggestion, not silently chat', () => {
    expect(parseInput('@bbo fix it', 'me', room)).toMatchObject({ kind: 'agent', targets: [], unknown: ['bbo'], notes: ['Nobody named "bbo" is here. Did you mean @bob?'] });
    expect(parseInput('@bob @zzzzz hi', 'me', room)).toMatchObject({ targets: ['b'], unknown: ['zzzzz'], notes: ['Nobody named "zzzzz" is here'] });
    expect(parseInput('@zed', 'me', room)).toEqual({ kind: 'chat', text: '@zed' });
  });

  it('a task key is not a person', () => {
    expect(parseInput('@BLG-24 is done', 'me', room)).toEqual({ kind: 'chat', text: '@BLG-24 is done' });
  });

  it('a person without an agent on is said, not asked', () => {
    expect(parseInput('@cat hi', 'me', room)).toMatchObject({ kind: 'agent', targets: [], notes: ['cat has no agent on right now'] });
  });

  it('a peer named claude: the alias wins, with a hint; @claude:claude reaches them', () => {
    const withClaude: PeerInfo[] = [...room, { peerId: 'x', name: 'claude', agent: true, shares: [] }];
    const p = parseInput('@claude hi', 'me', withClaude);
    expect(p).toMatchObject({ targets: ['me'] });
    expect(p.kind === 'agent' && p.notes).toEqual(['"@claude" means your own Claude. To ask the person named claude, write @claude:claude']);
    expect(parseInput('@claude:claude hi', 'me', withClaude)).toMatchObject({ targets: ['x'] });
  });

  describe('agent tags (BLG-520)', () => {
    const runsCodex = { runs: (rt: string) => rt === 'codex' };
    const named = (raw: string, opts = {}) => {
      const p = parseInput(raw, 'me', room, opts);
      return p.kind === 'agent' ? p.to.map((t) => ({ peerId: t.peerId, runtime: t.agent.runtime, named: Boolean(t.named) })) : p;
    };

    it('@codex is your own Codex when your Mac runs it, listed on your card or not', () => {
      expect(named('@codex fix the test', runsCodex)).toEqual([{ peerId: 'me', runtime: 'codex', named: true }]);
      expect(parseInput('@codex fix the test', 'me', room, runsCodex)).toMatchObject({ prompt: 'fix the test', notes: [] });
    });

    it('@codex when your Mac has no Codex: your default, with a note', () => {
      const p = parseInput('@codex hi', 'me', room);
      expect(p).toMatchObject({ to: [{ peerId: 'me', agent: claude }] });
      expect(p.kind === 'agent' && p.notes[0]).toMatch(/don't run codex/);
    });

    it('@bob:codex and @bob:claude are named; @bob and the @claude forms are not', () => {
      expect(named('@bob:codex hi')).toEqual([{ peerId: 'b', runtime: 'codex', named: true }]);
      expect(named('@bob:claude hi')).toEqual([{ peerId: 'b', runtime: 'claude', named: true }]);
      expect(named('@bob hi')).toEqual([{ peerId: 'b', runtime: 'codex', named: false }]);
      expect(named('@claude:bob hi')).toEqual([{ peerId: 'b', runtime: 'claude', named: false }]);
      expect(named('@claude hi')).toEqual([{ peerId: 'me', runtime: 'claude', named: false }]);
      expect(named('@codex @bob:codex both', runsCodex)).toEqual([
        { peerId: 'me', runtime: 'codex', named: true },
        { peerId: 'b', runtime: 'codex', named: true },
      ]);
    });

    it('a person named codex is still the person', () => {
      const withCodex: PeerInfo[] = [...room, { peerId: 'x', name: 'codex', agent: true, shares: [] }];
      expect(parseInput('@codex hi', 'me', withCodex, runsCodex)).toMatchObject({ targets: ['x'] });
    });
  });
});
