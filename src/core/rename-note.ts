import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const RENAME_NOTE = 'klaud is now Beluga. Run `beluga` from now on: `klaud` keeps working too, and everything you had is still here.\n';

/**
 * The note for someone who started Beluga by its old name (`klaud`), the first time only: a file in
 * Beluga's home remembers it was shown. Undefined for `beluga`, and once seen. Never throws.
 */
export function renameNote(invokedAs: string | undefined, home: string): string | undefined {
  if (!invokedAs || path.basename(invokedAs) !== 'klaud') return undefined;
  const seen = path.join(home, 'renamed-to-beluga');
  try {
    if (existsSync(seen)) return undefined;
    mkdirSync(home, { recursive: true });
    writeFileSync(seen, `${new Date().toISOString()}\n`);
  } catch {
    // Can't remember it: show it anyway, once is better than never.
  }
  return RENAME_NOTE;
}
