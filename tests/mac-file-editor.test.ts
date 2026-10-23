import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { alignTokens, indentOf } from '../packages/mac/src/views/reader/editor-model.js';
import { editSession, isDirty, markSaved, setDraft, startEditing, stopEditing, textToSave } from '../packages/mac/src/views/reader/edit-store.js';
import { doneRevealing, pendingLine, revealLine } from '../packages/mac/src/views/reader/reveal.js';
import { langOf } from '../packages/mac/src/views/reader/reader-model.js';

const tok = (s: string) => [{ content: s, style: { color: 'red' } }];

describe('the editor’s colors while you type', () => {
  it('keeps colors above and below the line you changed, and leaves that one plain', () => {
    const old = ['a', 'b', 'c', 'd'];
    const tokens = old.map(tok);
    const out = alignTokens(['a', 'bX', 'c', 'd'], old, tokens);
    expect(out[0]).toBe(tokens[0]);
    expect(out[1]).toBeUndefined();
    expect(out[2]).toBe(tokens[2]);
    expect(out[3]).toBe(tokens[3]);
  });

  it('follows lines that moved down when you add one', () => {
    const old = ['a', 'b', 'c'];
    const tokens = old.map(tok);
    const out = alignTokens(['a', 'new', 'b', 'c'], old, tokens);
    expect(out).toEqual([tokens[0], undefined, tokens[1], tokens[2]]);
  });

  it('is all plain before any colors come', () => {
    expect(alignTokens(['a', 'b'], ['a', 'b'], undefined)).toEqual([undefined, undefined]);
  });

  it('indents with what the file uses', () => {
    expect(indentOf('a\n\tb\n')).toBe('\t');
    expect(indentOf('a\n    b\n')).toBe('    ');
    expect(indentOf('a\n  b\n    c\n')).toBe('  ');
    expect(indentOf('flat')).toBe('  ');
  });
});

describe('edit sessions', () => {
  const at = { owner: 'me', share: 'ws-1', path: 'src/a.ts' };

  it('start read-only, become dirty when you type, keep the file’s CRLF when saved', async () => {
    expect(editSession(at)).toBeUndefined();
    const s = startEditing(at, 'ws1', 'one\r\ntwo\r\n');
    expect(s.draft).toBe('one\ntwo\n');
    expect(await s.baseHash).toBe(createHash('sha256').update('one\r\ntwo\r\n').digest('hex'));
    expect(isDirty(editSession(at))).toBe(false);
    setDraft(s.key, 'one\ntwo\nthree\n');
    const now = editSession(at)!;
    expect(isDirty(now)).toBe(true);
    expect(textToSave(now)).toBe('one\r\ntwo\r\nthree\r\n');
    markSaved(s.key, textToSave(now), 'h');
    expect(isDirty(editSession(at))).toBe(false);
    expect(await editSession(at)!.baseHash).toBe('h');
    stopEditing(s.key);
    expect(editSession(at)).toBeUndefined();
  });
});

describe('opening a file at a line', () => {
  it('waits for that file, then is done', () => {
    const a = { owner: 'me', share: 'ws', path: 'a.ts' };
    revealLine(a, 42);
    expect(pendingLine(a)).toBe(42);
    expect(pendingLine({ ...a, path: 'b.ts' })).toBeUndefined();
    doneRevealing(a);
    expect(pendingLine(a)).toBeUndefined();
  });
});

describe('syntax colors', () => {
  it('know the common languages by their extensions', () => {
    const want: Record<string, string> = {
      'a.ts': 'ts',
      'a.tsx': 'tsx',
      'a.js': 'js',
      'a.jsx': 'jsx',
      'a.json': 'json',
      'a.css': 'css',
      'a.scss': 'scss',
      'a.html': 'html',
      'a.md': 'markdown',
      'a.py': 'python',
      'a.go': 'go',
      'a.rs': 'rust',
      'a.java': 'java',
      'a.kt': 'kotlin',
      'a.swift': 'swift',
      'a.c': 'c',
      'a.cpp': 'cpp',
      'a.rb': 'ruby',
      'a.php': 'php',
      'a.sh': 'bash',
      'a.yaml': 'yaml',
      'a.yml': 'yaml',
      'a.toml': 'toml',
      'a.sql': 'sql',
      Dockerfile: 'docker',
    };
    for (const [file, lang] of Object.entries(want)) expect(langOf(file), file).toBe(lang);
  });
});
