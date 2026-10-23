import { describe, expect, it } from 'vitest';
import { ProseView } from '../src/companion/protocol.js';
import { humanizeStep, plainLine, stripCode } from '../src/companion/strip.js';

describe('stripCode', () => {
  it('takes fenced blocks out, leaving a marker with the language and line count', () => {
    const md = ['Here is the fix:', '', '```ts', 'const a = 1;', 'const b = 2;', '```', '', 'And a shell line:', '~~~', 'npm test', '~~~', 'Done, `store.ts` is fine.'].join('\n');
    const out = stripCode(md);
    expect(out.text).toBe(['Here is the fix:', '', '[[code:0]]', '', 'And a shell line:', '[[code:1]]', 'Done, `store.ts` is fine.'].join('\n'));
    expect(out.code).toEqual([{ lang: 'ts', lines: 2 }, { lines: 1 }]);
    expect(ProseView.parse(out)).toEqual(out);
  });

  it('handles longer fences, nested backticks and an unclosed block', () => {
    const md = ['````md', '```js', 'x()', '```', '````', 'after', '```python', 'print(1)', 'print(2)'].join('\n');
    const out = stripCode(md);
    expect(out.text).toBe('[[code:0]]\nafter\n[[code:1]]');
    expect(out.code).toEqual([{ lang: 'md', lines: 3 }, { lang: 'python', lines: 2 }]);
  });

  it('leaves prose without code alone', () => {
    expect(stripCode('All **24 tests** pass.')).toEqual({ text: 'All **24 tests** pass.', code: [] });
  });

  it('makes one plain line for summaries', () => {
    expect(plainLine('## Plan\n\nRun it:\n```sh\nnpm test\n```\n**done**')).toBe('Plan Run it: (code) done');
    expect(plainLine('x'.repeat(400), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('humanizeStep', () => {
  it('turns tool steps into words, never code', () => {
    expect(humanizeStep('Edit src/core/store.ts')).toBe('Edited store.ts');
    expect(humanizeStep('MultiEdit /Users/k/app/src/a.tsx')).toBe('Edited a.tsx');
    expect(humanizeStep('Write NOTES.md')).toBe('Wrote NOTES.md');
    expect(humanizeStep('Read src/server.ts')).toBe('Read server.ts');
    expect(humanizeStep('Bash npm test -- --run')).toBe('Ran npm test');
    expect(humanizeStep('Bash FOO=1 ./scripts/build.sh --all')).toBe('Ran ./scripts/build.sh');
    expect(humanizeStep('Bash sqlite3 payments.db ".tables"')).toBe('Ran sqlite3');
    expect(humanizeStep('Grep "TODO"')).toBe('Searched for TODO');
    expect(humanizeStep('Glob src/**/*.ts')).toBe('Looked for files');
    expect(humanizeStep('WebFetch https://example.com/docs')).toBe('Read a page on example.com');
    expect(humanizeStep('mcp__beluga__show')).toBe('Used show');
    expect(humanizeStep('mcp__beluga_board__task_define Protect the payment routes')).toBe('Used task define');
    expect(humanizeStep('task_define Protect the payment routes')).toBe('Used task define');
    expect(humanizeStep('24 passed')).toBe('24 passed');
  });
});
