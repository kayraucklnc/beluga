import { describe, expect, it } from 'vitest';
import { keepBlankLines } from '../packages/mac/src/chat/typed-lines.js';

const NBSP = ' ';

describe('blank lines a person typed', () => {
  it('leaves one blank line (a paragraph break) and single lines as they are', () => {
    expect(keepBlankLines('a\nb')).toBe('a\nb');
    expect(keepBlankLines('a\n\nb')).toBe('a\n\nb');
  });

  it('keeps each extra blank line as an empty line of its own', () => {
    expect(keepBlankLines('a\n\n\nb')).toBe(`a\n\n${NBSP}\n\nb`);
    expect(keepBlankLines('new line like\n\n\n\nthis')).toBe(`new line like\n\n${NBSP}\n${NBSP}\n\nthis`);
  });

  it('counts lines of spaces as blank', () => {
    expect(keepBlankLines('a\n  \n\t\nb')).toBe(`a\n\n${NBSP}\n\nb`);
  });

  it('drops blank lines before the first words and after the last', () => {
    expect(keepBlankLines('\n\n\na\n\n\n')).toBe('a');
  });

  it('leaves code blocks exactly as written', () => {
    const code = '```\nx\n\n\n\ny\n```';
    expect(keepBlankLines(code)).toBe(code);
    expect(keepBlankLines(`a\n\n\n${code}`)).toBe(`a\n\n${NBSP}\n\n${code}`);
    expect(keepBlankLines('~~~\n\n\n~~~')).toBe('~~~\n\n\n~~~');
  });
});
