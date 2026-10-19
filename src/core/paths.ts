import os from 'node:os';

/** "/Users/bob/api" → "~/api" (only a leading home folder, so "/Users/bob2" stays as is). */
export const tilde = (p: string, home = os.homedir()): string => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
