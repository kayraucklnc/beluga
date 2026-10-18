import { useMemo } from 'react';
import type { Location } from '@klaud/core/store.js';
import type { LinkTarget } from '@klaud/shared/link-target.js';
import { ATTACHMENT_SHARE } from '@klaud/core/attachment-share.js';
import type { UiState } from '@klaud/ui/keymap.js';
import type { MenuKind } from '@klaud/ui/menus.js';
import { type MenuContext, runMenu as runSharedMenu } from '@klaud/ui/menu-actions.js';
import { submitTyped } from '@klaud/ui/submit.js';
import { type UiActionContext, runUiActionWith } from '@klaud/ui/ui-actions.js';
import type { UiAction } from '@klaud/ui/workspace-models.js';
import type { SocketClient } from '@klaud/ipc/socket-client.js';
import { type UiStore, useKlaud } from './klaud.js';
import { openExternal } from './system.js';

export interface Actions {
  /** Do what a clicked row, button or card means (the same actions as the terminal UI). */
  run(action: UiAction): void;
  /** Pick an option of a menu (by its index in the menu's spec). */
  pick(menu: MenuKind, index: number): void;
  /** Send what's in the composer. */
  submit(text: string, urgent?: boolean): void;
  /** Put text in the composer and focus it. */
  typeInto(text: string): void;
  /** Open a link from the chat. */
  openLink(link: LinkTarget): void;
}

/** Wire the shared action runners to this window. */
export function makeActions(client: SocketClient, ui: UiStore): Actions {
  const patchUi = (patch: Partial<UiState>): void => ui.patch(patch);
  const typeInto = (buffer: string): void => {
    ui.patch({ focus: 'chat', buffer, cursor: buffer.length, suggestHidden: false, selected: 0 });
    document.dispatchEvent(new CustomEvent('klaud:focus-composer'));
  };
  const toast = (text: string): void => client.store.dispatch({ type: 'toast', text });
  const openLink = (link: LinkTarget): void => {
    const go = (at: Location, dir: boolean): void => {
      const view = client.store.getState().view;
      if (dir) {
        if (view.kind === 'workspace' || view.kind === 'shared') {
          actions.run(view.kind === 'workspace' ? { type: 'open_ws', id: view.id, tab: 'files' } : { type: 'open_shared', owner: view.owner, id: view.id, tab: 'files' });
          setTimeout(() => void client.api.files.browseTo(at), 40);
        } else {
          client.store.dispatch({ type: 'view', view: { kind: 'files' } });
          void client.api.files.browseTo(at);
        }
        return;
      }
      if (view.kind !== 'room' && view.kind !== 'files' && view.kind !== 'workspace' && view.kind !== 'shared') client.store.dispatch({ type: 'view', view: { kind: 'files' } });
      void client.api.files.open(at);
    };
    switch (link.kind) {
      case 'url':
        void openExternal(link.url);
        return;
      case 'local':
        void client.api.session.localLocation(link.path, link.dir).then((at) => go(at, link.dir));
        return;
      case 'peer':
        go({ owner: link.owner, share: link.share, path: link.path }, !link.path || !/\.[^/]+$/.test(link.path));
        return;
      case 'attachment':
        go({ owner: link.owner, share: ATTACHMENT_SHARE, path: link.file }, false);
        return;
      case 'href':
        return;
    }
  };
  const menuCtx: MenuContext = {
    client,
    patchUi,
    typeInto,
    askForName: (kind, projectId) => {
      const project = client.store.getState().projects.find((p) => p.id === projectId);
      patchUi({ focus: 'chat', buffer: '', cursor: 0, pending: { kind, projectId } });
      document.dispatchEvent(new CustomEvent('klaud:focus-composer'));
      toast(kind === 'group' ? 'Type a name for the new group, then Return' : `Type a name for the new ${kind}${project?.root ? ` in ${project.name}` : ''}, then Return`);
    },
    openFolder: (dir) => void client.api.local.openFolder(dir),
    runUiAction: (a) => actions.run(a),
    write: () => undefined,
  };
  const uiCtx: UiActionContext = {
    client,
    patchUi,
    uiRef: {
      get current() {
        return ui.get();
      },
      set current(_v) {
        // read-only here: the shared code patches through patchUi.
      },
    },
    toggle: (key) => {
      const collapsed = ui.get().collapsed;
      patchUi({ collapsed: collapsed.includes(key) ? collapsed.filter((c) => c !== key) : [...collapsed, key] });
    },
    typeInto,
    menuCtx: () => menuCtx,
    runMenu: (m, i) => actions.pick(m, i),
    openLink,
    pasteImage: () => toast('Paste an image with ⌘V in the message box'),
  };
  const actions: Actions = {
    run: (action) => runUiActionWith(uiCtx, action),
    pick: (menu, index) => {
      ui.patch({ menu: undefined });
      runSharedMenu(menuCtx, menu, index);
    },
    submit: (text, urgent) => submitTyped({ client, ui: () => ui.get(), patchUi, runUiAction: (a) => actions.run(a) }, text, urgent),
    typeInto,
    openLink,
  };
  return actions;
}

export function useActions(): Actions {
  const { client, ui } = useKlaud();
  return useMemo(() => makeActions(client, ui), [client, ui]);
}
