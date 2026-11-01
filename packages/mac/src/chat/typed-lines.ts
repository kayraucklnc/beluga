/**
 * What a person typed keeps its shape (BLG-567). Markdown folds any run of blank lines into one
 * paragraph break, so "hi\n\n\n\nthere" lost its gap; here each blank line past the first becomes
 * an empty line of its own (a no-break space, in a paragraph of its own), drawn as the room it took
 * in the box. Code blocks stay as written. No DOM here, so it's tested on its own.
 */

const NBSP = ' ';
const FENCE = /^\s*(```|~~~)/;

export function keepBlankLines(text: string): string {
  const out: string[] = [];
  let blanks = 0;
  let fenced = false;
  for (const line of text.split('\n')) {
    if (fenced) {
      out.push(line);
      if (FENCE.test(line)) fenced = false;
      continue;
    }
    if (!line.trim()) {
      blanks += 1;
      continue;
    }
    // Blank lines before the first words show nothing; between words, one is the paragraph break.
    if (out.length && blanks) out.push('', ...(blanks > 1 ? [...Array<string>(blanks - 1).fill(NBSP), ''] : []));
    blanks = 0;
    out.push(line);
    if (FENCE.test(line)) fenced = true;
  }
  return out.join('\n');
}
