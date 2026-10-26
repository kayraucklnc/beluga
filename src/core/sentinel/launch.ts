import { belugaHome } from '../home.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import { assistantOf } from '../assistant/registry.js';
import { assistantChannel } from '../../shared/assistant.js';
import { commandEnv } from '../views/sources.js';
import { gatewayOf } from '../gateway/registry.js';
import { isFinal } from '../gateway/model.js';
import { networkOf } from '../network.js';
import { status } from '../../workspaces/git.js';
import { findPr, mergePr } from '../../workspaces/pr.js';
import type { PullRequest } from '../work-store.js';
import { demoGitHub, seedDemoSentinel } from './demo.js';
import { attachSentinel, detachSentinel } from './registry.js';
import type { PrLook, PrPlace, SentinelChat, SentinelClaude, SentinelFriends, SentinelGitHub, SentinelPlaces } from './runner.js';
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
    // The demo's pull requests open, pass and merge without GitHub.
    github: host.demo ? demoGitHub() : github(session, store),
    chat: chat(session, store),
    friends: friends(session),
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

const FAILED = new Set(['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);

/** A pull request as the merge gate reads it. */
export function prLook(pr: PullRequest): PrLook {
  const runs = pr.checkRuns ?? [];
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    draft: pr.draft,
    conflicts: Boolean(pr.conflicts),
    checks: pr.checks,
    failed: runs.filter((c) => c.state === 'completed' && FAILED.has(c.conclusion ?? '')).map((c) => c.name),
    count: runs.length,
  };
}

/** GitHub through the workbench (its PR steps, its toasts and state) and gh. */
function github(session: Session, store: Store): SentinelGitHub {
  const bench = session.workbench;
  const ctl = session.workspaces;
  const live = (id: string | undefined) => {
    const ws = id ? ctl?.manager.find(id) : undefined;
    return ws && !ws.archived ? ws : undefined;
  };
  /** Where gh runs for a pull request: its worktree, else the project's main folder. */
  const dirOf = (where: PrPlace): string | undefined => live(where.workspaceId)?.path ?? store.getState().projects.find((p) => p.id === where.projectId)?.root;
  return {
    openPr: async (workspaceId, opts) => {
      if (!bench) return 'pull requests need the Beluga app';
      const out = await bench.quickPr(workspaceId, opts.draft ? { draft: true } : {});
      const pr = store.getState().prs[workspaceId];
      if (!out.ok || !pr) return out.message || 'GitHub didn’t open the pull request';
      return { number: pr.number, url: pr.url };
    },
    look: async (where, number) => {
      const dir = dirOf(where);
      if (!dir) return 'its worktree and project are gone';
      const pr = await findPr(dir, String(number));
      return pr ? prLook(pr) : `GitHub has no pull request #${number} here (or gh isn’t set up: brew install gh, then gh auth login)`;
    },
    review: async (where, pr) => {
      const ws = live(where.workspaceId);
      if (!ws) return undefined;
      const project = store.getState().projects.find((p) => p.id === ws.projectId);
      const base = (ws.base ?? project?.base ?? 'main').replace(/^origin\//, '');
      const title = store.getState().prs[ws.id]?.title;
      return session.reviewPr({ dir: ws.path, number: pr.number, base, ...(title ? { title } : {}) });
    },
    merge: async (where, pr, method) => {
      const ws = live(where.workspaceId);
      if (bench && ws && store.getState().prs[ws.id]) {
        const out = await bench.mergePr(ws.id, { method, deleteBranch: true });
        return out.ok ? true : out.message;
      }
      const dir = dirOf(where);
      if (!dir) return 'its worktree and project are gone';
      await mergePr(dir, pr.number, { method });
      return true;
    },
  };
}

/** The Beluga network's chats, as you: an error in words while it's off. */
function chat(session: Session, store: Store): SentinelChat {
  const net = () => store.getState().network;
  return {
    post: (to, text) => void networkOf(session).post(to, text),
    nameOf: (to) => (to.startsWith('dm:') ? net().friends.find((f) => f.peerId === to.slice(3))?.name : to.startsWith('group:') ? net().groups.find((g) => g.id === to.slice(6))?.name : undefined),
    friends: () => net().friends,
    shares: (to, peerId) => networkOf(session).shares(to, peerId),
    tell: (peerId, note) => void networkOf(session).sendDm(peerId, note),
    me: () => store.getState().self?.name ?? net().self?.name ?? 'A friend',
  };
}

/** A friend's Claude through the gateway, asked as you (their trust applies). */
function friends(session: Session): SentinelFriends {
  const need = () => {
    const gw = gatewayOf(session);
    if (!gw) throw new Error('asking a friend’s Claude needs the Beluga network: turn it on in Settings › Network');
    return gw;
  };
  return {
    ask: (input) => need().ask({ ...input, by: 'person' }).id,
    wait: async (id, ms) => {
      const t = await need().wait(id, Math.max(1, ms));
      return { state: t.state, final: isFinal(t.state), name: `${t.peerName}’s Claude`, ...(t.result?.summary ? { summary: t.result.summary } : {}), ...(t.result?.data !== undefined ? { data: t.result.data } : {}) };
    },
    cancel: (id) => {
      try {
        need().cancel(id);
      } catch {
        // It ended already.
      }
    },
  };
}
