import type { DomainState } from '../core/store.js';
import { FIRST_CHAT, assistantChatOf } from '../shared/assistant.js';

/**
 * Which of the phone's conversations are no longer on the Mac (BLG-124), so the files the phone
 * saved from them can go: a worktree or chat folder of yours that's archived, one that's deleted
 * (neither yours nor shared with you any more), or one of Your Mac's chats that was deleted.
 * Everything else stays (the room, tasks you asked of friends, plans): the phone keeps what it
 * isn't told is gone. Pure, so it's tested without a Mac.
 */
export function goneTopics(state: DomainState, topics: readonly string[]): string[] {
  // A Mac still loading its projects knows of none: nothing is gone yet.
  if (!state.projects.length) return [];
  return [...new Set(topics)].filter((topic) => {
    if (!topic.startsWith('conv:')) return false;
    const channel = topic.slice(5);
    const chat = assistantChatOf(channel);
    if (chat) return chat !== FIRST_CHAT && !state.assistant.chats.some((c) => c.id === chat);
    if (!channel.startsWith('ws:')) return false;
    const id = channel.slice(3);
    const own = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id);
    if (own) return Boolean(own.archived);
    return !state.shared.some((w) => w.id === id);
  });
}
