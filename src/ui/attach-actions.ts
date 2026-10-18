import { statSync } from 'node:fs';
import path from 'node:path';
import {
  ATTACHMENT_SHARE,
  chipText,
  droppedImagePaths,
  expandChips,
  importImage,
  insertChip,
  publishForRoom,
  registerAttachment,
  roomAttachmentsDir,
  saveClipboardImage,
} from '../core/attachments.js';
import type { Session } from '../core/session.js';
import { channelOf } from '../core/store.js';
import type { UiState } from './keymap.js';

export interface AttachContext {
  readonly session: Session;
  readonly uiRef: { readonly current: UiState };
  readonly patchUi: (patch: Partial<UiState>) => void;
}

/** Put image chips at the cursor in the box you type in. */
function addChips(c: AttachContext, files: readonly string[]): void {
  let { buffer, cursor } = c.uiRef.current;
  for (const file of files) {
    const a = registerAttachment(file, statSync(file).size);
    ({ buffer, cursor } = insertChip(buffer, cursor, chipText(a.n)));
  }
  c.patchUi({ focus: 'chat', buffer, cursor, suggestHidden: true });
}

/**
 * Attach the image on the clipboard (Ctrl+V, or a paste that arrived empty, which is what
 * Cmd+V on an image sends in most terminals). `quiet`: say nothing when there's no image.
 */
export async function pasteClipboardImage(c: AttachContext, quiet = false): Promise<boolean> {
  try {
    const file = await saveClipboardImage();
    if (file) {
      addChips(c, [file]);
      return true;
    }
  } catch (err) {
    c.session.toast(`Couldn't attach the image: ${err instanceof Error ? err.message : String(err)}`, 'warn');
    return false;
  }
  if (!quiet) c.session.toast(process.platform === 'darwin' || process.platform === 'linux' ? 'No image on the clipboard. Copy one, then Ctrl+V' : 'Pasting images works on macOS and Linux', 'warn');
  return false;
}

/**
 * Pasted text that is only image file paths (dragging files into the terminal pastes them)
 * becomes image chips. Returns true when it did, so the text isn't typed as well.
 */
export function pasteDroppedImages(c: AttachContext, text: string): boolean {
  if (c.uiRef.current.focus !== 'chat') return false;
  const files = droppedImagePaths(text);
  if (!files) return false;
  void Promise.all(files.map((f) => importImage(f)))
    .then((copies) => addChips(c, copies))
    .catch((err: unknown) => c.session.toast(err instanceof Error ? err.message : String(err), 'warn'));
  return true;
}

/**
 * Before sending: "[image N]" chips become links to the images. Sent to the room with friends
 * there, a copy goes where they (and only they) can fetch it.
 */
export function expandOutgoing(session: Session, text: string): string {
  if (!text.includes('[image ') || text.startsWith('/')) return text;
  const state = session.store.getState();
  // People in the room only: guests invited into one project (or still knocking) never get room images.
  const friends = state.peers.filter((p) => p.peerId !== session.selfId && !p.guest && !session.invites.isRestricted(p.peerId)).map((p) => p.peerId);
  const toRoom = channelOf(state.view) === 'room' && friends.length > 0;
  const { text: out, attachments } = expandChips(text, session.selfId, toRoom ? (a) => publishForRoom(a) : (a) => path.basename(a.path));
  if (toRoom && attachments.length) session.serveFolder(ATTACHMENT_SHARE, roomAttachmentsDir(), friends);
  return out;
}
