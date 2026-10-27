import type { Issue } from '../board/model.js';
import type { TeamState } from './model.js';

/**
 * Team tasks in chats with friends (BLG-263): "@BLG-12" names a task of a repository you're
 * teamed up on with someone in the chat, so you ask their Claude about it there instead of giving
 * it a task (BLG-262). A team task keeps one id on every Mac but a key of each Mac's own
 * ("BLG-12" here, "API-40" on theirs: board-sync.ts), so a message carries the id:
 * `[@BLG-12](beluga-task-id:<id>)` on the wire, and every Mac shows (and its Claude reads) its own
 * key. A Beluga that doesn't know the link shows the words, "@BLG-12". Pure and browser-safe.
 */

export const TASK_ID_SCHEME = 'beluga-task-id:';

type Shared = Pick<Issue, 'id' | 'key' | 'projectId' | 'archivedAt'>;

/** The projects you're teamed up on with any of these people. */
export function sharedProjects(team: Pick<TeamState, 'teams'>, peers: readonly string[]): ReadonlySet<string> {
  return new Set(Object.values(team.teams).flatMap((t) => (t.mates.some((m) => peers.includes(m.peerId)) ? [t.projectId] : [])));
}

/** The tasks a chat with these people can name: the live ones of the projects you share with them. */
export function sharedTasks<I extends Shared>(issues: readonly I[], team: Pick<TeamState, 'teams'>, peers: readonly string[]): I[] {
  const projects = sharedProjects(team, peers);
  return projects.size ? issues.filter((i) => !i.archivedAt && projects.has(i.projectId)) : [];
}

/** Code (fenced or `inline`) and links are left as they are; each other piece goes through `edit`. */
function outsideCode(text: string, edit: (piece: string) => string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((piece, i) => (i % 2 ? piece : edit(piece)))
    .join('');
}

const KEY_MENTION = /(^|[^\w@[/])@([A-Za-z][A-Za-z0-9]{0,11}-\d{1,6})(?![\w-])/g;
const ID_MENTION = /\[@([A-Za-z][A-Za-z0-9]{0,11}-\d{1,6})\]\(beluga-task-id:([\w.-]{1,80})\)/g;

/** What you send: each "@KEY" of a task you share with them carries its id. */
export function portableMentions(text: string, shared: readonly Pick<Issue, 'id' | 'key'>[]): string {
  if (!shared.length || !text.includes('@')) return text;
  const byKey = new Map(shared.map((i) => [i.key.toUpperCase(), i]));
  return outsideCode(text, (piece) =>
    piece.replace(KEY_MENTION, (all, lead: string, key: string) => {
      const issue = byKey.get(key.toUpperCase());
      return issue ? `${lead}[@${issue.key}](${TASK_ID_SCHEME}${issue.id})` : all;
    }),
  );
}

/** What you read: each task a message names, by this Mac's own key ("@KEY" as the sender wrote it when it isn't here). */
export function localMentions(text: string, issues: readonly Pick<Issue, 'id' | 'key'>[]): string {
  if (!text.includes(TASK_ID_SCHEME)) return text;
  return text.replace(ID_MENTION, (_all, key: string, id: string) => `@${issues.find((i) => i.id === id)?.key ?? key}`);
}
