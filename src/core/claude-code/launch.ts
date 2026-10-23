import os from 'node:os';
import path from 'node:path';
import { belugaHome } from '../home.js';
import type { Store } from '../store.js';
import type { NoticeEvent } from '../notify.js';
import { ClaudeCodeWatcher } from './watch.js';
import { belugaEnv } from '../beluga-env.js';

/**
 * Start watching Claude Code for the daemon (the Mac app's Beluga). Claude Code's folder is
 * ~/.claude, or $CLAUDE_CONFIG_DIR when you moved it; BELUGA_CLAUDE_HOME points elsewhere (tests).
 * The demo watches only when BELUGA_CLAUDE_HOME is set (it never shows your real sessions).
 */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return belugaEnv('CLAUDE_HOME', env) || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

const watchers = new WeakMap<object, ClaudeCodeWatcher>();

export const attachClaudeCode = (session: object, watcher: ClaudeCodeWatcher): void => void watchers.set(session, watcher);

/** The Claude Code watcher of this session, or a clear error where there's none (the terminal app). */
export function claudeCodeOf(session: object): ClaudeCodeWatcher {
  const watcher = watchers.get(session);
  if (!watcher) throw new Error('Claude Code sessions show in the Beluga app for Mac (its daemon).');
  return watcher;
}

export function launchClaudeCode(host: { readonly session: object; readonly store: Store; readonly demo: boolean; readonly notify?: (event: NoticeEvent) => void }): () => void {
  if (host.demo && !belugaEnv('CLAUDE_HOME')) return () => undefined;
  const watcher = new ClaudeCodeWatcher({
    home: claudeHome(),
    store: host.store,
    // The demo keeps nothing on disk.
    ...(host.demo ? {} : { ownFile: path.join(belugaHome(), 'claude-code-own.json') }),
    notify: ({ title, body, failed }) => host.notify?.({ kind: failed ? 'problems' : 'background', tag: 'task', title, body }),
  });
  attachClaudeCode(host.session, watcher);
  watcher.start();
  return () => watcher.stop();
}
