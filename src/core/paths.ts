import os from 'node:os';

/**
 * "/Users/bob/api" → "~/api" (only a leading home folder, so "/Users/bob2" stays as is). klaud's
 * folder reads ~/.klaud even where it's really the old ~/.klaude, linked in place by the rename.
 */
export const tilde = (p: string, home = os.homedir()): string => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p).replace(/^~\/\.klaude(?=\/|$)/, '~/.klaud');
