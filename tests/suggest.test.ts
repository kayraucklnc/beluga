import { describe, expect, it } from 'vitest';
import type { PeerInfo } from '../src/protocol.js';
import { suggest } from '../src/ui/suggest.js';

const peers: PeerInfo[] = [
  { peerId: 'me', name: 'kay', agent: true, shares: [{ name: 'app', writable: true }] },
  { peerId: 'b', name: 'bob', agent: true, shares: [{ name: 'api', writable: false }] },
  { peerId: 'c', name: 'cat', agent: false, shares: [] },
];
const values = (buffer: string) => suggest(buffer, peers, 'me').map((s) => s.value);

describe('suggest', () => {
  it('lists matching commands as soon as you type /', () => {
    expect(values('/').length).toBe(6);
    expect(values('/fo')).toEqual(['/follow ']);
    expect(values('/he')).toEqual(['/help']);
    expect(suggest('/fo', peers, 'me')[0]).toMatchObject({ label: '/follow <name>', hint: expect.stringContaining('follow') });
    expect(values('/zzz')).toEqual([]);
    expect(values('//literal')).toEqual([]);
  });

  it('completes people for /follow and /trust (never yourself)', () => {
    expect(values('/follow ')).toEqual(['/follow bob', '/follow cat']);
    expect(values('/trust b')).toEqual(['/trust bob']);
    expect(values('/follow bob extra')).toEqual([]);
  });

  it('completes shared folders for /open and options for /policy', () => {
    expect(values('/open ')).toEqual(['/open kay:app/', '/open bob:api/']);
    expect(values('/open bob')).toEqual(['/open bob:api/']);
    expect(values('/policy a')).toEqual(['/policy ask', '/policy auto']);
    expect(values('/clear x')).toEqual([]);
  });

  it('suggests Claude mentions for @', () => {
    expect(values('@')).toEqual(['@claude ', '@claude:bob ', '@claudes ']);
    expect(values('hey @claude:')).toEqual(['hey @claude:bob ']);
    expect(values('@claude')).toEqual(['@claude:bob ', '@claudes ']); // exact match is not re-suggested
    expect(values('email@x')).toEqual([]);
    expect(values('plain text')).toEqual([]);
  });
});
