import { useRef } from 'react';
import { runId, setupId, shellId, terminalLabel } from '@klaud/shared/terminal-keys.js';
import { Dot, IconButton, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useKlaud, useUi } from '../lib/klaud.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { useGlobalShells } from '../lib/shells.js';
import { mod } from '../lib/system.js';
import { NoShells, ShellTabs } from './TerminalView.js';
import { TerminalTab } from './TerminalTab.js';
import { Xterm } from './Xterm.js';
import s from './dock.module.css';

/** A workspace's own terminals: its shell, and its setup and run while they exist. */
function useWorkspaceTerminal(wsId: string): { key: string; tabs: Array<{ key: string; label: string }>; start: (size: { cols: number; rows: number }) => void } {
  const api = useApi();
  const terminals = useApp((st) => st.terminals);
  const names = useApp((st) => st.termNames);
  const picked = useUi((u) => u.termKey);
  const keys = [shellId(wsId), setupId(wsId), runId(wsId)];
  const key = picked && keys.includes(picked) && picked in terminals ? picked : shellId(wsId);
  const tabs = keys.filter((k) => k in terminals || k === shellId(wsId)).map((k) => ({ key: k, label: terminalLabel(k, names) }));
  return { key, tabs, start: (size) => (key === shellId(wsId) ? void api.terminals.shell(wsId, size) : undefined) };
}

/** A terminal docked next to (or under) the chat, so you can watch it and type in it while you talk to Claude. */
export function DockedTerminal() {
  const api = useApi();
  const actions = useActions();
  const prefs = usePrefs();
  const { ui } = useKlaud();
  const view = useApp((st) => st.view);
  const terminals = useApp((st) => st.terminals);
  const termExits = useApp((st) => st.termExits);
  const shells = useGlobalShells();
  const ws = useWorkspaceTerminal(view.kind === 'workspace' ? view.id : '');
  const inWorkspace = view.kind === 'workspace';
  const key = inWorkspace ? ws.key : shells.key;
  const start = inWorkspace ? ws.start : (size: { cols: number; rows: number }) => key && void api.terminals.global(key, shells.dir, size);
  const running = (k: string): boolean => k in terminals && !(k in termExits);
  return (
    <section className={s.dock} aria-label="Terminal">
      <div className={s.bar}>
        {inWorkspace ? (
          ws.tabs.map((t) => (
            <TerminalTab key={t.key} termKey={t.key} label={t.label} on={t.key === key} className={s.tab} onClassName={s.tabOn} renamable={t.key === shellId(view.id)} onPick={() => ui.patch({ termKey: t.key })} before={<Dot tone={running(t.key) ? 'ok' : 'muted'} />} />
          ))
        ) : (
          <ShellTabs shells={shells} />
        )}
        <span className={s.flex} />
        <IconButton icon={prefs.dock === 'right' ? 'chevronDown' : 'chevronRight'} label={prefs.dock === 'right' ? 'Move it under the chat' : 'Move it beside the chat'} onClick={() => setPrefs({ dock: prefs.dock === 'right' ? 'bottom' : 'right' })} />
        <IconButton
          icon="terminal"
          label="Open in the Terminal tab"
          onClick={() => {
            setPrefs({ dock: 'off' });
            actions.run(view.kind === 'workspace' ? { type: 'open_ws', id: view.id, tab: 'terminal' } : { type: 'view', view: { kind: 'terminal' } });
          }}
        />
        <IconButton icon="x" label="Hide the terminal" keys={`${mod()}J`} onClick={() => setPrefs({ dock: 'off' })} />
      </div>
      {key ? <Xterm key={`${key}:${key in termExits ? 'x' : 'live'}`} termKey={key} start={start} focus={false} /> : <NoShells open={shells.open} />}
    </section>
  );
}

/** The handle between the chat and the docked terminal: drag to resize, double-click to reset. */
export function DockDivider({ container }: { container: React.RefObject<HTMLDivElement | null> }) {
  const prefs = usePrefs();
  const dragging = useRef(false);
  const horizontal = prefs.dock === 'right';
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      className={cx(s.divider, horizontal ? s.dividerV : s.dividerH)}
      onDoubleClick={() => setPrefs({ dockSize: 0.42 })}
      onPointerDown={(e) => {
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const box = container.current?.getBoundingClientRect();
        if (!dragging.current || !box) return;
        const size = horizontal ? (box.right - e.clientX) / box.width : (box.bottom - e.clientY) / box.height;
        setPrefs({ dockSize: Math.min(0.75, Math.max(0.2, size)) });
      }}
      onPointerUp={() => (dragging.current = false)}
    />
  );
}

