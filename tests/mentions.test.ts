import { describe, expect, it } from 'vitest';
import { parseInput, parseLocation } from '../src/core/mentions.js';
import type { PeerInfo } from '../src/protocol.js';

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
