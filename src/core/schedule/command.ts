import type { Session } from '../session.js';
import { clock, whenWords, type ScheduleView } from './model.js';
import { needSchedules } from './registry.js';
import type { Schedule } from './schema.js';

/**
 * /schedule in a chat: `/schedule` says what the chat has; `/schedule pause|resume|run|remove [title]`
 * acts on one. The title can be part of the name, and it can be left out while the chat has one.
 */

const ACTIONS = ['pause', 'resume', 'run', 'remove'] as const;
type Action = (typeof ACTIONS)[number];

export function runScheduleCommand(session: Session, args: readonly string[], channel: string): void {
  try {
    const schedules = needSchedules(session);
    const here = schedules.list(channel);
    const [first, ...rest] = args;
    if (!first) {
      session.store.dispatch({ type: 'system', text: listLine(here.map((s) => schedules.view(s))), channel });
      return;
    }
    if (!isAction(first)) return session.toast('Usage: /schedule [pause|resume|run|remove] [title]', 'warn');
    const s = pick(here, rest.join(' '));
    if (first === 'pause') schedules.setEnabled(s.id, false);
    if (first === 'resume') schedules.setEnabled(s.id, true);
    if (first === 'run') schedules.runNow(s.id);
    if (first === 'remove') schedules.remove(s.id);
    session.toast(DONE[first](s.title), 'success');
  } catch (err) {
    session.toast(err instanceof Error ? err.message : String(err), 'warn');
  }
}

const DONE: Readonly<Record<Action, (title: string) => string>> = {
  pause: (t) => `Paused ${t}`,
  resume: (t) => `Resumed ${t}`,
  run: (t) => `Running ${t}`,
  remove: (t) => `Removed ${t}`,
};

function isAction(word: string): word is Action {
  return (ACTIONS as readonly string[]).includes(word);
}

function listLine(here: readonly ScheduleView[]): string {
  if (!here.length) return 'This chat has no schedules.';
  return here
    .map((s) => {
      const state = s.enabled ? (s.next !== undefined ? `next ${clock(s.next)}` : s.status) : `paused${s.pausedReason ? ` (${s.pausedReason})` : ''}`;
      return `${s.title} · ${whenWords(s.when)} · ${state}`;
    })
    .join('\n');
}

/** The one schedule these words name, or why not. */
function pick(here: readonly Schedule[], words: string): Schedule {
  if (!here.length) throw new Error('This chat has no schedules.');
  const typed = words.trim().toLowerCase();
  const exact = here.filter((s) => s.title.toLowerCase() === typed);
  const found = exact.length ? exact : here.filter((s) => s.title.toLowerCase().includes(typed));
  if (found.length === 1) return found[0]!;
  const names = here.map((s) => s.title).join(', ');
  throw new Error(found.length ? `Say which one: ${names}` : `This chat has no schedule called “${words}”. It has: ${names}`);
}
