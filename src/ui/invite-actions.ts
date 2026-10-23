import { DAY_MS } from '../shared/invites.js';
import type { BelugaClient } from '../ipc/client.js';
import type { GuestCan } from '../protocol.js';
import { type InviteChoice, copyIndex, inviteChoice, inviteMenu } from './invite-menus.js';
import type { MenuContext } from './menu-actions.js';
import type { MenuKind } from './menus.js';
import type { UiAction } from './workspace-models.js';

/** Open the Invite flow, with "Copy invite link" selected so Enter copies straight away. */
export function openInvite(ctx: MenuContext, from?: string, choice: InviteChoice = inviteChoice(from), selected?: number): void {
  const state = ctx.client.store.getState();
  const spec = inviteMenu(state, choice, state.self?.host === true);
  ctx.patchUi({ menu: { menu: { kind: 'invite_link', ...choice }, selected: selected ?? copyIndex(spec) } });
}

/** The project of the workspace you're looking at (invites from there default to it). */
export function projectInView(client: BelugaClient): string | undefined {
  const state = client.store.getState();
  if (state.view.kind !== 'workspace') return undefined;
  const id = state.view.id;
  return state.projects.find((p) => p.root && p.workspaces.some((w) => w.id === id))?.id;
}

function runInviteMenu(ctx: MenuContext, c: InviteChoice, id: string, index: number): boolean {
  const reopen = (patch: Partial<InviteChoice>): void => openInvite(ctx, c.from, { ...c, ...patch }, index);
  const [verb, arg = ''] = id.split(/:(.*)/s) as [string, string?];
  switch (verb) {
    case 'il-scope':
      reopen({ scope: arg });
      return true;
    case 'il-can':
      reopen({ can: arg as GuestCan });
      return true;
    case 'il-knock':
      reopen({ knock: !c.knock });
      return true;
    case 'il-single':
      reopen({ singleUse: !c.singleUse });
      return true;
    case 'il-expires':
      reopen({ expires: !c.expires });
      return true;
    case 'il-copy':
      void ctx.client.api.invites.create({ scope: c.scope, can: c.can, knock: c.knock, singleUse: c.singleUse, expiresInMs: c.expires ? DAY_MS : 0 });
      return true;
    case 'il-revoke':
      void ctx.client.api.invites.revoke(arg);
      // Stay in the menu: the rest of the list is still there.
      openInvite(ctx, c.from, c, Math.max(0, index - 1));
      return true;
    default:
      return false;
  }
}

/** Menu options for project links and guests. Returns false when it isn't one of these. */
export function runInviteOption(ctx: MenuContext, menu: MenuKind, id: string, index: number): boolean {
  const { client, patchUi } = ctx;
  const invites = client.api.invites;
  const latest = client.store.getState();
  if (menu.kind === 'invite_link') return runInviteMenu(ctx, menu, id, index);
  if (menu.kind === 'guest_add' && id.startsWith('ga:')) {
    void invites.change(menu.peerId, { addProject: id.slice(3) });
    return true;
  }
  if (id === 'invite-menu') {
    openInvite(ctx, projectInView(client));
    return true;
  }
  if (id === 'p-invite' && menu.kind === 'project') {
    openInvite(ctx, menu.id);
    return true;
  }
  if (id === 'ws-link' && menu.kind === 'ws_share') {
    openInvite(ctx, latest.projects.find((p) => p.workspaces.some((w) => w.id === menu.id))?.id);
    return true;
  }
  const guest = menu.kind === 'person' ? latest.guests[latest.peers[menu.index]?.peerId ?? ''] : undefined;
  if (!guest) return false;
  if (id.startsWith('g-can:')) {
    void invites.change(guest.peerId, { can: id.slice(6) as GuestCan });
    patchUi({ menu: { menu, selected: index } });
    return true;
  }
  switch (id) {
    case 'g-add':
      patchUi({ menu: { menu: { kind: 'guest_add', peerId: guest.peerId }, selected: 0 } });
      return true;
    case 'g-room':
      void invites.change(guest.peerId, { room: true });
      return true;
    case 'g-remove':
      void invites.remove(guest.peerId);
      return true;
    default:
      return false;
  }
}

/** Clicks on the knock card and in a shared workspace's Terminal. */
export function runInviteUiAction(client: BelugaClient, action: UiAction): boolean {
  const { api } = client;
  switch (action.type) {
    case 'knock':
      if (action.pick === 'decline') void api.invites.decline(action.peerId);
      else void api.invites.letIn(action.peerId, action.pick === 'watch' ? 'watch' : undefined);
      return true;
    case 'shell_open':
      void api.shell.openEntry(action.id, action.rel, action.dir);
      return true;
    case 'shell_run':
      void api.shell.run(action.id, action.cmd);
      return true;
    default:
      return false;
  }
}
