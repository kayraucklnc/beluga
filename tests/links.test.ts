import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AppState, initialState, reduce } from '../src/core/store.js';
import type { PeerInfo } from '../src/protocol.js';
import { chatLinkModel } from '../src/ui/link-zones.js';
import { type LinkTarget, chatLinkify, findCandidates, linkHint, linkSpans, linkifyLine, plausiblePath, resolveLocal, resolverFor, setLinkEnv, statCached } from '../src/ui/links.js';
import { renderMarkdown } from '../src/ui/markdown.js';
import { modifiersOf, parseMouse, takePastes } from '../src/ui/mouse.js';
import { scrollForLine } from '../src/ui/link-actions.js';
import { renderLog } from '../src/ui/format.js';

const values = (text: string) => findCandidates(text).map((c) => [c.kind, c.value, c.line]);

describe('finding paths and URLs in text', () => {
  it('finds files, folders, line numbers, home and absolute paths', () => {
    expect(values('see src/ui/App.tsx:42 and README.md.')).toEqual([
      ['path', 'src/ui/App.tsx', 42],
      ['path', 'README.md', undefined],
    ]);
    expect(values('in src/ui/ or ./x/y, ~/Desktop/a.png, /etc/hosts')).toEqual([
      ['path', 'src/ui/', undefined],
      ['path', './x/y', undefined],
      ['path', '~/Desktop/a.png', undefined],
      ['path', '/etc/hosts', undefined],
    ]);
    expect(values('foo.ts#L12 and a.ts:3:9')).toEqual([
      ['path', 'foo.ts', 12],
      ['path', 'a.ts', 3],
    ]);
  });

  it('finds URLs without trailing punctuation and skips their parts', () => {
    expect(values('docs at https://example.com/a/b.html, ok')).toEqual([['url', 'https://example.com/a/b.html', undefined]]);
  });

  it('ignores words, numbers, versions and mentions', () => {
    expect(values('hello world 3.5 v1.2 1/2 @claude:bob and/or')).toEqual([['path', 'and/or', undefined]]);
    expect(plausiblePath('and')).toBe(false);
    expect(plausiblePath('/')).toBe(false);
    expect(plausiblePath('Makefile.am')).toBe(true);
  });
});

describe('resolving and linkifying', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'klaud-links-'));
  mkdirSync(path.join(tmp, 'src', 'ui'), { recursive: true });
  writeFileSync(path.join(tmp, 'README.md'), '# hi');
  writeFileSync(path.join(tmp, 'src', 'ui', 'App.tsx'), 'x');

  it('only links paths that exist, against the given roots', () => {
    expect(resolveLocal('README.md', [tmp])).toEqual({ path: path.join(tmp, 'README.md'), dir: false });
    expect(resolveLocal('src/ui/', [tmp])).toEqual({ path: path.join(tmp, 'src', 'ui'), dir: true });
    expect(resolveLocal('nope.md', [tmp])).toBeUndefined();
    expect(resolveLocal(path.join(tmp, 'README.md'), [])).toEqual({ path: path.join(tmp, 'README.md'), dir: false });
    expect(statCached(path.join(tmp, 'missing'))).toBeUndefined();
  });

  it('splits segments around links and keeps their style', () => {
    const resolve = (c: { kind: string; value: string }): LinkTarget | undefined => (c.value === 'README.md' ? { kind: 'local', path: '/r/README.md', dir: false } : undefined);
    const line = linkifyLine([{ text: 'open README.md now', bold: true }], resolve);
    expect(line.map((s) => s.text)).toEqual(['open ', 'README.md', ' now']);
    expect(line[1]?.link).toEqual({ kind: 'local', path: '/r/README.md', dir: false });
    expect(line[1]?.bold).toBe(true);
    expect(linkSpans([{ text: '  ' }, ...line])).toEqual([{ x0: 7, x1: 15, link: { kind: 'local', path: '/r/README.md', dir: false } }]);
    const untouched = [{ text: 'nothing here' }];
    expect(linkifyLine(untouched, resolve)).toBe(untouched);
  });

  it('keeps Markdown link targets so they can be resolved', () => {
    const [line] = renderMarkdown('see [the docs](https://x.dev/a) and [img](klaud-attachment:p1/a.png)', 80);
    const hrefs = line?.filter((s) => s.link).map((s) => s.link);
    expect(hrefs).toEqual([
      { kind: 'href', href: 'https://x.dev/a' },
      { kind: 'href', href: 'klaud-attachment:p1/a.png' },
    ]);
  });

  const peers: PeerInfo[] = [
    { peerId: 'me', name: 'kay', shares: [], agent: true },
    { peerId: 'bob', name: 'bob', shares: [{ name: 'web', writable: false }], agent: true },
  ] as unknown as PeerInfo[];
  const state = (): AppState => reduce(reduce(initialState('room'), { type: 'peers', peers }), { type: 'welcome', self: peers[0]! });
  const chat = (from: string, text: string) => ({ id: '1', type: 'chat' as const, channel: 'room', from, name: from, text, ts: 0, byAgent: false });

  it('every piece of a URL wrapped over lines opens the whole URL', () => {
    setLinkEnv({ roots: () => [tmp] });
    const url = 'https://github.com/kayraucklnc/klaud/pull/31/files#diff-0123456789abcdef0123456789abcdef';
    const lines = renderLog([chat('me', `see ${url} and [here](https://a.io) or [here](https://b.io)`)], 30, { linkify: chatLinkify(state()) });
    const links = lines.flatMap((l) => l.filter((s) => s.link).map((s) => (s.link?.kind === 'url' ? s.link.url : '')));
    expect(links.filter((u) => u === url).length).toBeGreaterThan(1);
    expect(links.every((u) => u === url || u === 'https://a.io' || u === 'https://b.io')).toBe(true);
    expect(links).toContain('https://a.io');
    expect(links).toContain('https://b.io');
  });

  it('resolves your messages on this computer and friends’ through their shares', () => {
    setLinkEnv({ roots: () => [tmp] });
    const mine = renderLog([chat('me', 'look at `src/ui/App.tsx:3` and https://a.io')], 80, { linkify: (i) => (l) => linkifyLine(l, resolverFor(state(), i)!) });
    const links = mine.flatMap((l) => l.filter((s) => s.link).map((s) => s.link));
    expect(links).toEqual([
      { kind: 'local', path: path.join(tmp, 'src', 'ui', 'App.tsx'), dir: false, line: 3 },
      { kind: 'url', url: 'https://a.io' },
    ]);
    const bob = resolverFor(state(), chat('bob', ''))!;
    expect(bob({ kind: 'path', value: 'web/src/a.ts', start: 0, end: 0 })).toEqual({ kind: 'peer', owner: 'bob', share: 'web', path: 'src/a.ts' });
    expect(bob({ kind: 'path', value: 'other/a.ts', start: 0, end: 0 })).toBeUndefined();
    expect(bob({ kind: 'href', value: 'klaud-attachment:bob/x.png' })).toEqual({ kind: 'attachment', owner: 'bob', file: 'x.png', label: '' });
    expect(resolverFor(state(), { id: 's', type: 'system', channel: 'room', text: '', ts: 0, level: 'info' })).toBeUndefined();
  });

  it('describes links for the bottom bar', () => {
    expect(linkHint({ kind: 'local', path: '/p/src/App.tsx', dir: false, line: 42 }, '/p')).toBe('Open src/App.tsx:42 · click (⌥-click)');
    expect(linkHint({ kind: 'local', path: '/p/src', dir: true }, '/p')).toMatch(/^Browse src\//);
    expect(linkHint({ kind: 'url', url: 'https://a.io' })).toContain('browser');
    expect(linkHint({ kind: 'attachment', owner: 'b', file: 'a.png', label: '📎 image 1 (png, 1K)' })).toBe('View image 1 (png, 1K) · click');
    setLinkEnv({ roots: () => ['/room/project'] });
    expect(linkHint({ kind: 'local', path: '/room/project/README.md', dir: false })).toBe('Open README.md · click (⌥-click)');
    expect(scrollForLine(42)).toBe(38);
    expect(scrollForLine(1)).toBe(0);
  });
});

describe('chat link zones', () => {
  const link: LinkTarget = { kind: 'url', url: 'https://a.io' };
  const lines = [[{ text: 'old' }], [{ text: 'go ' }, { text: 'https://a.io', link }], [{ text: 'last' }]];

  it('places zones where bottom-aligned lines are drawn, and finds the hovered one', () => {
    const m = chatLinkModel(lines, { x: 10, top: 5, rows: 10, scroll: 0 }, { x: 14, y: 13, alt: true });
    // 3 lines in 10 rows: they sit on rows 12..14.
    expect(m.zones).toEqual([expect.objectContaining({ x0: 13, x1: 24, y: 13, action: { type: 'open_link', link } })]);
    expect(m.hover).toEqual({ line: 1, x0: 3, x1: 14, alt: true });
    expect(m.zone?.hint).toContain('https://a.io');
  });

  it('follows scrolling', () => {
    const m = chatLinkModel(lines, { x: 0, top: 0, rows: 1, scroll: 1 }, { x: 4, y: 0 });
    expect(m.zones[0]?.y).toBe(0);
    expect(m.hover?.line).toBe(1);
    expect(chatLinkModel(lines, { x: 0, top: 0, rows: 1, scroll: 0 }).zones).toEqual([]);
  });
});

describe('mouse modifiers and pastes', () => {
  it('reads Shift, Option and Ctrl from SGR reports', () => {
    expect(modifiersOf(0)).toEqual({});
    expect(modifiersOf(8)).toEqual({ alt: true });
    expect(modifiersOf(4 | 16)).toEqual({ shift: true, ctrl: true });
    expect(parseMouse('\x1b[<8;3;4M').events).toEqual([{ x: 2, y: 3, button: 'left', kind: 'press', alt: true }]);
    // Pointer movement with Option held.
    expect(parseMouse('\x1b[<43;3;4M').events).toEqual([{ x: 2, y: 3, button: 'move', kind: 'press', alt: true }]);
    expect(parseMouse('\x1b[<72;1;1M').events[0]).toMatchObject({ button: 'wheelUp', alt: true });
  });

  it('offers complete pastes and keeps the rest of the input', () => {
    const seen: string[] = [];
    const out = takePastes('a\x1b[200~\x1b[201~b\x1b[200~hi\x1b[201~', (t) => {
      seen.push(t);
      return t === '';
    });
    expect(seen).toEqual(['', 'hi']);
    expect(out).toBe('ab\x1b[200~hi\x1b[201~');
    expect(takePastes('x\x1b[200~hi\x1b[201~', () => false, true)).toBe('xhi');
    expect(takePastes('plain', () => true)).toBe('plain');
  });
});
