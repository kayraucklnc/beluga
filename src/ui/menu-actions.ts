import type { Session } from '../core/session.js';
import type { Policy } from '../core/store.js';
import { THEMES } from '../core/settings.js';
import type { UiState } from './keymap.js';
import { type MenuKind, menuSpec } from './menus.js';
import { applyTheme } from './theme.js';
import type { UiAction } from './workspace-models.js';
import { runCollabOption } from './collab-actions.js';
import { runWorkOption } from './work-actions.js';

export const POLICY_BY_OPTION: Record<string, Policy> = { 'share-ask': 'ask', 'share-auto': 'auto', 'share-deny': 'deny' };
export const POLICY_INDEX: Record<Policy, number> = { ask: 0, auto: 1, deny: 2 };

/** What a menu needs from the app to act. */
export interface MenuContext {
  readonly session: Session;
  readonly patchUi: (patch: Partial<UiState>) => void;
  readonly typeInto: (buffer: string) => void;
  readonly askForName: (kind: 'worktree' | 'chat' | 'group', projectId: string) => void;
  readonly openFolder: (dir: string) => void;
  readonly runUiAction: (action: UiAction) => void;
  readonly write: (data: string) => void;
}

/** Run the option picked in a menu (by click, Enter or its number). */
export function runMenu(ctx: MenuContext, menu: MenuKind, index: number): void {
  const { session, patchUi, typeInto, askForName, openFolder, runUiAction } = ctx;
  const ctl = session.workspaces;
  const latest = session.store.getState();
  const option = menuSpec(latest, menu)?.options[index];
  if (!option) return;
  if (runCollabOption(ctx, menu, option.id)) return;
  if (runWorkOption(ctx, menu, option.id, index)) return;
  const peer = menu.kind === 'person' ? latest.peers[menu.index] : undefined;
  const policy = POLICY_BY_OPTION[option.id];
  if (policy) {
    session.setClaudeSharing(policy);
    const msg = { ask: "You'll approve each request for your Claude", auto: 'Everyone in the room can use your Claude', deny: 'Your Claude is private' };
    session.toast(msg[policy], 'success');
    return;
  }
  const reopen = (): void => patchUi({ menu: { menu, selected: index } });
  const confirmId = menu.kind === 'confirm' ? menu.id : undefined;
  const project = menu.kind === 'project' ? latest.projects.find((p) => p.id === menu.id) : undefined;
  const archived = menu.kind === 'archived' ? ctl?.manager.find(menu.id) : undefined;
  if (option.id.startsWith('p-group:') && project) {
    void ctl?.setGroup(project.id, option.id.slice('p-group:'.length));
    return;
  }
  switch (option.id) {
    case 'p-worktree':
      if (project) runUiAction({ type: 'new_worktree', projectId: project.id });
      return;
    case 'p-chat':
      if (project) runUiAction({ type: 'new_chat', projectId: project.id });
      return;
    case 'p-main': {
      const main = project?.workspaces.find((w) => w.kind === 'main');
      if (main) ctl?.open(main.id);
      return;
    }
    case 'p-finder':
      if (project) openFolder(project.root);
      return;
    case 'p-newgroup':
      if (project) askForName('group', project.id);
      return;
    case 'p-ungroup':
      if (project) void ctl?.setGroup(project.id, undefined);
      return;
    case 'p-hide':
      if (project) void ctl?.hideProject(project.id);
      return;
    case 'p-agents':
      if (project) patchUi({ menu: { menu: { kind: 'agents', projectId: project.id }, selected: 0 } });
      return;
    case 'agents-clean':
      if (menu.kind === 'agents') void ctl?.cleanAgentWorktrees(menu.projectId);
      return;
    case 'a-restore':
      if (archived) void ctl?.restore(archived.id);
      return;
    case 'a-open':
      if (archived) ctl?.open(archived.id);
      return;
    case 'a-finder':
      if (archived) openFolder(archived.projectRoot || archived.path);
      return;
    case 'a-delete':
      if (archived) patchUi({ menu: { menu: { kind: 'confirm', action: 'delete', id: archived.id }, selected: 0 } });
      return;
    case 'confirm-archive':
    case 'confirm-archive-force':
      if (confirmId) void ctl?.archive(confirmId, option.id === 'confirm-archive-force');
      return;
    case 'confirm-commit-archive':
      if (confirmId) void ctl?.commit(confirmId).then(() => ctl.archive(confirmId));
      return;
    case 'confirm-delete':
      if (confirmId) void ctl?.remove(confirmId);
      return;
    case 'confirm-archive-env':
    case 'confirm-delete-env':
      if (confirmId && ctl) {
        ctl.applyEnvBack(confirmId);
        void (option.id === 'confirm-archive-env' ? ctl.archive(confirmId, true) : ctl.remove(confirmId));
      }
      return;
    case 'set-name':
      typeInto('/name ');
      return;
    case 'set-theme': {
      const next = THEMES[(THEMES.indexOf(latest.prefs.theme) + 1) % THEMES.length] ?? 'calm';
      applyTheme(next);
      session.setPrefs({ theme: next });
      reopen();
      return;
    }
    case 'size-in':
    case 'size-out':
    case 'size-reset':
      void session.zoom(option.id === 'size-in' ? 'in' : option.id === 'size-out' ? 'out' : 'reset');
      reopen();
      return;
    case 'settings':
      patchUi({ menu: { menu: { kind: 'settings' }, selected: 0 } });
      return;
    case 'close':
      return;
    case 'ask':
      typeInto(`@claude:${peer?.name ?? ''} `);
      return;
    case 'ask-self':
      typeInto('@claude ');
      return;
    case 'follow':
    case 'unfollow':
      session.follow(option.id === 'follow' ? peer?.name : undefined);
      return;
    case 'browse': {
      const share = peer?.shares[0];
      if (peer && share) void session.browseTo({ owner: peer.peerId, share: share.name, path: '' });
      session.store.dispatch({ type: 'view', view: { kind: 'files' } });
      patchUi({ focus: 'files' });
      return;
    }
    case 'set-self-approval':
      session.setPrefs({ selfApproval: latest.prefs.selfApproval === 'ask' ? 'never' : 'ask' });
      reopen();
      return;
    case 'invite':
      void session.copyInvite();
      return;
    case 'sharing':
      patchUi({ menu: { menu: { kind: 'settings', section: 'people' }, selected: 0 } });
      return;
  }}
