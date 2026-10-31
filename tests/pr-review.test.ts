import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addressCommentsPrompt, parseConversation, postArgs } from '../src/workspaces/pr-review.js';
import { readExcerpt } from '../src/workspaces/excerpt.js';
import { editorCommand } from '../src/workspaces/open-code.js';
import { langOf, parseCodeRef, parseHunk, parseLineList, refWindow } from '../src/shared/code-ref.js';

const answer = {
  data: {
    viewer: { login: 'kayra' },
    repository: {
      pullRequest: {
        number: 42,
        url: 'https://github.com/o/r/pull/42',
        comments: { totalCount: 1, nodes: [{ id: 'C1', author: { login: 'mia' }, body: 'Looks good overall', createdAt: '2026-10-30T10:00:00Z', url: 'https://github.com/o/r/pull/42#c1' }] },
        reviews: {
          totalCount: 3,
          nodes: [
            { id: 'R1', author: { login: 'mia' }, body: '', state: 'COMMENTED', submittedAt: '2026-10-30T10:05:00Z', url: 'u' },
            { id: 'R2', author: { login: 'bob' }, body: 'Please rename', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-30T11:00:00Z', url: 'u2' },
            { id: 'R3', author: { login: 'kayra' }, body: '', state: 'APPROVED', submittedAt: '2026-10-30T12:00:00Z', url: 'u3' },
          ],
        },
        reviewThreads: {
          totalCount: 2,
          nodes: [
            {
              id: 'T1', path: 'src/a.ts', line: 14, startLine: 12, originalLine: 14, originalStartLine: 12, isResolved: false, isOutdated: false,
              comments: { nodes: [{ id: 'TC1', author: { login: 'mia' }, body: 'Why a loop here?', createdAt: '2026-10-30T10:04:00Z', url: 'tu', diffHunk: '@@ -10,3 +10,5 @@\n a\n+b\n+c' }, { id: 'TC2', author: { login: 'kayra' }, body: 'Fair', createdAt: '2026-10-30T10:30:00Z', url: 'tu2' }] },
            },
            { id: 'T2', path: 'src/b.ts', line: null, originalLine: 3, isResolved: true, isOutdated: true, comments: { nodes: [] } },
          ],
        },
      },
    },
  },
};

describe('PR conversation', () => {
  it('reads comments, reviews worth showing, and threads with their code', () => {
    const c = parseConversation(JSON.stringify(answer))!;
    expect(c.number).toBe(42);
    expect(c.comments).toHaveLength(1);
    // An empty COMMENTED review is only its threads; an empty approval still says something.
    expect(c.reviews.map((r) => [r.id, r.state, r.mine ?? false])).toEqual([
      ['R2', 'CHANGES_REQUESTED', false],
      ['R3', 'APPROVED', true],
    ]);
    // A thread with no comments left is dropped.
    expect(c.threads).toHaveLength(1);
    const t = c.threads[0]!;
    expect(t).toMatchObject({ path: 'src/a.ts', line: 14, startLine: 12, resolved: false, diffHunk: '@@ -10,3 +10,5 @@\n a\n+b\n+c' });
    expect(t.comments[1]!.mine).toBe(true);
    expect(c.more).toBeUndefined();
  });

  it('refuses what isn’t an answer', () => {
    expect(parseConversation('nope')).toBeUndefined();
    expect(parseConversation('{"data":{"repository":{"pullRequest":null}}}')).toBeUndefined();
  });

  it('posts through gh without a shell', () => {
    expect(postArgs(7, { kind: 'comment', body: '  hi $(rm -rf ~) ' })).toEqual(['pr', 'comment', '7', '--body', 'hi $(rm -rf ~)']);
    const reply = postArgs(7, { kind: 'reply', thread: 'T1', body: 'ok' });
    expect(reply.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(reply).toContain('thread=T1');
    expect(reply).toContain('body=ok');
    expect(postArgs(7, { kind: 'resolve', thread: 'T1' }).join(' ')).toContain('resolveReviewThread');
    expect(postArgs(7, { kind: 'unresolve', thread: 'T1' }).join(' ')).toContain('unresolveReviewThread');
    expect(() => postArgs(7, { kind: 'comment', body: '   ' })).toThrow();
  });

  it('tells Claude what one thread said and where', () => {
    const c = parseConversation(JSON.stringify(answer))!;
    const prompt = addressCommentsPrompt({ number: 42, url: 'x' }, c.threads[0]);
    expect(prompt).toContain('src/a.ts:12-14');
    expect(prompt).toContain('@mia: Why a loop here?');
    expect(prompt).toContain('beluga-code');
  });
});

describe('beluga-code blocks', () => {
  it('parses a location, highlights and a note', () => {
    expect(parseCodeRef('src/a.ts:10-20\nhighlight: 12-13, 18\nnote: the loop')).toEqual({ path: 'src/a.ts', from: 10, to: 20, highlight: [12, 13, 18], note: 'the loop' });
    expect(parseCodeRef('src/a.ts#L5-L7')).toEqual({ path: 'src/a.ts', from: 5, to: 7, highlight: [] });
    expect(parseCodeRef('src/a.ts')).toEqual({ path: 'src/a.ts', highlight: [] });
    expect(parseCodeRef('not a path at all')).toBeUndefined();
    expect(parseLineList('3-1, x, 9')).toEqual([1, 2, 3, 9]);
  });

  it('reads a window around what is highlighted', () => {
    expect(refWindow({ path: 'a', highlight: [20, 22] })).toEqual({ from: 17, to: 25 });
    expect(refWindow({ path: 'a', from: 5, to: 9, highlight: [] })).toEqual({ from: 5, to: 9 });
    expect(refWindow({ path: 'a', highlight: [] })).toEqual({ from: 1, to: 30 });
  });

  it('numbers a diff hunk on both sides', () => {
    expect(parseHunk('@@ -10,2 +20,3 @@ fn\n a\n-b\n+c\n+d')).toEqual([
      { kind: 'ctx', text: 'a', old: 10, new: 20 },
      { kind: 'del', text: 'b', old: 11 },
      { kind: 'add', text: 'c', new: 21 },
      { kind: 'add', text: 'd', new: 22 },
    ]);
    expect(langOf('x/y.tsx')).toBe('tsx');
    expect(langOf('Makefile')).toBeUndefined();
  });
});

describe('excerpts', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'beluga-excerpt-'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/a.ts'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(path.join(root, '.env'), 'TOKEN=x\n');
  const outside = mkdtempSync(path.join(tmpdir(), 'beluga-outside-'));
  writeFileSync(path.join(outside, 'secret.txt'), 'no');
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));

  it('reads lines of a file in the worktree', async () => {
    const e = await readExcerpt(root, 'src/a.ts', 48, 60);
    expect(e).toMatchObject({ path: 'src/a.ts', from: 48, to: 50, total: 50 });
    expect(e.lines).toEqual(['line 48', 'line 49', 'line 50']);
  });

  it('reads a worktree that lives in ~/.beluga (where Beluga keeps them)', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'beluga-home-'));
    const wt = path.join(home, '.beluga', 'workspaces', 'p', 'w');
    mkdirSync(path.join(wt, 'src'), { recursive: true });
    writeFileSync(path.join(wt, 'src/auth.ts'), 'export const a = 1;\n');
    const was = process.env.HOME;
    process.env.HOME = home;
    try {
      expect((await readExcerpt(wt, 'src/auth.ts')).lines).toEqual(['export const a = 1;']);
    } finally {
      process.env.HOME = was;
    }
  });

  it('never reads outside it or a secret', async () => {
    await expect(readExcerpt(root, '../../etc/passwd')).rejects.toThrow(/isn’t in this worktree/);
    await expect(readExcerpt(root, 'link.txt')).rejects.toThrow(/isn’t in this worktree/);
    await expect(readExcerpt(root, '.env')).rejects.toThrow(/secrets/);
  });
});

describe('opening code at a line', () => {
  it('uses the first editor that can jump to a line', () => {
    expect(editorCommand('/w/a.ts', 12, (n) => (n === 'code' ? '/usr/local/bin/code' : undefined))).toEqual({ cmd: '/usr/local/bin/code', args: ['-g', '/w/a.ts:12'] });
    expect(editorCommand('/w/a.ts', undefined, (n) => (n === 'zed' ? 'zed' : undefined))).toEqual({ cmd: 'zed', args: ['/w/a.ts'] });
    expect(editorCommand('/w/a.ts', 3, () => undefined)).toBeUndefined();
  });
});
