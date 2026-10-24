import { useMemo } from 'react';
import { workspaceMentions } from '@beluga/core/mentions.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { isOpen } from '@beluga/core/board/model.js';
import type { TaskMention } from '@beluga/shared/task-refs.js';
import { TaskChip } from '../tasks/TaskRef.js';
import { Icon, type IconName } from '../components/Icon.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { type MentionKind, type MentionRef, type MentionWorld } from './mentions.js';
import s from './mention.module.css';

/**
 * A mention that names someone or something real, drawn as a pill: a friend, a Claude, a
 * project, a worktree, a folder, a file or a task. A click opens it (a friend's conversation, the
 * project, the worktree, the file, the task).
 */

const ICON: Readonly<Record<MentionKind, IconName>> = { friend: 'person', claude: 'claude', project: 'grid', workspace: 'branch', folder: 'folder', file: 'file', task: 'task', image: 'image' };
const WHAT: Readonly<Record<MentionKind, string>> = { friend: 'Friend', claude: 'Claude', project: 'Project', workspace: 'Worktree', folder: 'Folder', file: 'File', task: 'Task', image: 'Image' };

/** The worktree a conversation is in ("ws:<id>"), if it is one. */
export const worktreeOf = (channel: string | undefined): string | undefined => (channel?.startsWith('ws:') ? channel.slice(3) : undefined);

/** The board's tasks as "@BLG-24" can name them (archived ones aren't offered). */
export function useTaskMentions(): readonly TaskMention[] {
  const issues = useApp((st) => st.board.issues);
  return useMemo(() => issues.filter((i) => !i.archivedAt).map((i) => ({ key: i.key, title: i.title, status: i.status, open: isOpen(i.status) })), [issues]);
}

/**
 * What mentions can name in this conversation (its worktree's files, when it has one). `tasks`:
 * "@BLG-24" names a task on your board (only for your own words: someone else's key may be theirs).
 */
export function useMentionWorld(channel: string | undefined, { tasks: withTasks = false }: { tasks?: boolean } = {}): MentionWorld {
  const friends = useApp((st) => st.network.friends);
  const taskList = useTaskMentions();
  const tasks = withTasks ? taskList : undefined;
  const peers = useApp((st) => st.peers);
  const projects = useApp((st) => st.projects);
  const selfId = useApp((st) => st.selfId);
  const dirCache = useApp((st) => st.dirCache);
  const ws = worktreeOf(channel);
  return useMemo(() => {
    const share = ws ? shareNameOf(ws) : undefined;
    return {
      friends: friends.map((f) => ({ name: f.name, peerId: f.peerId })),
      peers: peers.map((p) => ({ name: p.name, peerId: p.peerId })),
      projects: projects.filter((p) => p.root).map((p) => ({ name: p.name, id: p.id })),
      workspaces: workspaceMentions(projects),
      ...(share ? { entries: (dir: string) => dirCache[`${selfId}:${share}/${dir}`] } : {}),
      ...(tasks ? { tasks } : {}),
    };
  }, [friends, peers, projects, selfId, dirCache, ws, tasks]);
}

export function MentionPill({ mention }: { mention: MentionRef }) {
  // A task is the board's own live chip (its status, key and title; a click opens it).
  if (mention.kind === 'task') return <TaskChip taskKey={mention.id ?? mention.label} />;
  return <Pill mention={mention} />;
}

function Pill({ mention }: { mention: MentionRef }) {
  const { client } = useBeluga();
  const actions = useActions();
  const open = (): void => {
    const go = (view: Parameters<typeof client.store.dispatch>[0] & { type: 'view' }): void => void client.store.dispatch(view);
    if (mention.kind === 'friend' && mention.id) go({ type: 'view', view: { kind: 'conversation', id: `dm:${mention.id}` } });
    else if (mention.kind === 'project' && mention.id) go({ type: 'view', view: { kind: 'project', id: mention.id } });
    else if (mention.kind === 'workspace' && mention.id) go({ type: 'view', view: { kind: 'workspace', id: mention.id, tab: 'chat' } });
    else if (mention.path) actions.openLink({ kind: 'local', path: mention.path, dir: mention.kind === 'folder' });
  };
  const clickable = mention.kind !== 'claude';
  return (
    <button type="button" className={s.pill} data-kind={mention.kind} disabled={!clickable} title={`${WHAT[mention.kind]}: ${mention.label}`} aria-label={`${WHAT[mention.kind]} ${mention.label}`} onClick={open}>
      <Icon name={ICON[mention.kind]} size={11} />
      <span>{mention.label}</span>
    </button>
  );
}
