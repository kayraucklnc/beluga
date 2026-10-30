import { describe, expect, it } from 'vitest';
import type { FsEntry } from '../src/protocol.js';
import { linkMentions, parseMentionHref, resolveMention, splitMentions, type MentionWorld } from '../packages/mac/src/chat/mentions.js';
import { mentionDir, suggest, typedMention } from '../src/ui/suggest.js';

/** "@mia", "@bob-api", "@add-auth", "@src/", "@src/auth.ts": pills when they name someone or something. */

const entry = (name: string, dir: boolean): FsEntry => ({ name, dir, size: 0 }) as FsEntry;
const tree: Record<string, FsEntry[]> = { '': [entry('src', true), entry('README.md', false), entry('.env', false)], src: [entry('auth.ts', false), entry('routes', true)] };
const world: MentionWorld = {
  friends: [{ name: 'mia', peerId: 'mia-peer-0001' }, { name: 'Zoë Ray', peerId: 'zoe-peer-0001' }],
  peers: [{ name: 'bob', peerId: 'bob-peer-0001' }],
  projects: [{ name: 'bob-api', id: 'p1' }],
  workspaces: [{ label: '@add-auth', id: 'w1' }],
  entries: (dir) => tree[dir],
};

describe('what a mention names', () => {
  it('friends, Claudes, projects, worktrees, folders and files; anything else is just text', () => {
    expect(resolveMention('mia', world)).toEqual({ kind: 'friend', label: 'mia', id: 'mia-peer-0001' });
    expect(resolveMention('ZoëRay', world)).toEqual({ kind: 'friend', label: 'Zoë Ray', id: 'zoe-peer-0001' });
    expect(resolveMention('claude:bob', world)).toEqual({ kind: 'claude', label: 'bob’s agent', id: 'bob-peer-0001' });
    expect(resolveMention('bob-api', world)).toEqual({ kind: 'project', label: 'bob-api', id: 'p1' });
    expect(resolveMention('add-auth', world)).toEqual({ kind: 'workspace', label: 'add-auth', id: 'w1' });
    expect(resolveMention('src/', world)).toEqual({ kind: 'folder', label: 'src/', path: 'src/' });
    expect(resolveMention('src/auth.ts', world)).toEqual({ kind: 'file', label: 'src/auth.ts', path: 'src/auth.ts' });
    expect(resolveMention('README.md', world)).toMatchObject({ kind: 'file' });
    for (const nothing of ['nobody', 'src/missing.ts', 'README.md/', '../etc/passwd', '/etc/hosts']) expect(resolveMention(nothing, world)).toBeUndefined();
  });

  it('cuts a message into text and pills, leaving punctuation and e-mail addresses alone', () => {
    expect(splitMentions('hey @mia, check @src/auth.ts! mail me@mia.dev', world)).toEqual([
      { text: 'hey ' },
      { raw: '@mia', ref: { kind: 'friend', label: 'mia', id: 'mia-peer-0001' } },
      { text: ', check ' },
      { raw: '@src/auth.ts', ref: { kind: 'file', label: 'src/auth.ts', path: 'src/auth.ts' } },
      { text: '! mail me@mia.dev' },
    ]);
  });

  it('becomes a link the message draws as a pill; code stays code', () => {
    const md = linkMentions('@mia look at @bob-api\n```\n@mia in code\n```\nand `@mia` inline', world);
    const [first, ...rest] = md.split('\n');
    expect(first).toMatch(/^\[@mia\]\(beluga-mention:[^)]+\) look at \[@bob-api\]\(beluga-mention:[^)]+\)$/);
    expect(rest).toEqual(['```', '@mia in code', '```', 'and `@mia` inline']);
    const href = /\((beluga-mention:[^)]+)\)/.exec(first!)![1]!;
    expect(parseMentionHref(href)).toEqual({ kind: 'friend', label: 'mia', id: 'mia-peer-0001' });
    expect(parseMentionHref('beluga-mention:%7Bnope')).toBeUndefined();
  });
});

describe('typing a mention', () => {
  const ctx = { peers: [], selfId: 'me', friends: [{ name: 'mia', online: true }], projects: [{ name: 'bob-api' }], entries: (dir: string) => tree[dir] };
  it('knows what is being typed and which folder to list', () => {
    expect(typedMention('ask @src/au')).toBe('src/au');
    expect(typedMention('no mention')).toBeUndefined();
    expect(mentionDir('look at @src/au')).toBe('src');
    expect(mentionDir('@RE')).toBe('');
    expect(mentionDir('@claude:bob')).toBeUndefined();
    expect(mentionDir('@../x')).toBeUndefined();
  });

  it('offers friends, projects, and the worktree’s files and folders (no hidden ones)', () => {
    expect(suggest('@b', ctx).map((s) => s.label)).toEqual(['@bob-api']);
    expect(suggest('@R', ctx).map((s) => s.label)).toEqual(['@README.md']);
    expect(suggest('@s', ctx).map((s) => [s.label, s.value])).toEqual([['@src/', '@src/']]);
    expect(suggest('see @src/', ctx).map((s) => [s.label, s.value])).toEqual([
      ['@src/auth.ts', 'see @src/auth.ts '],
      ['@src/routes/', 'see @src/routes/'],
    ]);
    expect(suggest('@.e', ctx)).toEqual([]);
  });
});
