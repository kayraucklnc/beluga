import type { SettingsSection } from '@beluga/ui/settings-menus.js';
import { useDictationSetup } from './lib/dictation.js';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect } from 'react';
import { channelOf } from '@beluga/core/store.js';
import { placeForKey, stepPlace } from './lib/go.js';
import { useRememberProject } from './tasks/use-tasks.js';
import { inviteChoice } from '@beluga/ui/invite-menus.js';
import { projectInView } from '@beluga/ui/invite-actions.js';
import { Icon } from './components/Icon.js';
import { MenuSheet } from './dialogs/MenuSheet.js';
import { Palette } from './dialogs/Palette.js';
import { Settings } from './dialogs/Settings.js';
import { PlanSheet } from './dialogs/PlanSheet.js';
import type { SettingsPane } from './lib/beluga.js';
import { RightPanel } from './layout/RightPanel.js';
import { Main } from './layout/Main.js';
import { Sidebar } from './layout/Sidebar.js';
import { useActions } from './lib/actions.js';
import { commandForKey, runCommand } from './lib/commands.js';
import { useApp, useBeluga } from './lib/beluga.js';
import { setPrefs, usePrefs, zoom } from './lib/prefs.js';
import { byKey, showPanelTab, togglePanel, toggleTerminal } from './lib/panel.js';
import { PANEL_LABELS, PANEL_TABS } from './lib/panel-model.js';
import { joinRoom, useMenuState, useNative, useNotificationTaps, useTrayStatus, useTraySpout, useWindowFocus } from './lib/native.js';
import { AddProjectSheet } from './dialogs/AddProjectSheet.js';
import { UndoToast } from './lib/undo-toast.js';
import { brandText } from './lib/brand.js';
import { NativeSheets } from './dialogs/native/WorkSheets.js';
import { JoinSheet } from './dialogs/JoinSheet.js';
import { NetworkSheets } from './network/NetworkSheets.js';
import { openNet } from './network/net-sheets.js';
import { MessageBanner } from './network/MessageBanner.js';
import { RequestSheet } from './gateway/RequestSheet.js';
import { useRequestNative } from './gateway/request-native.js';
import { StripeSheet } from './dialogs/StripeSheet.js';
import { SupportSheets } from './dialogs/SupportSheets.js';
import { useIdleAway, useTrayPresence } from './network/net-native.js';
import { useUpdateActivity } from './lib/updates.js';
import { useState } from 'react';
import { Onboarding, useOnboarding } from './onboarding/Onboarding.js';
import { Lightbox } from './chat/ChatImages.js';
import { newChatProject } from './lib/project-home.js';
import s from './layout/Shell.module.css';

const TOAST_MS = 3500;

function Toasts() {
  const { client } = useBeluga();
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
          {brandText(toast.text)}
        </span>
      </div>
    </div>
  );
}

/** What the core asks to open (from a /command, or the first invite) shows as this window's own dialog. */
function useOverlays() {
  const { client, ui } = useBeluga();
  const overlay = useApp((st) => st.overlay);
  useEffect(() => {
    if (!overlay) return;
    // Read here, not watched: watching the whole state redrew the whole window on every streamed event (KLD-48).
    const state = client.store.getState();
    client.store.dispatch({ type: 'overlay', overlay: undefined });
    const channel = channelOf(state.view);
    const wsId = state.view.kind === 'workspace' ? state.view.id : undefined;
    switch (overlay) {
      case 'clear':
        return ui.openMenu({ kind: 'clear', channel, host: state.isHost });
      case 'model':
        return ui.openMenu({ kind: 'model', ...(channel === 'room' || channel === 'draft' ? {} : { channel }) });
      case 'inbox':
        return ui.patch({ notices: true });
      case 'templates':
        return ui.openMenu({ kind: 'templates' });
      case 'handoff':
        if (wsId) ui.openMenu({ kind: 'handoff', id: wsId });
        return;
      case 'welcome':
        return ui.openMenu({ kind: 'welcome' });
      case 'settings':
        return ui.patch({ settings: 'general' });
      case 'help':
        return ui.patch({ palette: true });
      case 'add_friend':
        return openNet({ kind: 'add_friend' });
    }
  }, [overlay]);
}

/** Keys that work everywhere in the window (menus show the same ones). */
function useShortcuts() {
  const { client, ui } = useBeluga();
  const actions = useActions();
  const prefs = usePrefs();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const cmd = e.metaKey || e.ctrlKey;
      const state = client.store.getState();
      // The Workspace and Conversation menus' keys (Stop ⌘., Commit ⇧⌘C, Find ⌘F…).
      const command = e.defaultPrevented ? undefined : commandForKey(e);
      if (command) {
        e.preventDefault();
        runCommand({ client, ui, actions }, command);
        return;
      }
      if (cmd && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.patch({ palette: !ui.get().palette });
      } else if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
        // ⌘ only: ⌃J is a newline in a shell.
        e.preventDefault();
        byKey('terminal', () => {
          const why = toggleTerminal(state);
          if (why) client.store.dispatch({ type: 'toast', text: why, level: 'info' });
        });
      } else if (e.altKey && e.metaKey && !e.shiftKey && e.code === 'Digit0') {
        // ⌥⌘0 shows and hides the right panel, as in Xcode (⌥⌘I still does too).
        e.preventDefault();
        byKey('panel', () => togglePanel(state.view));
      } else if (e.altKey && e.metaKey && !e.shiftKey && /^Digit[1-8]$/.test(e.code)) {
        // ⌥⌘1…8: the panel's Changes, Files, Terminal, Info, History, Scratch, Background and Phone.
        e.preventDefault();
        const tab = PANEL_TABS[Number(e.code.slice(5)) - 1]!;
        byKey(`panel-${tab}`, () => {
          if (!showPanelTab(state, tab)) client.store.dispatch({ type: 'toast', text: `No ${PANEL_LABELS[tab]} here`, level: 'info' });
        });
      } else if (cmd && e.key === ',') {
        e.preventDefault();
        ui.patch({ settings: 'general' });
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
        byKey('panel', () => togglePanel(state.view));
      } else if (e.ctrlKey && e.metaKey && e.code === 'KeyS') {
        e.preventDefault();
        setPrefs({ sidebar: !prefs.sidebar });
      } else if (e.altKey && !cmd && /^Digit[1-7]$/.test(e.code)) {
        const tab = placeForKey(state, Number(e.code.slice(5)));
        if (tab) {
          e.preventDefault();
          actions.run({ type: 'view', view: { kind: tab.kind } });
        }
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        actions.run({ type: 'view', view: { kind: stepPlace(state, e.shiftKey ? -1 : 1) } });
      } else if (cmd && e.key === 'n' && !e.shiftKey) {
        e.preventDefault();
        // In a project: a new chat on its main folder (a new one every time); elsewhere a chat of its own.
        actions.run({ type: 'new_chat', projectId: newChatProject(state) });
      } else if (cmd && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        actions.run({ type: 'view', view: { kind: 'search' } });
      } else if (state.approvals[0] && e.ctrlKey && !e.metaKey && ['y', 'n', 'a'].includes(e.key) && !typingIn(e.target)) {
        e.preventDefault();
        // A .env file's "always" stays in its project when it has one.
        const always = state.approvals[0].kind === 'secret' && state.approvals[0].project ? 'project' : 'always';
        void client.api.host.answerApproval(e.key === 'y' ? 'yes' : e.key === 'n' ? 'no' : always, state.approvals[0].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefs.inspector, prefs.sidebar]);
  useEffect(() => {
    // Invite means add a friend (BLG-203): the Add a Friend sheet (link, code, QR).
    const invite = (): void => openNet({ kind: 'add_friend' });
    document.addEventListener('beluga:invite', invite);
    // The room's own Invite sheet (its links, set to the project you're looking at), from the room's menus.
    const inviteRoom = (): void => ui.openMenu({ kind: 'invite_link', ...inviteChoice(projectInView(client)) });
    document.addEventListener('beluga:invite-room', inviteRoom);
    const palette = (): void => ui.patch({ palette: true });
    document.addEventListener('beluga:palette', palette);
    return () => {
      document.removeEventListener('beluga:invite', invite);
      document.removeEventListener('beluga:invite-room', inviteRoom);
      document.removeEventListener('beluga:palette', palette);
    };
  }, []);
}

const PANE_OF: Record<SettingsSection, SettingsPane> = { claude: 'claude', notify: 'notifications', workspaces: 'workspaces', buttons: 'workspaces', people: 'people', display: 'appearance', terminal: 'terminal', env: 'environment' };

/** The shared code opens the settings menu (from a person's menu, onboarding…): here it's the Settings window. */
function useSettingsWindow() {
  const { ui } = useBeluga();
  useEffect(
    () =>
      ui.subscribe(() => {
        const m = ui.get().menu?.menu;
        if (m?.kind === 'settings') ui.patch({ menu: undefined, settings: m.section ? PANE_OF[m.section] : 'general' });
      }),
    [],
  );
}


/**
 * Typing where ^A, ^N and ^Y mean line editing (a terminal, a field, a box with text in it), so
 * they don't answer an approval. An empty message box still lets them through.
 */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement && !target.closest('.xterm')) return target.value !== '';
  return target.isContentEditable || target.closest('input, select, .xterm') !== null;
}

export function App() {
  const prefs = usePrefs();
  const { client, ui } = useBeluga();
  const actions = useActions();
  const [joining, setJoining] = useState<string>();
  const welcome = useOnboarding();
  useOverlays();
  useShortcuts();
  // Speaking instead of typing: the talk shortcut, ↩ and esc while listening (Settings › Voice).
  useDictationSetup(client);
  useRememberProject();
  useSettingsWindow();
  useNative(client, ui, actions, setJoining);
  useTrayStatus(client);
  useTraySpout();
  useMenuState(client);
  useWindowFocus(client);
  useNotificationTaps(client, ui, actions);
  useTrayPresence(client);
  useIdleAway(client);
  useRequestNative(client);
  useUpdateActivity(client, actions);
  return (
    <Tooltip.Provider delayDuration={450} skipDelayDuration={200}>
      {/* Behind the welcome the app can't be tabbed to or read out. */}
      <div className={s.app} inert={welcome.open} data-app-root>
        {prefs.sidebar ? <Sidebar /> : null}
        <Main />
        <RightPanel />
      </div>
      <MenuSheet />
      <AddProjectSheet />
      <NativeSheets />
      <Palette />
      <Settings />
      <PlanSheet />
      <NetworkSheets />
      <RequestSheet />
      <StripeSheet />
      {welcome.open ? null : <SupportSheets />}
      {joining ? <JoinSheet invite={joining} onCancel={() => setJoining(undefined)} onJoin={() => void joinRoom(joining)} /> : null}
      {/* One per window, over whatever opened it (a chat, a sub-agent's activity, a graph). */}
      <Lightbox />
      <Toasts />
      <MessageBanner />
      <UndoToast />
      {welcome.open ? <Onboarding start={welcome.start} onClose={welcome.close} onArrive={welcome.arrive} /> : null}
    </Tooltip.Provider>
  );
}
