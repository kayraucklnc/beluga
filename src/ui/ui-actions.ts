import type { MutableRefObject } from 'react';
import type { Session } from '../core/session.js';
import { globalShellId, globalShellNumber, runId, setupId } from '../core/workbench.js';
import { runCollabUiAction } from './collab-actions.js';
import type { UiState } from './keymap.js';
import type { MenuContext } from './menu-actions.js';
import type { MenuKind } from './menus.js';
import { type UiAction, toggleProject } from './workspace-models.js';

/** What clicking things (and pressing Enter on them) needs from the app. */
export interface UiActionContext {
  readonly session: Session;
  readonly patchUi: (patch: Partial<UiState>) => void;
  readonly uiRef: MutableRefObject<UiState>;
  readonly toggle: (key: string) => void;
  readonly typeInto: (buffer: string) => void;
  readonly menuCtx: () => MenuContext;
  readonly runMenu: (menu: MenuKind, index: number) => void;
}

/** Do what a clicked button, row or card means. */
export function runUiActionWith(c: UiActionContext, action: UiAction): void {
  const { session, patchUi, uiRef, toggle, typeInto, runMenu } = c;
  const ctl = session.workspaces;
  const bench = session.workbench;
  if (runCollabUiAction(c.menuCtx(), action)) return;
  switch (action.type) {
    case 'open_ws':
      ctl?.open(action.id, action.tab);
      // Opening a view puts you inside it: the file list, the diff, the terminal, or the chat.
      patchUi(action.tab === 'review' ? { focus: 'main', entered: true } : action.tab === 'files' ? { focus: 'files', entered: true } : action.tab === 'terminal' ? { focus: 'terminal', terminalScroll: 0 } : { focus: 'chat', entered: false });
      return;
    case 'inbox':
      patchUi({ menu: { menu: { kind: 'inbox' }, selected: 0 } });
      return;
    case 'model_menu':
      patchUi({ menu: { menu: { kind: 'model', ...(action.channel === 'room' ? {} : { channel: action.channel }) }, selected: 0 } });
      return;
    case 'templates_menu':
      patchUi({ menu: { menu: { kind: 'templates', manage: true }, selected: 0 } });
      return;
    case 'template': {
      const t = session.store.getState().templates.find((x) => x.id === action.id);
      if (t) runMenu({ kind: 'templates' }, session.store.getState().templates.indexOf(t));
      return;
    }
    case 'trust':
      session.people.setTrust(action.peerId, action.level);
      return;
    case 'trust_later':
      session.people.dismissPrompt(action.peerId);
      return;
    case 'search_hit':
      session.store.dispatch({ type: 'search', search: { cursor: action.index } });
      bench?.openHit(action.index);
      patchUi({ focus: 'chat', buffer: '', cursor: 0 });
      return;
    case 'ws_more':
      patchUi({ menu: { menu: { kind: 'ws_more', id: action.id, actions: action.actions }, selected: 0 } });
      return;
    case 'term_tab':
      patchUi({ termKey: action.key, terminalScroll: 0, focus: 'terminal' });
      return;
    case 'term_new': {
      // The Terminal tab starts it (in the current project's folder) once it's selected.
      const next = Math.max(0, ...(bench?.globalShells() ?? []).map(globalShellNumber)) + 1;
      patchUi({ termKey: globalShellId(next), terminalScroll: 0, focus: 'terminal' });
      return;
    }
    case 'toggle_project': {
      const latest = session.store.getState();
      const project = latest.projects.find((p) => p.id === action.id);
      if (project) patchUi({ collapsed: toggleProject(latest, project, uiRef.current.collapsed) });
      return;
    }
    case 'toggle_group':
      toggle(`group:${action.name}`);
      return;
    case 'toggle_archive':
      toggle(`archive:${action.projectId}`);
      return;
    case 'toggle_fold':
      toggle(action.key);
      return;
    case 'agents_menu':
      patchUi({ menu: { menu: { kind: 'agents', projectId: action.projectId }, selected: 0 } });
      return;
    case 'project_menu':
      patchUi({ menu: { menu: { kind: 'project', id: action.id }, selected: 0 } });
      return;
    case 'archived_menu':
      patchUi({ menu: { menu: { kind: 'archived', id: action.id }, selected: 0 } });
      return;
    case 'none':
      return;
    case 'new_worktree': {
      // Like a new chat: describe the task, and a small model names the worktree from it.
      const latest = session.store.getState();
      const back = latest.view.kind === 'draft' || latest.view.kind === 'draft_worktree' ? latest.view.back : latest.view;
      session.store.dispatch({ type: 'view', view: { kind: 'draft_worktree', projectId: action.projectId, back } });
      patchUi({ focus: 'chat', buffer: '', cursor: 0 });
      return;
    }
    case 'new_chat': {
      // An empty chat opens right away; it's only created when you send the first message.
      const latest = session.store.getState();
      const back = latest.view.kind === 'draft' ? latest.view.back : latest.view;
      const dir = action.projectId === 'chats' ? session.launchDir : undefined;
      session.store.dispatch({ type: 'view', view: { kind: 'draft', projectId: action.projectId, dir, back } });
      patchUi({ focus: 'chat', buffer: '', cursor: 0 });
      return;
    }
    case 'add_project':
      typeInto('/project add ~/');
      return;
    case 'view':
      session.store.dispatch({ type: 'view', view: action.view });
      if (action.view.kind === 'files') {
        session.store.dispatch({ type: 'browser_cursor', delta: -10_000 });
        patchUi({ focus: 'files', entered: true });
      } else if (action.view.kind === 'terminal') patchUi({ focus: 'terminal', terminalScroll: 0 });
      else patchUi({ focus: action.view.kind === 'overview' ? 'main' : 'chat', entered: action.view.kind === 'overview' });
      return;
    case 'close_tab':
      session.store.dispatch({ type: 'close_tab', id: action.id });
      return;
    case 'review_file':
      void ctl?.selectFile(action.index);
      patchUi({ focus: 'main' });
      return;
    case 'ws': {
      const ws = ctl?.manager.find(action.id);
      if (!ctl || !ws) return;
      switch (action.action) {
        case 'merge':
          void ctl.merge(ws.id);
          return;
        case 'commit':
          void ctl.commit(ws.id);
          return;
        case 'fork':
          ctl.open(ws.id);
          typeInto(`/fork ${ws.name}-2`);
          return;
        case 'finder':
          ctl.openInFinder(ws.id);
          return;
        case 'archive':
        case 'delete':
          ctl.prepareRemoval(ws.id);
          patchUi({ menu: { menu: { kind: 'confirm', action: action.action, id: ws.id }, selected: 0 } });
          return;
        case 'restore':
          void ctl.restore(ws.id);
          return;
        case 'review_claude':
          ctl.askClaudeToReview(ws.id);
          return;
        case 'merge_claude':
          ctl.askClaudeToMerge(ws.id);
          return;
        case 'compact':
          ctl.compact(ws.id);
          return;
        case 'pr':
          patchUi({ menu: { menu: { kind: 'pr', id: ws.id }, selected: 0 } });
          void bench?.refreshPrs(ws.id);
          return;
        case 'run':
          bench?.run(ws.id);
          ctl.open(ws.id, 'terminal');
          patchUi({ termKey: runId(ws.id), terminalScroll: 0, focus: 'terminal' });
          return;
        case 'stop_run':
          bench?.stopRun(ws.id);
          return;
        case 'setup':
          bench?.runSetup(ws.id);
          ctl.open(ws.id, 'terminal');
          patchUi({ termKey: setupId(ws.id), terminalScroll: 0 });
          return;
        case 'handoff':
          patchUi({ menu: { menu: { kind: 'handoff', id: ws.id }, selected: 0 } });
          return;
      }
    }
  }
  
}
