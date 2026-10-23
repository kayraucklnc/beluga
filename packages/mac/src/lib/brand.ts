/**
 * The product is "Beluga" in this app. Messages from the core write "beluga"
 * (and peers on a version from before the rename write "klaud"); where this
 * window shows them as its own words (toasts, notices, system lines, Stripe errors) they go
 * through `brandText`, which makes both "Beluga". Never for chat content: what people and Claude
 * wrote stays as written.
 *
 * The `beluga` command and everything that is a name stays as it is: `beluga join …`, beluga://
 * and klaud:// links, ~/.beluga and other paths, beluga.json, beluga/<branch>, beluga-…
 * identifiers (and their klaud spellings), and anything inside `code`.
 */

const WORD = /\b(?:beluga|klaud)\b/g;

/**
 * "~/code/api" for a path under your home folder. Beluga's own folder reads ~/.beluga even where
 * it really is the old ~/.klaud or ~/.klaude (from before the renames, linked to it), as the core
 * writes it (src/core/paths.ts).
 */
export const tildePath = (home: string, p: string): string =>
  (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p).replace(/^~\/\.klaude?(?=\/|$)/, '~/.beluga');
/** Right before the word: part of a path, a file name or an identifier. */
const NAME_BEFORE = /[/~.\-@_]/;
/** Right after the word: a link, a file name, a branch or an identifier (beluga://, beluga.json, beluga/x, beluga-x). */
const NAME_AFTER = /^(?::\/\/|[./\-_@]\w)/;
/** A command you type: `beluga join <link>`, `beluga update`, `beluga --help`. */
const COMMAND_AFTER = /^ (?:(?:join|update|view|host|demo|daemon|get)\b|--?\w)/;
/** Code spans and blocks are left exactly as they are. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

function brandProse(text: string): string {
  return text.replace(WORD, (word: string, at: number) => {
    const before = text[at - 1] ?? '';
    const after = text.slice(at + word.length);
    if (NAME_BEFORE.test(before) || NAME_AFTER.test(after) || COMMAND_AFTER.test(after)) return word;
    return 'Beluga';
  });
}

/** A core message as this window shows it: "beluga" (or "klaud") in prose becomes "Beluga" (see above for what stays). */
export function brandText(text: string): string {
  if (!text.includes('beluga') && !text.includes('klaud')) return text;
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
