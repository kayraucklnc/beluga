/**
 * Tasks Claude shows in an answer (BLG-26): `task:BLG-12` in inline code is a small chip, and a
 * fenced `beluga-tasks` block (keys one per line, or a JSON array) is a list of cards. Only keys:
 * the window reads each task from the live board, so what it says stays true. Browser-safe.
 */

export const TASKS_FENCE = 'beluga-tasks';

/** "BLG-12": a project's prefix and a number. */
const KEY = /^[A-Za-z][A-Za-z0-9]{0,11}-\d{1,6}$/;

export const isTaskKey = (text: string): boolean => KEY.test(text.trim());

/** At most this many cards in one block (more is a list for the Tasks view). */
export const MAX_TASK_CARDS = 30;

/**
 * The keys in a `beluga-tasks` block, upper-cased, each once, in order: a JSON array (of keys, or
 * of objects with a "key"), else the first key on each line ("BLG-12", "- task:BLG-12 the login").
 */
export function readTaskKeys(code: string): string[] {
  const found: string[] = [];
  const add = (raw: unknown): void => {
    const k = typeof raw === 'string' ? raw.trim().replace(/^task:\s*/i, '') : '';
    if (isTaskKey(k) && !found.includes(k.toUpperCase()) && found.length < MAX_TASK_CARDS) found.push(k.toUpperCase());
  };
  const text = code.trim();
  if (text.startsWith('[')) {
    try {
      const list: unknown = JSON.parse(text);
      if (Array.isArray(list)) {
        for (const item of list) add(typeof item === 'object' && item ? (item as { key?: unknown }).key : item);
        return found;
      }
    } catch {
      // Not JSON (yet, while it streams): read it as lines.
    }
  }
  for (const line of text.split('\n')) add(/\b[A-Za-z][A-Za-z0-9]{0,11}-\d{1,6}\b/.exec(line)?.[0]);
  return found;
}
