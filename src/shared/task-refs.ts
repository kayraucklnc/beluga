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

/**
 * Tasks named in a message (BLG-56): "@BLG-24" is a task the way "@mia" is a friend. Typing one
 * suggests tasks by key ("@BLG-2", and the near misses "@BLG24", "@blg-24", "@24") or by a word
 * of the title ("@login"); an exact key is the task even when it wasn't picked from the list.
 */
export interface TaskMention {
  /** "BLG-24". */
  readonly key: string;
  readonly title: string;
  /** Its status (an IssueStatus: 'todo', 'in_progress'…). */
  readonly status: string;
  /** Still to do (not Done or Canceled): ranked ahead of closed ones. */
  readonly open?: boolean;
}

/** How many tasks the "@" list offers at once. */
export const MAX_TASK_SUGGESTIONS = 6;

/** "BLG-24" → BLG and 24. */
function partsOf(key: string): { prefix: string; digits: string } {
  const dash = key.lastIndexOf('-');
  return { prefix: key.slice(0, dash).toUpperCase(), digits: key.slice(dash + 1) };
}

/** What a typed "@…" says of a key: "blg-24", "BLG24", "24", "BLG" (undefined: it isn't key-shaped). */
function typedKey(typed: string): { prefix: string; digits: string } | undefined {
  const dash = /^([A-Za-z][A-Za-z0-9]{0,11})-(\d{0,6})$/.exec(typed);
  if (dash) return { prefix: dash[1]!.toUpperCase(), digits: dash[2]! };
  const glued = /^([A-Za-z]{0,12})(\d{0,6})$/.exec(typed);
  return glued && typed ? { prefix: glued[1]!.toUpperCase(), digits: glued[2]! } : undefined;
}

/** How well a task answers what's typed: 0 is the very key, larger is looser (undefined: not at all). */
function rankOf(typed: string, task: TaskMention): number | undefined {
  const want = typedKey(typed);
  const have = partsOf(task.key);
  if (want) {
    const prefixHit = !want.prefix || have.prefix.startsWith(want.prefix);
    if (want.digits && prefixHit) {
      if (have.digits === want.digits) return want.prefix === have.prefix ? 0 : 1;
      if (have.digits.startsWith(want.digits)) return 2;
    } else if (!want.digits && want.prefix.length >= 2 && prefixHit) return 3;
  }
  // A word of the title ("@login", "@dark-mode"); never digits alone ("@24" is a key or nothing).
  if (typed.length < 2 || /^[\d-]+$/.test(typed)) return undefined;
  const words = typed.toLowerCase().replace(/[-_.]+/g, ' ').trim();
  const title = task.title.toLowerCase();
  if (!words) return undefined;
  if (title.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(words)) || title.includes(` ${words}`) || title.startsWith(words)) return 4;
  if (words.length >= 3 && title.includes(words)) return 5;
  return undefined;
}

/**
 * The tasks a typed "@…" (without the @) may mean, best first: the very key, then near misses
 * ("BLG24", "24" → BLG-24), keys it starts ("BLG-2" → BLG-21…), then title words. Open tasks
 * ahead of closed ones, newer ahead of older.
 */
export function matchTasks(typed: string, tasks: readonly TaskMention[], max = MAX_TASK_SUGGESTIONS): TaskMention[] {
  if (!typed) return [];
  const num = (t: TaskMention): number => Number(partsOf(t.key).digits) || 0;
  return tasks
    .flatMap((task) => {
      const rank = rankOf(typed, task);
      return rank === undefined ? [] : [{ task, rank }];
    })
    .sort((a, b) => a.rank - b.rank || Number(b.task.open !== false) - Number(a.task.open !== false) || num(b.task) - num(a.task))
    .slice(0, max)
    .map((m) => m.task);
}

/** The task an exact "@BLG-24" names (any case), if there's one. */
export function taskByKey(token: string, tasks: readonly TaskMention[]): TaskMention | undefined {
  if (!isTaskKey(token)) return undefined;
  const k = token.trim().toUpperCase();
  return tasks.find((t) => t.key.toUpperCase() === k);
}

/** "@BLG-24" standing on its own in a prompt (not inside an e-mail address, not already explained). */
const MENTIONED = /(^|[\s({"'“])@([A-Za-z][A-Za-z0-9]{0,11}-\d{1,6})(?=$|[\s.,;:!?)\]}"'”])(?! \(task: )/g;

/**
 * What Claude reads for a message naming tasks: each "@BLG-24" stays as written, followed by what
 * it is ("@BLG-24 (task: Fix the login)"), so Claude knows it's a task on the board. Code blocks
 * are left alone, and so are keys the board doesn't have.
 */
export function explainTaskMentions(prompt: string, find: (key: string) => { readonly title: string } | undefined): string {
  if (!prompt.includes('@')) return prompt;
  let fenced = false;
  return prompt
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(MENTIONED, (whole, lead: string, key: string) => {
        const task = find(key.toUpperCase());
        return task ? `${lead}@${key} (task: ${task.title.replace(/\s+/g, ' ').trim()})` : whole;
      });
    })
    .join('\n');
}
