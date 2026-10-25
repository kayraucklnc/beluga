import type { GhIssue, GhIssueState } from '@beluga/core/issues/model.js';
import type { LogItem } from '@beluga/core/store.js';
import { ago } from '../tasks/tasks-model.js';
import type { Project } from '@beluga/workspaces/types.js';

/**
 * The Issues screens' plain parts (no React): an issue's state in words and color, a label's
 * soft color, what to remember between visits, and which project to show.
 */

export type StateTone = 'open' | 'done' | 'muted';

/** An issue's state as its icon shows it: open (green), closed as done (purple), closed otherwise (grey). */
export function stateOf(issue: Pick<GhIssue, 'state' | 'reason'>): { readonly label: string; readonly tone: StateTone } {
  if (issue.state === 'open') return { label: 'Open', tone: 'open' };
  if (issue.reason === 'not_planned') return { label: 'Not planned', tone: 'muted' };
  if (issue.reason === 'duplicate') return { label: 'Duplicate', tone: 'muted' };
  return { label: 'Closed', tone: 'done' };
}

/** A GitHub label's color as a CSS color ("#d73a4a"), or undefined (it's drawn grey). */
export const labelColor = (color: string): string | undefined => (/^[0-9a-f]{6}$/i.test(color) ? `#${color.toLowerCase()}` : undefined);

export interface IssuesPrefs {
  readonly state: GhIssueState;
}

export const DEFAULT_ISSUES_PREFS: IssuesPrefs = { state: 'open' };

export function readIssuesPrefs(raw: string | null): IssuesPrefs {
  try {
    const p = JSON.parse(raw ?? '{}') as Partial<IssuesPrefs>;
    return { state: p.state === 'closed' ? 'closed' : 'open' };
  } catch {
    return DEFAULT_ISSUES_PREFS;
  }
}

/** The project Issues shows: the one asked for, else the one you were last in, else the first. */
export function issuesProject(projects: readonly Pick<Project, 'id' | 'root' | 'error'>[], asked: string | undefined, last: string | undefined): string | undefined {
  const real = projects.filter((p) => p.root && !p.error);
  return real.find((p) => p.id === asked)?.id ?? real.find((p) => p.id === last)?.id ?? real[0]?.id;
}

/** "3 comments", "1 comment". */
export const comments = (n: number): string => `${n} comment${n === 1 ? '' : 's'}`;

/** Text to search GitHub with: words only, trimmed (empty: none). */
export const searchWords = (raw: string): string => raw.replace(/\s+/g, ' ').trim().slice(0, 200);

/** When, inside a sentence: "3 h ago", "yesterday", "Oct 3". */
export const agoWords = (ts: number, now = Date.now()): string => ago(ts, now).replace(/^Yesterday$/, 'yesterday');

/** Claude's last finished answer in a conversation (its report), if the conversation is loaded. */
export function lastReport(log: readonly LogItem[], channel: string): string | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const l = log[i]!;
    if (l.type === 'agent' && l.channel === channel && l.status === 'done' && l.text.trim() && l.text !== '(done)') return l.text;
  }
  return undefined;
}
