import type { AppState, Location } from '@beluga/core/store.js';
import { peerName } from '@beluga/core/store.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { inApp } from './boot.js';

/**
 * Files you see in Beluga, the Mac way: where one is on this Mac (to show it in Finder or copy
 * its path), and saving a friend's file where you choose with the standard Save panel.
 */

const join = (root: string, rel: string): string => (rel ? `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}` : root);

/** The file's place on this Mac, when it's yours (your shares and workspaces); otherwise undefined. */
export function localPathOf(state: AppState, at: Location): string | undefined {
  if (at.owner !== state.selfId) return undefined;
  const share = state.myShares.find((s) => s.name === at.share);
  if (share?.root) return join(share.root, at.path);
  for (const p of state.projects) {
    const ws = p.workspaces.find((w) => shareNameOf(w.id) === at.share);
    if (ws) return join(ws.path, at.path);
  }
  return undefined;
}

/** How to name a file in a message: its path in your own workspace, else "bob:share/path". */
export function mentionOf(state: AppState, at: Location): string {
  const ws = state.view.kind === 'workspace' ? state.view.id : undefined;
  if (ws && at.owner === state.selfId && at.share === shareNameOf(ws)) return at.path || '.';
  return `${peerName(state, at.owner)}:${at.share}/${at.path}`;
}

const parentOf = (p: string): string => p.replace(/\/[^/]*\/?$/, '') || '/';

/** Show a file of yours selected in Finder (in development: open its folder). */
export async function revealInFinder(client: SocketClient, path: string): Promise<void> {
  if (inApp()) {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(path);
    return;
  }
  await client.api.local.openFolder(parentOf(path));
}

/** Files that run something when opened (opening one shows it in Finder instead). */
const RUNS = /\.(command|tool|app|pkg|mpkg|terminal|workflow|scpt|scptd|action|sh|zsh|bash|py|rb|pl|jar)$/i;

/** Open a file of yours the way Finder would (its default app, usually your editor). */
export async function openWithDefaultApp(client: SocketClient, path: string): Promise<void> {
  if (RUNS.test(path)) return revealInFinder(client, path);
  await client.api.local.openFolder(path);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Download a shared file: the Save panel picks where (starting in Downloads, with its name), then
 * Beluga fetches it there. Cancelling the panel does nothing. Outside the app it goes to ~/Downloads/Beluga.
 */
export async function saveFile(client: SocketClient, at: Location): Promise<void> {
  const name = at.path.split('/').pop() || 'download';
  try {
    if (!inApp()) {
      await client.api.files.download(at);
      return;
    }
    const [{ save }, { downloadDir }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/api/path')]);
    const dir = await downloadDir().catch(() => '');
    const to = await save({ title: `Save ${name}`, defaultPath: dir ? join(dir, name) : name });
    if (to) await client.api.files.download(at, { to });
  } catch (err) {
    client.store.dispatch({ type: 'toast', text: `Couldn't save ${name}: ${errorText(err)}`, level: 'error' });
  }
}
