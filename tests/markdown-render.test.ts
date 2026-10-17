import { describe, expect, it } from 'vitest';
import { ansiToLine } from '../src/ui/ansi.js';
import { renderMarkdownAnsi, stripHtml, unwrapParagraphs } from '../src/ui/markdown-render.js';

const plainText = (lines: string[]) => lines.map((l) => ansiToLine(l).map((s) => s.text).join(''));

describe('ansiToLine', () => {
  it('turns SGR codes into styled segments and drops other escapes', () => {
    expect(ansiToLine('a\x1b[1mbold\x1b[22m \x1b[38;2;255;0;16mred\x1b[39m\x1b[2K')).toEqual([
      { text: 'a' },
      { text: 'bold', bold: true },
      { text: ' ' },
      { text: 'red', color: '#ff0010' },
    ]);
    expect(ansiToLine('\x1b[3;4mx\x1b[0my')).toEqual([{ text: 'x', italic: true, underline: true }, { text: 'y' }]);
    expect(ansiToLine('\x1b[31ma\x1b[94mb\x1b[38;5;196mc\x1b[38;5;244md\x1b[38;5;3me')).toEqual([
      { text: 'a', color: '#e06c75' },
      { text: 'b', color: '#7cc4ff' },
      { text: 'c', color: '#ff0000' },
      { text: 'd', color: '#808080' },
      { text: 'e', color: '#e5c07b' },
    ]);
    expect(ansiToLine('\x1b]8;;https://x\x07link\x1b]8;;\x07')).toEqual([{ text: 'link' }]);
    expect(ansiToLine('\x1b[mreset')).toEqual([{ text: 'reset' }]);
  });
});

describe('markdown rendering', () => {
  it('joins hard-wrapped paragraph lines but keeps blocks intact', () => {
    expect(unwrapParagraphs('one\ntwo\n\n- a\n- b\n```\nx\ny\n```\n# H\ntext')).toBe('one two\n\n- a\n- b\n```\nx\ny\n```\n# H\ntext');
  });

  it('removes HTML comments and tags, keeping image alt text', () => {
    expect(stripHtml('<!-- hidden -->\n<p align="center"><img src="a.png" alt="Logo"></p>\nhi<br>there')).toBe('\n[image: Logo]\nhi\nthere');
  });

  it('renders headings, reflowed paragraphs, lists with inline code, and tables', () => {
    const md = '# Title\n\nA long paragraph that was\nhard wrapped in the source.\n\n- use `npm test`\n- **bold** item\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nplain code\n```\n';
    const lines = plainText(renderMarkdownAnsi(md, 60));
    expect(lines[0]).toBe('Title');
    expect(lines).toContain('A long paragraph that was hard wrapped in the source.');
    expect(lines.some((l) => l.includes('• use npm test') && !l.includes('`'))).toBe(true);
    expect(lines.some((l) => l.includes('bold item') && !l.includes('**'))).toBe(true);
    expect(lines.some((l) => /│ *1 *│ *2 *│/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes('plain code'))).toBe(true);
    expect(lines.every((l) => !l.includes('# '))).toBe(true);
    expect(renderMarkdownAnsi(md, 60)).toBe(renderMarkdownAnsi(md, 60)); // cached
  });
});
