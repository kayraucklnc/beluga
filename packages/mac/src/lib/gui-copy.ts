/**
 * The terminal UI's menus are written for a terminal: intros wrapped to fit ~100 columns, hints
 * like "Enter to change" or "type a name", /commands. Shown in this window, they read as a GUI.
 */

export type Block = { readonly kind: 'p'; readonly text: string } | { readonly kind: 'list'; readonly items: readonly string[] };

/** Join wrapped lines back into paragraphs; indented lines ("  1. …") make a list. */
export function paragraphs(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') });
    if (list.length) blocks.push({ kind: 'list', items: list });
    para = [];
    list = [];
  };
  for (const line of lines) {
    if (!line.trim()) {
      flush();
    } else if (/^\s{2,}/.test(line)) {
      if (para.length) flush();
      list.push(line.trim().replace(/^\d+\.\s+/, ''));
    } else {
      if (list.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

const TERMINAL_ONLY = /^(enter\b|esc$|type\b|then enter|↑↓)/i;
const WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/add it back with \/project add/i, 'add it back any time with Add Project'],
  [/Option\+↑ \(Alt\+↑\) anywhere/, '⌘+'],
  [/Option\+↓ \(Alt\+↓\) anywhere/, '⌘−'],
  [/\(Settings → Workspaces\)/, '(Settings › Workspaces)'],
];

/** A menu option's hint without the keys and typing a terminal needs ("Enter to change", "type a name"). */
export function guiHint(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const parts = hint
    .split(/\s+·\s+/)
    .map((p) => WORDS.reduce((text, [from, to]) => text.replace(from, to), p.trim()))
    .filter((p) => p && !TERMINAL_ONLY.test(p));
  return parts.length ? parts.join(' · ') : undefined;
}
