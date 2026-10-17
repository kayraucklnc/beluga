import { describe, expect, it } from 'vitest';
import type { LogItem } from '../src/core/store.js';
import { approvalLines, card, renderLog } from '../src/ui/format.js';
import { inline, isMarkdownPath, renderMarkdown } from '../src/ui/markdown.js';
import { formatDuration, formatSize, lineWidth, pad, truncate, windowLines, wrapText } from '../src/ui/text.js';
import { colorFor, theme } from '../src/ui/theme.js';

const text = (line: readonly { text: string }[]): string => line.map((s) => s.text).join('');

describe('text helpers', () => {
  it('wraps text within width', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 10);
    expect(lines.every((l) => l.length <= 10)).toBe(true);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
    expect(wrapText('a'.repeat(25), 10)).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });

  it('truncates and pads styled lines by display width', () => {
    expect(text(truncate([{ text: 'hello' }, { text: ' world' }], 8))).toBe('hello w…');
    expect(truncate([{ text: 'hi' }], 8)).toEqual([{ text: 'hi' }]);
    expect(lineWidth(pad([{ text: 'hi' }], 6))).toBe(6);
    expect(lineWidth(pad([{ text: '日本語テキスト' }], 6))).toBeLessThanOrEqual(6);
  });

  it('windows lines from the bottom', () => {
    const lines = [1, 2, 3, 4, 5];
    expect(windowLines(lines, 2, 0)).toEqual([4, 5]);
    expect(windowLines(lines, 2, 1)).toEqual([3, 4]);
    expect(windowLines(lines, 2, 99)).toEqual([1, 2]);
  });

  it('formats sizes, durations and stable colors', () => {
    expect(formatSize(10)).toBe('10B');
    expect(formatSize(2048)).toBe('2K');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0M');
    expect(formatDuration(5_400)).toBe('5s');
    expect(formatDuration(125_000)).toBe('2m05s');
    expect(colorFor('bob')).toBe(colorFor('bob'));
  });
});

describe('markdown', () => {
  it('styles inline code and bold', () => {
    expect(inline('run `npm test` **now**')).toEqual([
      { text: 'run ' },
      { text: 'npm test', color: theme.info },
      { text: ' ' },
      { text: 'now', bold: true },
    ]);
    expect(inline('')).toEqual([{ text: '' }]);
  });

  it('renders headings, lists, quotes, rules and code blocks', () => {
    const lines = renderMarkdown('# Title\n## Sub\n### Small\n- one\n  - two\n3. three\n> quoted\n---\n```\nconst a = 1;\n```\nplain', 40).map(text);
    expect(lines).toEqual(['Title', '━'.repeat(40), 'Sub', '─'.repeat(40), 'Small', '• one', '  • two', '3. three', '│ quoted', '─'.repeat(40), '▎ const a = 1;', 'plain']);
  });

  it('renders links and italics inline', () => {
    expect(inline('see [docs](https://x.dev) and *this*')).toEqual([
      { text: 'see ' },
      { text: 'docs', color: theme.info },
      { text: ' and ' },
      { text: 'this', italic: true },
    ]);
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('a.ts')).toBe(false);
  });
});

describe('renderLog', () => {
  const base = { ts: Date.parse('2026-10-16T12:00:00Z') };
  const items: LogItem[] = [
    { id: '1', type: 'chat', from: 'me', name: 'kay', text: 'hello', byAgent: false, ...base },
    { id: '2', type: 'chat', from: 'me', name: 'kay', text: 'second', byAgent: false, ...base },
    { id: '3', type: 'chat', from: 'b', name: "bob's Claude", text: 'beep', byAgent: true, ...base },
    { id: '4', type: 'system', text: 'oops', level: 'error', ...base },
    { id: '5', type: 'agent', requestId: 'r', owner: 'b', ownerName: 'bob', requesterName: 'kay', status: 'started', text: 'thinking **hard**', steps: ['Read a.ts'], ...base },
    { id: '6', type: 'agent', requestId: 'q', owner: 'b', ownerName: 'bob', requesterName: 'bob', status: 'done', text: '', steps: ['ToolSearch x', 'a', 'b', 'c', 'd'], endTs: base.ts + 14_000, ...base },
    { id: '7', type: 'agent', requestId: 'w', owner: 'b', ownerName: 'bob', requesterName: 'kay', status: 'awaiting_approval', text: '', steps: [], ...base },
  ];
  const lines = renderLog(items, 60, { selfId: 'me', frame: 0, now: base.ts + 3000 }).map(text);

  it('groups consecutive messages from the same person', () => {
    expect(lines[0]).toMatch(/^you {2}\d\d:\d\d$/);
    expect(lines[1]).toBe('  hello');
    expect(lines[2]).toBe('  second');
    expect(lines.some((l) => l.startsWith("◆ bob's Claude"))).toBe(true);
  });

  it('renders agent work as a rail with live status', () => {
    const top = lines.find((l) => l.includes('working · 3s'));
    expect(top).toMatch(/^◆ bob's Claude {2}for kay +⠋ working · 3s$/);
    expect(top).toHaveLength(60);
    expect(lines).toContain('│ ↳ Read a.ts');
    expect(lines.some((l) => l.includes('thinking hard'))).toBe(true);
    expect(lines.some((l) => l.includes('…1 earlier steps'))).toBe(true);
    expect(lines.some((l) => l.includes('✓ done · 14s'))).toBe(true);
    expect(lines.some((l) => l.includes('ToolSearch'))).toBe(false); // plumbing is hidden
    expect(lines.some((l) => l.includes('bob needs to approve this'))).toBe(true);
    expect(lines.every((l) => l.length <= 60)).toBe(true);
  });

  it('draws cards without a right label', () => {
    const c = card([{ text: 'Title' }], [], [[{ text: 'body' }]], 20, 'cyan').map(text);
    expect(c).toEqual(['╭─ Title ──────────╮', '│ body             │', '╰──────────────────╯']);
  });

  it('wraps approval details, summarising very long ones', () => {
    expect(approvalLines('rm -rf build', 40)).toEqual(['rm -rf build']);
    const long = approvalLines('x'.repeat(1000), 40);
    expect(long).toHaveLength(6);
    expect(long[5]).toContain('more lines (1000 chars)');
  });
});
