import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect } from 'react';
import { channelOf } from '@klaud/core/store.js';
import { stepTab, topTabs } from '@klaud/ui/workspace-models.js';
import { Icon } from './components/Icon.js';
import { MenuSheet } from './dialogs/MenuSheet.js';
import { Inspector } from './layout/Inspector.js';
import { Main } from './layout/Main.js';
import { Sidebar } from './layout/Sidebar.js';
import { useActions } from './lib/actions.js';
import { useApp, useKlaud } from './lib/klaud.js';
import { setPrefs, usePrefs, zoom } from './lib/prefs.js';
import s from './layout/Shell.module.css';

const TOAST_MS = 3500;

function Toasts() {
  const { client } = useKlaud();
  const toast = useApp((st) => st.toast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => client.store.dispatch({ type: 'toast_clear', id: toast.id }), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast, client]);
  if (!toast) return null;
  const icon = toast.level === 'success' ? 'check' : toast.level === 'warn' || toast.level === 'error' ? 'alert' : 'spark';
  return (
    <div className={s.toasts} role="status" aria-live="polite">
      <div key={toast.id} className={s.toast} style={{ color: toast.level === 'error' ? 'var(--error)' : toast.level === 'warn' ? 'var(--warn)' : undefined }}>
        <Icon name={icon} size={13} />
        <span className={s.toastText} style={{ color: 'var(--text)' }}>
          {toast.text}
        </span>
      </div>
    </div>
  );
}

/** What the core asks to open (from a /command, or the first invite) shows as this window's own dialog. */
function useOverlays() {
  const { client, ui } = useKlaud();
  const overlay = useApp((st) => st.overlay);
  const state = useApp((st) => st);
  useEffect(() => {
    if (!overlay) return;
    client.store.dispatch({ type: 'overlay', overlay: undefined });
    const channel = channelOf(state.view);
    const wsId = state.view.kind === 'workspace' ? state.view.id : undefined;
    switch (overlay) {
      case 'clear':
        return ui.openMenu({ kind: 'clear', channel, host: state.isHost });
      case 'model':
        return ui.openMenu({ kind: 'model', ...(channel === 'room' || channel === 'draft' ? {} : { channel }) });
      case 'inbox':
        return ui.openMenu({ kind: 'inbox' });
      case 'templates':
        return ui.openMenu({ kind: 'templates' });
      case 'handoff':
        if (wsId) ui.openMenu({ kind: 'handoff', id: wsId });
        return;
      case 'welcome':
        return ui.openMenu({ kind: 'welcome' });
      case 'settings':
        return ui.openMenu({ kind: 'settings' });
      case 'help':
        return ui.patch({ palette: true });
    }
  }, [overlay]);
}

/** Keys that work everywhere in the window (menus show the same ones). */
function useShortcuts() {
  const { client, ui } = useKlaud();
  const actions = useActions();
  const prefs = usePrefs();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const cmd = e.metaKey || e.ctrlKey;
      const state = client.store.getState();
      if (cmd && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.patch({ palette: !ui.get().palette });
      } else if (cmd && e.key === ',') {
        e.preventDefault();
        ui.openMenu({ kind: 'settings' });
      } else if (cmd && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoom('in');
      } else if (cmd && e.key === '-') {
        e.preventDefault();
        zoom('out');
      } else if (cmd && e.key === '0') {
        e.preventDefault();
        zoom('reset');
      } else if (e.altKey && cmd && e.code === 'KeyI') {
        e.preventDefault();
        setPrefs({ inspector: !prefs.inspector });
      } else if (e.ctrlKey && e.metaKey && e.code === 'KeyS') {
        e.preventDefault();
        setPrefs({ sidebar: !prefs.sidebar });
      } else if (e.altKey && !cmd && /^Digit[1-6]$/.test(e.code)) {
        const tab = topTabs(state)[Number(e.code.slice(5)) - 1];
        if (tab) {
          e.preventDefault();
          actions.run({ type: 'view', view: { kind: tab.kind } });
        }
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        actions.run({ type: 'view', view: { kind: stepTab(state, e.shiftKey ? -1 : 1) } });
      } else if (cmd && e.key === 'n' && !e.shiftKey) {
        e.preventDefault();
        actions.run({ type: 'new_chat', projectId: 'chats' });
      } else if (cmd && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        actions.run({ type: 'view', view: { kind: 'search' } });
      } else if (state.approvals[0] && e.ctrlKey && !e.metaKey && ['y', 'n', 'a'].includes(e.key)) {
        e.preventDefault();
        void client.api.host.answerApproval(e.key === 'y' ? 'yes' : e.key === 'n' ? 'no' : 'always', state.approvals[0].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefs.inspector, prefs.sidebar]);
  useEffect(() => {
    const invite = (): void => {
      const state = client.store.getState();
      if (state.self?.host) ui.openMenu({ kind: 'invite_link', scope: 'room', can: 'prompt', knock: true, singleUse: true, expires: true });
      else void client.api.session.copyInvite();
    };
    document.addEventListener('klaud:invite', invite);
    const palette = (): void => ui.patch({ palette: true });
    document.addEventListener('klaud:palette', palette);
    return () => {
      document.removeEventListener('klaud:invite', invite);
      document.removeEventListener('klaud:palette', palette);
    };
  }, []);
}

export function App() {
  const prefs = usePrefs();
  useOverlays();
  useShortcuts();
  return (
    <Tooltip.Provider delayDuration={450} skipDelayDuration={200}>
      <div className={s.app}>
        {prefs.sidebar ? <Sidebar /> : null}
        <Main />
        {prefs.inspector ? <Inspector /> : null}
      </div>
      <MenuSheet />
      <Toasts />
    </Tooltip.Provider>
  );
}
