import { describe, expect, it } from 'vitest';
import { approvalLines, colorFor, formatSize, renderLog, windowLines, wrapText } from '../src/ui/format.js';
import type { LogItem } from '../src/core/store.js';

describe('format', () => {
  it('wraps text within width', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 10);
    expect(lines.every((l) => l.length <= 10)).toBe(true);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
    expect(wrapText('a'.repeat(25), 10)).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });

  it('windows lines from the bottom', () => {
    const lines = [1, 2, 3, 4, 5];
    expect(windowLines(lines, 2, 0)).toEqual([4, 5]);
    expect(windowLines(lines, 2, 1)).toEqual([3, 4]);
    expect(windowLines(lines, 2, 99)).toEqual([1, 2]);
  });

  it('renders every log item type', () => {
    const items: LogItem[] = [
      { id: '1', type: 'chat', from: 'me', name: 'kay', text: 'hello', ts: 0, byAgent: false },
      { id: '2', type: 'system', text: 'oops', ts: 0, level: 'error' },
      { id: '3', type: 'agent', requestId: 'r', owner: 'b', ownerName: 'bob', requesterName: 'kay', status: 'started', text: 'thinking', steps: ['Read a.ts'], ts: 0 },
      { id: '4', type: 'agent', requestId: 'q', owner: 'b', ownerName: 'bob', requesterName: 'kay', status: 'done', text: '', steps: [], ts: 0 },
    ];
    const lines = renderLog(items, 60, 'me');
    expect(lines[0]?.text).toContain('kay (you): hello');
    expect(lines[1]).toMatchObject({ color: 'red' });
    expect(lines.some((l) => l.text.includes("bob's claude ← kay · working"))).toBe(true);
    expect(lines.some((l) => l.text.includes('↳ Read a.ts'))).toBe(true);
    expect(lines.at(-1)?.text).toContain('done');
  });

  it('wraps approval details, summarising very long ones', () => {
    expect(approvalLines('rm -rf build', 40)).toEqual(['rm -rf build']);
    const long = approvalLines('x'.repeat(1000), 40);
    expect(long).toHaveLength(6);
    expect(long[5]).toContain('more lines (1000 chars)');
  });

  it('formats sizes and stable colors', () => {
    expect(formatSize(10)).toBe('10B');
    expect(formatSize(2048)).toBe('2K');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0M');
    expect(colorFor('bob')).toBe(colorFor('bob'));
  });
});
