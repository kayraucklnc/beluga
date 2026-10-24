import type { DomainState, View } from '../core/store.js';
import { FIRST_CHAT, assistantChatOf } from '../shared/assistant.js';
import { viewFor } from '../client/screen.js';

/**
 * "Open on your Mac" from the phone (BLG-40): what the Mac app's window shows for something the
 * phone has open (a conversation, a plan, a task, a friends' chat, something that needs you).
 * The daemon sends it to every screen as a `navigate` intent and asks the Mac app to raise its
 * window (its `raise` capability). Pure, so it's tested without a window.
 */

export interface OpenTarget {
  /** A phone topic: `conv:…`, `plan:…`, `task:…`, `chat:…`, or a list (`work`, `plans`, `tasks`, `chats`, `people`, `home`). */
  readonly topic?: string;
  /** A needs-you item's id, when it has no topic of its own ("request:<task>", "knock:<peer>", "join:<group>:<peer>"). */
  readonly need?: string;
}

/** The Mac's view for what the phone has open, or undefined when there's nothing by that name. */
export function macViewFor(state: DomainState, target: OpenTarget): View | undefined {
  const topic = target.topic;
  if (topic) {
    if (topic.startsWith('conv:')) {
      const channel = topic.slice(5);
      if (channel === 'room') return { kind: 'room' };
      const chat = assistantChatOf(channel);
      if (chat) {
        // One of Your Mac's chats (BLG-102); the first after it was deleted is the one open.
        if (state.assistant.chats.some((c) => c.id === chat)) return { kind: 'assistant', chat };
        return chat === FIRST_CHAT ? { kind: 'assistant' } : undefined;
      }
      if (channel.startsWith('task:')) return { kind: 'requests' };
      if (channel.startsWith('ws:')) {
        const id = channel.slice(3);
        // A project's main checkout: the chat its old conversation became, else the project's home (BLG-70).
        if (state.projects.some((p) => p.workspaces.some((w) => w.id === id))) return viewFor({ kind: 'workspace', id, tab: 'chat' }, state);
        const shared = state.shared.find((w) => w.id === id);
        return shared ? { kind: 'shared', owner: shared.owner, id, tab: 'chat' } : undefined;
      }
      return undefined;
    }
    if (topic.startsWith('plan:')) {
      const id = topic.slice(5);
      return state.plans.plans.some((p) => p.id === id) ? { kind: 'plan', id } : undefined;
    }
    if (topic.startsWith('task:')) {
      const id = topic.slice(5);
      return state.board.issues.some((i) => i.id === id) ? { kind: 'task', id } : undefined;
    }
    if (topic.startsWith('chat:')) return { kind: 'conversation', id: topic.slice(5) };
    if (topic === 'tasks') return { kind: 'tasks' };
    if (topic === 'plans') return { kind: 'plans' };
    if (topic === 'work' || topic === 'home') return { kind: 'overview' };
    if (topic === 'chats' || topic === 'people') return { kind: 'overview' };
    return undefined;
  }
  const need = target.need ?? '';
  // A friend's request and the tasks between Claudes live in Requests; someone at the door, the room.
  if (need.startsWith('request:') || need.startsWith('confirm:') || need.startsWith('gwq:')) return { kind: 'requests' };
  if (need.startsWith('knock:')) return { kind: 'room' };
  const join = /^join:([^:]+):/.exec(need);
  if (join) return { kind: 'conversation', id: `group:${join[1]}` };
  return need ? { kind: 'overview' } : undefined;
}
