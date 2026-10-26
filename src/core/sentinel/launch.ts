import { belugaHome } from '../home.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import { assistantOf } from '../assistant/registry.js';
import { assistantChannel } from '../../shared/assistant.js';
import { commandEnv } from '../views/sources.js';
import { status } from '../../workspaces/git.js';
import { seedDemoSentinel } from './demo.js';
import { attachSentinel, detachSentinel } from './registry.js';
import type { SentinelClaude, SentinelPlaces } from './runner.js';
import { Sentinels } from './sentinels.js';

/**
 * Start Sentinel for the daemon (the Mac app's Beluga): sentinels in ~/.beluga/sentinel.json,
 * their runs' folders in ~/.beluga/sentinel/runs. The demo's live in memory and start with four
 * sentinels and their history. → stop.
 */

export interface SentinelHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

export function launchSentinel(host: SentinelHost): () => void {
  const { session, store } = host;
  // The demo's history is made "in the past".
  let back = 0;
  const claude = ownClaude(session, store);
  const sentinels = new Sentinels({
    store,
    dir: host.demo ? null : belugaHome(),
    now: () => Date.now() - back,
    selfId: () => session.selfId,
    claude,
    places: places(session),
    envFor: (cwd) => commandEnv(cwd),
    notify: (e) => session.notifier.notify(e),
  });
  attachSentinel(session, sentinels);
  const stopSeed = host.demo && !sentinels.list().length ? seedDemoSentinel(store, sentinels, (ms) => (back = ms)) : () => undefined;
  return () => {
    stopSeed();
    claude.close();
    detachSentinel(session);
    sentinels.stopAll();
    store.dispatch({ type: 'sentinel_off' });
  };
}

/** Your own Claude, asked in a conversation and waited for by its request (askAndWait's pattern, keyed by request). */
function ownClaude(session: Session, store: Store): SentinelClaude & { close(): void } {
  const waits = new Map<string, { readonly resolve: (text: string) => void; readonly reject: (err: Error) => void }>();
  const off = store.onAction((a) => {
    if (a.type !== 'agent_event') return;
    const w = waits.get(a.requestId);
    if (!w || !['done', 'error', 'denied'].includes(a.event)) return;
    waits.delete(a.requestId);
    if (a.event === 'done') w.resolve(a.text);
    else w.reject(new Error(a.text || a.event));
  });
  return {
    ask: (prompt, channel, shown) => session.askOwnClaude(prompt, channel, false, shown),
    wait: (requestId) => new Promise<string>((resolve, reject) => void waits.set(requestId, { resolve, reject })),
    // The wait stays until the request ends (its done or error event), so the run can wait for it
    // before archiving its worktree; one that never says so is let go after a while.
    cancel: (requestId, note) => {
      const letGo = (): void => {
        const w = waits.get(requestId);
        if (!w) return;
        waits.delete(requestId);
        w.reject(new Error('Stopped'));
      };
      // Not running (any more): nothing to wait for.
      if (!session.host.cancelRun(requestId, note)) return letGo();
      const timer = setTimeout(letGo, 15_000);
      timer.unref?.();
    },
    close: () => {
      off();
      for (const w of waits.values()) w.reject(new Error('Beluga closed'));
      waits.clear();
    },
  };
}

/** Where a run's Claude works: quiet chats and worktrees (the window stays where it is), Your Mac's chats. */
function places(session: Session): SentinelPlaces | undefined {
  const ctl = session.workspaces;
  if (!ctl) return undefined;
  return {
    projectChat: async (projectId, title) => {
      const ws = await ctl.newChat(projectId, title, undefined, { quiet: true });
      return ws ? { channel: `ws:${ws.id}`, workspaceId: ws.id } : undefined;
    },
    worktree: async (projectId, name) => {
      const ws = await ctl.startWorktree(projectId, '', (p) => session.nameTask(p), { quiet: true, name });
      return ws ? { channel: `ws:${ws.id}`, workspaceId: ws.id } : undefined;
    },
    macChat: () => {
      const mac = assistantOf(session);
      if (!mac) return undefined;
      return { channel: assistantChannel(mac.newChat()) };
    },
    madeChanges: async (workspaceId) => {
      const ws = ctl.manager.find(workspaceId);
      if (!ws || ws.archived) return undefined;
      const s = await status(ws.path, ws.base).catch(() => undefined);
      return s ? s.ahead > 0 || s.changed > 0 : undefined;
    },
    archive: (workspaceId) => ctl.archive(workspaceId, false, { quiet: true }),
  };
}
