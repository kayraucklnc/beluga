import { useMemo } from 'react';
import type { MentionWorld } from '../chat/mentions.js';
import { useApp } from '../lib/beluga.js';
import { usePeople } from './use-tasks.js';

/**
 * Who "@" can name in a task's boxes (New Task, a comment): the project's team first (a task can
 * be for them), then your other friends (Claude knows who you mean, but a task isn't theirs).
 * Never you. `world` marks them as pills; `shown` also marks you, for comments others wrote.
 */
export function useTaggable(
  projectId: string,
  selfId: string,
  projectName: string | undefined,
  selfName?: string,
): { people: ReadonlyArray<{ name: string; hint: string }>; world: MentionWorld; shown: MentionWorld } {
  const mates = usePeople(projectId);
  const friends = useApp((s) => s.network.friends);
  return useMemo(() => {
    const team = mates.filter((m) => m.id !== selfId);
    const others = friends.filter((f) => f.peerId !== selfId && !team.some((m) => m.id === f.peerId));
    const people = [
      ...team.map((m) => ({ name: m.name, hint: projectName ? `on ${projectName}` : 'on this project' })),
      ...others.map((f) => ({ name: f.name, hint: 'a friend' })),
    ];
    const named = [...team.map((m) => ({ name: m.name, peerId: m.id })), ...others.map((f) => ({ name: f.name, peerId: f.peerId }))];
    const world: MentionWorld = { friends: named, peers: [], projects: [], workspaces: [] };
    const shown: MentionWorld = selfName ? { ...world, friends: [...named, { name: selfName, peerId: selfId }] } : world;
    return { people, world, shown };
  }, [mates, friends, selfId, projectName, selfName]);
}
