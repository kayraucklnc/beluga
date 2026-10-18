import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ATTACHMENT_SHARE, attachmentsDir, roomAttachmentsDir } from '../core/attachments.js';
import type { KlaudClient } from '../ipc/client.js';
import type { Location } from '../core/store.js';
import type { UiState } from './keymap.js';
import type { LinkTarget } from './links.js';
import { type UiAction, findWorkspace } from './workspace-models.js';

export interface LinkContext {
  readonly client: KlaudClient;
  readonly patchUi: (patch: Partial<UiState>) => void;
  readonly run: (action: UiAction) => void;
}

/** Open a web page in the default browser. */
export function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

/** Rows to scroll so `line` (1-based) shows near the top, with a little context above. */
export const scrollForLine = (line: number): number => Math.max(0, line - 4);

/** Where the viewer is visible: the room, the Files view, or a workspace's Files tab (switching there if needed). */
function showViewer(c: LinkContext): void {
  const view = c.client.store.getState().view;
  if (view.kind === 'workspace' && view.tab !== 'files') c.run({ type: 'open_ws', id: view.id, tab: 'files' });
  else if (view.kind === 'shared' && view.tab !== 'files') c.run({ type: 'open_shared', owner: view.owner, id: view.id, tab: 'files' });
  else if (view.kind !== 'room' && view.kind !== 'files' && view.kind !== 'workspace' && view.kind !== 'shared') c.client.store.dispatch({ type: 'view', view: { kind: 'room' } });
}

async function openFile(c: LinkContext, at: Location, line?: number): Promise<void> {
  showViewer(c);
  await c.client.api.files.open(at);
  const v = c.client.store.getState().viewer;
  if (line && v && !v.error) c.client.store.dispatch({ type: 'viewer_scroll', delta: scrollForLine(line) - v.scroll });
}

function browse(c: LinkContext, at: Location): void {
  const state = c.client.store.getState();
  const view = state.view;
  // Inside the workspace you're in: its own Files tab, at that folder.
  if (view.kind === 'workspace' || view.kind === 'shared') {
    if (view.tab !== 'files') c.run(view.kind === 'workspace' ? { type: 'open_ws', id: view.id, tab: 'files' } : { type: 'open_shared', owner: view.owner, id: view.id, tab: 'files' });
    // Opening the tab lists its top folder first; go to the folder right after.
    setTimeout(() => void c.client.api.files.browseTo(at), 40);
  } else {
    c.client.store.dispatch({ type: 'view', view: { kind: 'files' } });
    void c.client.api.files.browseTo(at);
  }
  c.patchUi({ focus: 'files', entered: true });
}

/** Do what clicking a link in the chat means. */
export function openLink(c: LinkContext, link: LinkTarget): void {
  const { client } = c;
  const toast = (text: string, level?: 'warn'): void => client.store.dispatch({ type: 'toast', text, ...(level ? { level } : {}) });
  switch (link.kind) {
    case 'url':
      openUrl(link.url);
      toast(`Opened ${link.url.replace(/^https?:\/\//, '').slice(0, 60)} in your browser`);
      return;
    case 'local': {
      const view = client.store.getState().view;
      const ws = view.kind === 'workspace' ? findWorkspace(client.store.getState().projects, view.id) : undefined;
      const inWs = ws && (link.path === ws.path || link.path.startsWith(ws.path + path.sep));
      if (!inWs && view.kind === 'workspace' && link.dir) client.store.dispatch({ type: 'view', view: { kind: 'room' } });
      void client.api.session.localLocation(link.path, link.dir).then((at) => {
        if (link.dir) browse(c, at);
        else void openFile(c, at, link.line);
      });
      return;
    }
    case 'peer': {
      const at = { owner: link.owner, share: link.share, path: link.path };
      if (!link.path || !path.extname(link.path)) browse(c, at);
      else void openFile(c, at, link.line);
      return;
    }
    case 'attachment': {
      if (link.owner === client.store.getState().selfId) {
        const file = [path.join(attachmentsDir(), link.file), path.join(roomAttachmentsDir(), link.file)].find((f) => existsSync(f));
        if (!file) return toast('That image is gone from this computer', 'warn');
        void client.api.session.localLocation(file, false).then((at) => openFile(c, at));
      } else void openFile(c, { owner: link.owner, share: ATTACHMENT_SHARE, path: link.file });
      return;
    }
    case 'href':
      return;
  }
}
