import { useMemo } from 'react';
import { workspaceMentions } from '@klaud/core/mentions.js';
import { shareNameOf } from '@klaud/shared/share-names.js';
import { Icon, type IconName } from '../components/Icon.js';
import { useActions } from '../lib/actions.js';
import { useApp, useKlaud } from '../lib/klaud.js';
import { type MentionKind, type MentionRef, type MentionWorld } from './mentions.js';
import s from './mention.module.css';

/**
 * A mention that names someone or something real, drawn as a pill: a friend, a Claude, a
 * project, a worktree, a folder or a file. A click opens it (a friend's conversation, the
 * project, the worktree, the file).
 */

const ICON: Readonly<Record<MentionKind, IconName>> = { friend: 'person', claude: 'claude', project: 'grid', workspace: 'branch', folder: 'folder', file: 'file', image: 'image' };
const WHAT: Readonly<Record<MentionKind, string>> = { friend: 'Friend', claude: 'Claude', project: 'Project', workspace: 'Worktree', folder: 'Folder', file: 'File', image: 'Image' };

/** The worktree a conversation is in ("ws:<id>"), if it is one. */
export const worktreeOf = (channel: string | undefined): string | undefined => (channel?.startsWith('ws:') ? channel.slice(3) : undefined);

/** What mentions can name in this conversation (its worktree's files, when it has one). */
export function useMentionWorld(channel: string | undefined): MentionWorld {
  const friends = useApp((st) => st.network.friends);
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
    };
  }, [friends, peers, projects, selfId, dirCache, ws]);
}

export function MentionPill({ mention }: { mention: MentionRef }) {
  const { client } = useKlaud();
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
