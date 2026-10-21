/**
 * The product is "Klaud" in this app. Messages from the core are shared with the terminal app,
 * which writes "klaud"; where this window shows them as its own words (toasts, notices, system
 * lines, Stripe errors) they go through `brandText`. Never for chat content: what people and
 * Claude wrote stays as written.
 *
 * The `klaud` command and everything that is a name stays lowercase: `klaud join …`, klaud://
 * links, ~/.klaud and other paths, klaud.json, klaud/<branch>, klaud-… identifiers, and
 * anything inside `code`.
 */

const WORD = /\bklaud\b/g;

/**
 * "~/code/api" for a path under your home folder. Klaud's own folder reads ~/.klaud even where it
 * really is the old ~/.klaude (from before the rename, linked in place so nothing moved).
 */
export const tildePath = (home: string, p: string): string =>
  (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p).replace(/^~\/\.klaude(?=\/|$)/, '~/.klaud');
/** Right before the word: part of a path, a file name or an identifier. */
const NAME_BEFORE = /[/~.\-@_]/;
/** Right after the word: a link, a file name, a branch or an identifier (klaud://, klaud.json, klaud/x, klaud-x). */
const NAME_AFTER = /^(?::\/\/|[./\-_@]\w)/;
/** A command you type: `klaud join <link>`, `klaud update`, `klaud --help`. */
const COMMAND_AFTER = /^ (?:(?:join|update|view|host|demo|daemon|get)\b|--?\w)/;
/** Code spans and blocks are left exactly as they are. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

function brandProse(text: string): string {
  return text.replace(WORD, (word: string, at: number) => {
    const before = text[at - 1] ?? '';
    const after = text.slice(at + word.length);
    if (NAME_BEFORE.test(before) || NAME_AFTER.test(after) || COMMAND_AFTER.test(after)) return word;
    return 'Klaud';
  });
}

/** A core message as this window shows it: "klaud" in prose becomes "Klaud" (see above for what stays). */
export function brandText(text: string): string {
  if (!text.includes('klaud')) return text;
  return text
    .split(CODE)
    .map((part, i) => (i % 2 ? part : brandProse(part)))
    .join('');
}

/** The test notification's body is the one notice body that isn't a preview of what someone wrote. */
const TEST_NOTICE_TITLE = 'Notifications work';

/**
 * A notice (desktop notification or notification centre row) in this window's words: the title
 * always, the body only for the test notification (other bodies quote messages and commands).
 */
export function brandNotice<T extends { readonly title: string; readonly body: string; readonly tag?: string }>(n: T): T {
  return { ...n, title: brandText(n.title), body: isTestNotice(n) ? brandText(n.body) : n.body };
}

/** The one you asked for in Settings › Notifications (a desktop notification has no tag, only its title). */
export function isTestNotice(n: { readonly title: string; readonly tag?: string }): boolean {
  return n.tag === 'test' || n.title === TEST_NOTICE_TITLE;
}
