import { transcriptOf } from '../agent-switch.js';
import { assistantOf } from '../assistant/registry.js';
import { belugaHome } from '../home.js';
import { isPlanHome } from '../plans/model.js';
import { sentinelOf } from '../sentinel/registry.js';
import { ownClaude } from '../own-agent.js';
import { loadSettings } from '../settings.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import { assistantChatOf, isAssistant } from '../../shared/assistant.js';
import { attachSchedules, detachSchedules } from './registry.js';
import { CONTRIBUTOR_REASON, Schedules, type ChatCheck } from './service.js';

/**
 * Start schedules in chats for the daemon: saved in ~/.beluga/schedules.json (the demo's in
 * memory). The service always exists, and the setting chatSchedules decides whether it does
 * anything. Your Mac's assistant launches later, so it's looked up when needed. → stop.
 */

const SENTINEL_RUN = 'A Sentinel run’s chat can’t have a schedule, because it belongs to that run.';

export interface SchedulesHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
  /** For tests: the clock, and 0 for no timers. */
  readonly now?: () => number;
  readonly tickMs?: number;
}

export function launchSchedules(host: SchedulesHost): () => void {
  const { session, store } = host;
  const claude = ownClaude(session, store);
  const schedules = new Schedules({
    dir: host.demo ? null : belugaHome(),
    now: host.now ?? Date.now,
    enabled: () => loadSettings().chatSchedules,
    ...(host.tickMs !== undefined ? { tickMs: host.tickMs } : {}),
    busy: (channel) => session.host.busyIn(channel) || Boolean(session.agentTerms?.driving(channel)),
    check: (channel) => chatCheck(session, channel),
    ensureLoaded: (channel) => {
      if (channel.startsWith('ws:')) session.workspaces?.ensureLoaded(channel.slice(3));
    },
    line: (channel, text, level, schedule) => void store.dispatch({ type: 'system', text, level, channel, ...(schedule ? { schedule } : {}) }),
    ask: (prompt, channel) => claude.ask(prompt, channel, false),
    wait: (requestId) => claude.wait(requestId),
    cancel: (requestId, note) => claude.cancel(requestId, note),
    notify: (event) => session.notifier.notify(event),
    publish: (items) => {
      store.dispatch({ type: 'schedules', items });
      session.sharing.schedulesChanged();
    },
    fill: (channel) => session.host.contextFill(channel),
    compact: (channel, instructions) => session.host.compactNow(channel, instructions),
    forget: (channel) => session.startFresh(channel),
    transcript: (channel) => transcriptOf(store.getState().log, channel),
  });
  attachSchedules(session, schedules);
  session.sharing.guestSchedules = (channel) => schedules.forGuests(channel);
  session.sharing.schedulesChanged();
  const offWorktree = session.workspaces?.onWorktree((event) => {
    if (event.kind === 'leaving') schedules.chatLeaving(`ws:${event.id}`, event.how);
    if (event.kind === 'removed') schedules.chatGone(`ws:${event.id}`);
    if (event.kind === 'project_removed') for (const id of event.ids) schedules.chatGone(`ws:${id}`);
  });
  // In the dispatch, so before an invite goes out: the new contributor can't post until it's paused.
  const offMembers = store.onAction((action) => {
    if (action.type === 'member_set' && action.role === 'contribute') schedules.contributorJoined(`ws:${action.id}`);
    // The setting is saved right after this action, and with it off guests have no list.
    if (action.type === 'prefs' && 'chatSchedules' in action.prefs) queueMicrotask(() => session.sharing.schedulesChanged());
  });
  return () => {
    offWorktree?.();
    offMembers();
    schedules.stop();
    session.sharing.guestSchedules = undefined;
    detachSchedules(session);
    claude.close();
  };
}

/** Whether this chat keeps a saved session and is yours alone. Checked at create, at resume and before each tick's decision. */
function chatCheck(session: Session, channel: string): ChatCheck {
  if (isAssistant(channel)) return macChatCheck(session, channel);
  if (!channel.startsWith('ws:')) return { kind: 'refused', reason: 'Only a worktree chat, a project chat or a Your Mac chat can have a schedule, because only those keep a saved session.' };
  if (session.sharing.sharedFor(channel)) return { kind: 'refused', reason: 'Only the owner of a chat can give it a schedule.' };
  const manager = session.workspaces?.manager;
  if (!manager) return { kind: 'wait' };
  const id = channel.slice(3);
  const ws = manager.find(id);
  // Projects not read yet, or a folder out of reach, can't say a chat is gone for good.
  if (!ws) return manager.list.length && !manager.list.some((p) => p.error) ? { kind: 'gone' } : { kind: 'wait' };
  if (ws.archived) return { kind: 'refused', reason: 'This chat is archived. Restore it first.' };
  if (ws.kind === 'main') return { kind: 'refused', reason: 'A main folder has no conversation of its own, so it can’t have a schedule. Use a chat of the project.' };
  if (isPlanHome(session.store.getState().plans, channel)) return { kind: 'refused', reason: 'A plan’s own chat can’t have a schedule, because the plan runs there.' };
  if (sentinelOf(session)?.forRun(channel, session.selfId)?.inRun) return { kind: 'refused', reason: SENTINEL_RUN };
  if (Object.values(session.sharing.members(id)).includes('contribute')) return { kind: 'refused', reason: CONTRIBUTOR_REASON };
  return { kind: 'ok' };
}

function macChatCheck(session: Session, channel: string): ChatCheck {
  const mac = assistantOf(session);
  if (!mac) return { kind: 'wait' };
  const id = assistantChatOf(channel);
  const chat = mac.chats().chats.find((c) => c.id === id);
  if (!chat) return { kind: 'gone' };
  return chat.auto ? { kind: 'refused', reason: SENTINEL_RUN } : { kind: 'ok' };
}
