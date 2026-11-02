import { languageOf } from './highlight.js';

/**
 * Laying code out again (the editor's Tidy): SQL on lines with its keywords in capitals, JSON
 * indented. Scripts (Python, shell) have no formatter that runs in the window, so they keep theirs.
 */

const TIDY = new Set(['sql', 'json']);

export function canTidy(lang: string | undefined): boolean {
  return TIDY.has(languageOf(lang));
}

/** The code laid out, or undefined when it doesn't read as that language (it is left alone). */
export async function tidy(code: string, lang: string | undefined): Promise<string | undefined> {
  const id = languageOf(lang);
  try {
    if (id === 'json') return `${JSON.stringify(JSON.parse(code), null, 2)}`;
    if (id === 'sql') {
      const { format } = await import('sql-formatter');
      return format(code, {
        language: 'postgresql',
        keywordCase: 'upper',
        tabWidth: 2,
        // A view's {{control}} stays one piece, not braces to space out.
        paramTypes: { numbered: ['$'], custom: [{ regex: String.raw`\{\{[^{}]+\}\}` }] },
      });
    }
  } catch {
    return undefined;
  }
  return undefined;
}
