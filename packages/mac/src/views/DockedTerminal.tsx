import { useRef } from 'react';
import { globalShellDir, globalShellId, globalShellNumber, isGlobalShell, runId, setupId, shellId } from '@klaud/shared/terminal-keys.js';
import { Dot, IconButton, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useKlaud, useUi } from '../lib/klaud.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { mod } from '../lib/system.js';
import { Xterm } from './Xterm.js';
import s from './dock.module.css';

/** The terminal this conversation goes with: the workspace's own shell (or its setup/run), else one of your shells. */
function useDockTerminal(): { key: string; tabs: Array<{ key: string; label: string }>; start: (size: { cols: number; rows: number }) => void } {
  const api = useApi();
  const state = useApp((st) => st);
  const picked = useUi((u) => u.termKey);
  const view = state.view;
  if (view.kind === 'workspace') {
    const keys = [shellId(view.id), setupId(view.id), runId(view.id)];
    const key = picked && keys.includes(picked) && picked in state.terminals ? picked : shellId(view.id);
    const tabs = keys.filter((k) => k in state.terminals || k === shellId(view.id)).map((k) => ({ key: k, label: k === shellId(view.id) ? 'Shell' : k.endsWith(':setup') ? 'Setup' : 'Run' }));
    return { key, tabs, start: (size) => (key === shellId(view.id) ? void api.terminals.shell(view.id, size) : undefined) };
  }
  const globals = Object.keys(state.terminals).filter(isGlobalShell).sort((a, b) => globalShellNumber(a) - globalShellNumber(b));
  const key = picked && isGlobalShell(picked) ? picked : (globals[0] ?? globalShellId(1));
  const dir = globalShellDir(state.projects, state.tabs, state.home, state.home);
  const tabs = [...new Set([...globals, key])].map((k, i) => ({ key: k, label: `Shell ${i + 1}` }));
  return { key, tabs, start: (size) => void api.terminals.global(key, dir, size) };
}

/** A terminal docked next to (or under) the chat, so you can watch it and type in it while you talk to Claude. */
export function DockedTerminal() {
  const { ui } = useKlaud();
  const actions = useActions();
  const prefs = usePrefs();
  const state = useApp((st) => st);
  const { key, tabs, start } = useDockTerminal();
  const running = (k: string): boolean => k in state.terminals && !(k in state.termExits);
  const view = state.view;
  return (
    <section className={s.dock} aria-label="Terminal">
      <div className={s.bar}>
        {tabs.map((t) => (
          <button key={t.key} type="button" className={cx(s.tab, t.key === key && s.tabOn)} onClick={() => ui.patch({ termKey: t.key })}>
            <Dot tone={running(t.key) ? 'ok' : 'muted'} />
            {t.label}
          </button>
        ))}
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
      <Xterm key={`${key}:${key in state.termExits ? 'x' : 'live'}`} termKey={key} start={start} focus={false} />
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

