import type { Location } from '@beluga/core/store.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { revealLine } from '../views/reader/reveal.js';
import { openFocus } from './panel.js';

/**
 * Go straight to a worktree's file: it opens across the center, scrolled to the line and flashed
 * (Esc goes back to the chat). From a code block in chat or a comment on a PR.
 */
export async function goToCode(client: SocketClient, wsId: string, path: string, line?: number): Promise<void> {
  const at: Location = { owner: client.store.getState().selfId, share: shareNameOf(wsId), path: path.replace(/^\.\//, '') };
  if (line) revealLine(at, line);
  await client.api.files.open(at);
  openFocus('file', wsId);
}
