import os from 'node:os';

/**
 * "/Users/bob/api" → "~/api" (only a leading home folder, so "/Users/bob2" stays as is). Beluga's
 * folder reads ~/.beluga even where it's named by the old ~/.klaud or ~/.klaude, linked in place by the renames.
 */
export const tilde = (p: string, home = os.homedir()): string => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p).replace(/^~\/\.klaude?(?=\/|$)/, '~/.beluga');
