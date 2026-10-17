import { EFFORTS, TRUST_LEVELS, type TrustLevel } from '../core/settings.js';
import { channelOf } from '../core/store.js';
import { cursorFor } from '../core/templates.js';
import { MOUSE_OFF, MOUSE_ON } from './mouse.js';
import type { MenuContext } from './menu-actions.js';
import type { MenuKind } from './menus.js';
import { TUNNEL_ORDER, type SettingsSection } from './settings-menus.js';
import type { WorkspaceAction } from './workspace-models.js';

const SECTIONS: readonly SettingsSection[] = ['claude', 'notify', 'workspaces', 'people', 'display', 'buttons'];
type NotifyKey = 'desktop' | 'sound' | 'done' | 'needsYou' | 'problems' | 'people' | 'pr';

/**
 * Options in the settings sections, the inbox, the model picker and the workspace menus
 * (PR, scripts, templates, handoff, remote worktrees). Returns false when it isn't one of these.
 */
export function runWorkOption(ctx: MenuContext, menu: MenuKind, id: string, index: number): boolean {
  const { session, patchUi, typeInto } = ctx;
  const latest = session.store.getState();
  const prefs = latest.prefs;
  const bench = session.workbench;
  const reopen = (): void => patchUi({ menu: { menu, selected: index } });
  const section = (s?: SettingsSection): void => patchUi({ menu: { menu: { kind: 'settings', ...(s ? { section: s } : {}) }, selected: 0 } });

  if (id.startsWith('sec:')) {
    const s = id.slice(4) as SettingsSection;
    if (SECTIONS.includes(s)) section(s);
    return true;
  }
  if (id === 'set-back') {
    section(undefined);
    return true;
  }
  if (id === 'set-back-workspaces') {
    section('workspaces');
    return true;
  }
  if (id.startsWith('n-') && id !== 'n-test') {
    const key = id.slice(2) as NotifyKey;
    if (key in prefs.notify) session.setPrefs({ notify: { ...prefs.notify, [key]: !prefs.notify[key] } });
    reopen();
    return true;
  }
  if (id.startsWith('btn:')) {
    const name = id.slice(4);
    session.setPrefs({ hiddenButtons: prefs.hiddenButtons.includes(name) ? prefs.hiddenButtons.filter((b) => b !== name) : [...prefs.hiddenButtons, name] });
    reopen();
    return true;
  }
  if (id.startsWith('model:') && menu.kind === 'model') {
    bench?.setModel(menu.channel, id.slice('model:'.length));
    if (!bench) session.setPrefs({ model: id.slice('model:'.length) || undefined });
    return true;
  }
  if (id.startsWith('trust:') && menu.kind === 'person') {
    const peer = latest.peers[menu.index];
    const level = id.slice('trust:'.length) as TrustLevel;
    if (peer && TRUST_LEVELS.includes(level)) session.people.setTrust(peer.peerId, level);
    reopen();
    return true;
  }
  if (id.startsWith('p-person:')) {
    const at = latest.peers.findIndex((p) => p.peerId === id.slice('p-person:'.length));
    if (at >= 0) patchUi({ menu: { menu: { kind: 'person', index: at }, selected: 0 } });
    return true;
  }
  if (id.startsWith('p-forget:')) {
    session.people.forget(id.slice('p-forget:'.length));
    reopen();
    return true;
  }
  if (id.startsWith('notice:')) {
    const notice = latest.inbox.find((n) => n.id === Number(id.slice('notice:'.length)));
    session.store.dispatch({ type: 'notice_read', id: notice?.id });
    const channel = notice?.channel;
    if (channel?.startsWith('ws:')) {
      const wsId = channel.slice(3);
      const shared = latest.shared.find((w) => w.id === wsId);
      if (shared) session.store.dispatch({ type: 'view', view: { kind: 'shared', owner: shared.owner, id: wsId, tab: 'chat' } });
      else session.workspaces?.open(wsId);
      patchUi({ focus: 'chat' });
    } else if (channel === 'room') session.store.dispatch({ type: 'view', view: { kind: 'room' } });
    return true;
  }
  if (id.startsWith('tpl:')) {
    const t = latest.templates.find((x) => x.id === id.slice(4));
    if (!t) return true;
    const channel = channelOf(latest.view);
    if (t.plan && channel !== 'draft') session.setPlanMode(channel, true);
    patchUi({ focus: 'chat', buffer: t.prompt, cursor: cursorFor(t.prompt), suggestHidden: true, selected: 0 });
    return true;
  }
  if (id.startsWith('tpl-del:')) {
    bench?.removeTemplate(id.slice('tpl-del:'.length));
    reopen();
    return true;
  }
  if (id.startsWith('wsact:') && menu.kind === 'ws_more') {
    ctx.runUiAction({ type: 'ws', id: menu.id, action: id.slice('wsact:'.length) as WorkspaceAction });
    return true;
  }
  if (id.startsWith('ho:') && menu.kind === 'handoff') {
    void session.remote.handoff(menu.id, id.slice(3));
    return true;
  }
  if (id.startsWith('rws:') && menu.kind === 'remote_ws') {
    patchUi({ focus: 'chat', buffer: '', cursor: 0, pending: { kind: 'remote', projectId: id.slice(4), peerId: menu.peerId } });
    const peer = latest.peers.find((p) => p.peerId === menu.peerId);
    session.toast(`Describe the task for ${peer?.name ?? 'their'} Claude in ${id.slice(4)}, then Enter`);
    return true;
  }
  const wsId = menu.kind === 'pr' ? menu.id : undefined;
  const projectId = menu.kind === 'scripts' ? menu.projectId : undefined;
  switch (id) {
    case 'set-model':
      patchUi({ menu: { menu: { kind: 'model' }, selected: 0 } });
      return true;
    case 'set-effort': {
      const order = [undefined, ...EFFORTS];
      session.setPrefs({ effort: order[(order.indexOf(prefs.effort) + 1) % order.length] });
      reopen();
      return true;
    }
    case 'set-pr-prompt':
    case 'pr-edit-prompt':
      bench?.editPrPrompt();
      if (id === 'set-pr-prompt') reopen();
      return true;
    case 'set-pr-reset':
      bench?.resetPrPrompt();
      reopen();
      return true;
    case 'set-templates':
      patchUi({ menu: { menu: { kind: 'templates', manage: true }, selected: 0 } });
      return true;
    case 'set-tunnel':
      session.setPrefs({ tunnel: TUNNEL_ORDER[(TUNNEL_ORDER.indexOf(prefs.tunnel) + 1) % TUNNEL_ORDER.length] ?? 'auto' });
      reopen();
      return true;
    case 'set-mouse':
      ctx.write(prefs.mouse ? MOUSE_OFF : MOUSE_ON);
      session.setPrefs({ mouse: !prefs.mouse });
      reopen();
      return true;
    case 'p-default': {
      const order = ['ask', 'auto', 'deny'] as const;
      session.setClaudeSharing(order[(order.indexOf(latest.policy) + 1) % order.length] ?? 'ask');
      reopen();
      return true;
    }
    case 'n-test':
      session.notifier.notify({ kind: 'done', title: 'Notifications work', body: 'This is how klaude tells you Claude finished or needs you' });
      session.toast('Sent a test notification', 'success');
      reopen();
      return true;
    case 'w-setup':
      session.setPrefs({ autoSetup: !prefs.autoSetup });
      reopen();
      return true;
    case 'w-friend':
      session.setFriendWorktrees(prefs.friendWorktrees === 'ask' ? 'off' : 'ask');
      reopen();
      return true;
    case 'w-shell':
      typeInto('/shell ');
      return true;
    case 'w-buttons':
      section('buttons');
      return true;
    case 'd-context':
      session.setPrefs({ contextMeter: !prefs.contextMeter });
      reopen();
      return true;
    case 'd-subagents': {
      const order = ['full', 'compact', 'hidden'] as const;
      session.setPrefs({ subagents: order[(order.indexOf(prefs.subagents) + 1) % order.length] ?? 'full' });
      reopen();
      return true;
    }
    case 'inbox-read':
      session.store.dispatch({ type: 'notice_read' });
      return true;
    case 'inbox-clear':
      session.store.dispatch({ type: 'notice_clear' });
      return true;
    case 'tpl-save':
      typeInto('/template save ');
      return true;
    case 'tpl-manage':
      patchUi({ menu: { menu: { kind: 'templates', manage: true }, selected: 0 } });
      return true;
    case 'pr-create':
      if (wsId) bench?.createPr(wsId);
      return true;
    case 'pr-create-note':
      typeInto('/pr ');
      return true;
    case 'pr-update':
      if (wsId) bench?.createPr(wsId, 'This pull request already exists: push the new commits and refresh its description.');
      return true;
    case 'pr-fix':
      if (wsId) bench?.fixChecks(wsId);
      return true;
    case 'pr-open':
      if (wsId) bench?.openPr(wsId);
      return true;
    case 'pr-refresh':
      if (wsId) void bench?.refreshPrs(wsId).then(() => session.toast('Pull request status refreshed'));
      return true;
    case 's-setup':
    case 's-run': {
      if (!projectId) return true;
      const kind = id === 's-setup' ? 'setup' : 'run';
      const current = latest.projects.find((p) => p.id === projectId)?.scripts?.[kind]?.command ?? '';
      patchUi({ focus: 'chat', buffer: current, cursor: current.length, suggestHidden: true, pending: { kind, projectId } });
      session.toast(`Type the ${kind} command (empty to clear), then Enter`);
      return true;
    }
    case 's-team':
      if (projectId) bench?.shareScripts(projectId);
      return true;
    case 'person-remote-ws':
      if (menu.kind === 'person' && latest.peers[menu.index]) patchUi({ menu: { menu: { kind: 'remote_ws', peerId: latest.peers[menu.index]!.peerId }, selected: 0 } });
      return true;
    case 'p-scripts':
      if (menu.kind === 'project') patchUi({ menu: { menu: { kind: 'scripts', projectId: menu.id }, selected: 0 } });
      return true;
    default:
      return false;
  }
}
