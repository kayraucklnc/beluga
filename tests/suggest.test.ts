import { describe, expect, it } from 'vitest';
import type { PeerInfo } from '../src/protocol.js';
import { openTarget, suggest } from '../src/ui/suggest.js';

const peers: PeerInfo[] = [
  { peerId: 'me', name: 'kay', agent: true, shares: [{ name: 'app', writable: true }] },
  { peerId: 'b', name: 'bob', agent: true, shares: [{ name: 'api', writable: false }] },
  { peerId: 'c', name: 'cat', agent: false, shares: [] },
];
const dirCache = {
  'b:api/': [
    { name: 'src', dir: true, size: 0 },
    { name: 'README.md', dir: false, size: 10 },
    { name: 'NOTES.md', dir: false, size: 5 },
  ],
  'b:api/src': [{ name: 'app.ts', dir: false, size: 1 }],
};
const ctx = { peers, selfId: 'me', dirCache };
const values = (buffer: string) => suggest(buffer, ctx).map((s) => s.value);

describe('suggest', () => {
  it('lists matching commands as soon as you type /', () => {
    expect(values('/').length).toBe(39); // every command, shown in a scrolling list
    expect(values('/fo')).toEqual(['/fork ', '/follow ']);
    expect(values('/he')).toEqual(['/help']);
    expect(suggest('/fol', ctx)[0]).toMatchObject({ label: '/follow <name>', hint: expect.stringContaining('follow') });
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

  it('autocompletes files and folders inside a share for /open', () => {
    expect(values('/open bob:api/')).toEqual(['/open bob:api/src/', '/open bob:api/README.md', '/open bob:api/NOTES.md']);
    expect(values('/open bob:api/re')).toEqual(['/open bob:api/README.md']);
    expect(values('/open bob:api/src/')).toEqual(['/open bob:api/src/app.ts']);
    expect(values('/open bob:api/nothing-cached/')).toEqual([]);
    const [dir, file] = suggest('/open bob:api/', ctx);
    expect(dir).toMatchObject({ label: 'src/', enter: 'complete' });
    expect(file).toMatchObject({ label: 'README.md', enter: 'submit' });
  });

  it('knows which folder to fetch for /open', () => {
    expect(openTarget('/open bob:api/', peers)).toEqual({ owner: 'b', share: 'api', path: '' });
    expect(openTarget('/open bob:api/src/ap', peers)).toEqual({ owner: 'b', share: 'api', path: 'src' });
    expect(openTarget('/open bob:nope/', peers)).toBeUndefined();
    expect(openTarget('/open zed:api/', peers)).toBeUndefined();
    expect(openTarget('/open bob', peers)).toBeUndefined();
  });

  it('suggests Claude mentions for @', () => {
    expect(values('@')).toEqual(['@claude ', '@claude:bob ', '@claudes ']);
    expect(values('hey @claude:')).toEqual(['hey @claude:bob ']);
    expect(values('@claude')).toEqual(['@claude:bob ', '@claudes ']); // exact match is not re-suggested
    expect(values('email@x')).toEqual([]);
    expect(values('plain text')).toEqual([]);
  });
});
