import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { globalShellDir, globalShellId, globalShellNumber, isGlobalShell, runId, setupId, shellId } from '@klaud/shared/terminal-keys.js';
import { findWorkspace } from '@klaud/ui/workspace-models.js';
import { Icon } from '../components/Icon.js';
import { Button, Dot, IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useKlaud, useUi } from '../lib/klaud.js';
import { openExternal } from '../lib/system.js';
import s from './terminal.module.css';

const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** One terminal program, drawn by xterm.js from its raw bytes (the program runs in klaud). */
function Xterm({ termKey, start }: { termKey: string; start: (size: { cols: number; rows: number }) => void }) {
  const { client } = useKlaud();
  const known = useApp((st) => termKey in st.terminals);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.18,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: { background: css('--term-bg') || css('--bg'), foreground: css('--text'), cursor: css('--accent') === 'AccentColor' ? css('--text') : css('--accent'), selectionBackground: 'rgba(120,140,190,0.35)' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new SearchAddon());
    term.loadAddon(new WebLinksAddon((_e, uri) => void openExternal(uri)));
    term.open(el);
    fit.fit();
    if (!known) start({ cols: term.cols, rows: term.rows });
    const link = client.attachTerminal(termKey);
    const offData = link.onData((d) => term.write(d));
    const offExit = link.onExit((e) => term.write(`\r\n\x1b[2m[exited${e.code !== null ? ` with ${e.code}` : ''}]\x1b[0m\r\n`));
    const input = term.onData((d) => link.write(d));
    link.resize(term.cols, term.rows);
    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
        link.resize(term.cols, term.rows);
      } catch {
        // detached
      }
    });
    resize.observe(el);
    term.focus();
    return () => {
      resize.disconnect();
      input.dispose();
      offData();
      offExit();
      link.close?.();
      term.dispose();
    };
  }, [termKey, known]);
  return <div ref={box} className={s.xterm} />;
}

/** A workspace's Terminal tab (its shell, setup and run), or the global Terminal (your own shells). */
export function TerminalView() {
  const api = useApi();
  const actions = useActions();
  const { ui } = useKlaud();
  const state = useApp((st) => st);
  const picked = useUi((u) => u.termKey);
  const view = state.view;
  const { terminals, termExits } = state;
  const running = (k: string): boolean => k in terminals && !(k in termExits);

  if (view.kind === 'workspace') {
    const ws = findWorkspace(state.projects, view.id);
    if (!ws) return null;
    const project = state.projects.find((p) => p.id === ws.projectId);
    const keys = [shellId(ws.id), setupId(ws.id), runId(ws.id)];
    const key = picked && keys.includes(picked) && picked in terminals ? picked : shellId(ws.id);
    const tabs = keys.filter((k) => k in terminals || k === shellId(ws.id));
    const label = (k: string): string => (k === shellId(ws.id) ? 'Shell' : k.endsWith(':setup') ? 'Setup' : 'Run');
    return (
      <div className={s.wrap}>
        <div className={s.bar}>
          {tabs.map((k) => (
            <button key={k} type="button" className={cx(s.tab, k === key && s.tabOn)} onClick={() => ui.patch({ termKey: k })}>
              {running(k) ? <Dot tone="ok" /> : k in termExits ? <Dot tone={termExits[k] === 0 ? 'muted' : 'error'} /> : <Dot tone="muted" />}
              {label(k)}
              {k in termExits ? <span className={s.exit}>{termExits[k] === 0 ? 'done' : `exit ${termExits[k] ?? '?'}`}</span> : null}
            </button>
          ))}
          <span className={s.flex} />
          {project?.scripts?.run ? (
            running(runId(ws.id)) ? (
              <Button size="small" variant="quiet" icon="stop" onClick={() => actions.run({ type: 'ws', id: ws.id, action: 'stop_run' })}>
                Stop
              </Button>
            ) : (
              <Tip label={project.scripts.run.command}>
                <Button size="small" variant="quiet" icon="play" onClick={() => actions.run({ type: 'ws', id: ws.id, action: 'run' })}>
                  Run
                </Button>
              </Tip>
            )
          ) : null}
          {project?.scripts?.setup ? (
            <Tip label={project.scripts.setup.command}>
              <Button size="small" variant="quiet" icon="refresh" onClick={() => actions.run({ type: 'ws', id: ws.id, action: 'setup' })}>
                Setup
              </Button>
            </Tip>
          ) : null}
          <Button size="small" variant="quiet" onClick={() => ui.openMenu({ kind: 'scripts', projectId: ws.projectId })}>
            Commands…
          </Button>
        </div>
        <Xterm key={`${key}:${key in termExits ? 'x' : 'live'}`} termKey={key} start={(size) => (key === shellId(ws.id) ? void api.terminals.shell(ws.id, size) : undefined)} />
        {key in termExits && key === shellId(ws.id) ? (
          <div className={s.restart}>
            <Button size="small" onClick={() => void api.terminals.shell(ws.id)}>
              Start a new shell
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const globals = Object.keys(terminals).filter(isGlobalShell).sort((a, b) => globalShellNumber(a) - globalShellNumber(b));
  const key = picked && isGlobalShell(picked) ? picked : (globals[0] ?? globalShellId(1));
  const tabs = [...new Set([...globals, key])];
  const dir = globalShellDir(state.projects, state.tabs, state.home, state.home);
  const shown = state.home && dir.startsWith(state.home) ? `~${dir.slice(state.home.length)}` : dir;
  return (
    <div className={s.wrap}>
      <div className={s.bar}>
        {tabs.map((k, i) => (
          <span key={k} className={cx(s.tab, k === key && s.tabOn)} role="button" tabIndex={0} onClick={() => ui.patch({ termKey: k })}>
            {running(k) ? <Dot tone="ok" /> : <Dot tone="muted" />}
            Shell {i + 1}
            {k in terminals ? (
              <button type="button" className={s.closeTab} aria-label="Close this shell" onClick={(e) => (e.stopPropagation(), void api.terminals.close(k))}>
                <Icon name="x" size={9} />
              </button>
            ) : null}
          </span>
        ))}
        <IconButton icon="plus" label="New shell" onClick={() => ui.patch({ termKey: globalShellId(Math.max(0, ...globals.map(globalShellNumber)) + 1) })} />
        <span className={s.flex} />
        <span className={s.dir}>{shown}</span>
      </div>
      <Xterm key={`${key}:${key in termExits ? 'x' : 'live'}`} termKey={key} start={(size) => void api.terminals.global(key, dir, size)} />
      {key in termExits ? (
        <div className={s.restart}>
          <Button size="small" onClick={() => void api.terminals.global(key, dir)}>
            Start it again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
