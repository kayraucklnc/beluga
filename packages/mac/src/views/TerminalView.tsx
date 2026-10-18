import { runId, setupId, shellId } from '@klaud/shared/terminal-keys.js';
import { findWorkspace } from '@klaud/ui/workspace-models.js';
import { Icon } from '../components/Icon.js';
import { Button, Dot, Empty, IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useKlaud, useUi } from '../lib/klaud.js';
import { type GlobalShells, useGlobalShells } from '../lib/shells.js';
import s from './terminal.module.css';
import { Xterm } from './Xterm.js';

/** A workspace's Terminal tab (its shell, setup and run), or the global Terminal (your own shells). */
export function TerminalView() {
  const api = useApi();
  const actions = useActions();
  const { ui } = useKlaud();
  const state = useApp((st) => st);
  const picked = useUi((u) => u.termKey);
  const shells = useGlobalShells();
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

  const { key, dir } = shells;
  const shown = state.home && dir.startsWith(state.home) ? `~${dir.slice(state.home.length)}` : dir;
  return (
    <div className={s.wrap}>
      <div className={s.bar}>
        <ShellTabs shells={shells} />
        <span className={s.flex} />
        <span className={s.dir}>{shown}</span>
      </div>
      {key ? (
        <>
          <Xterm key={`${key}:${key in termExits ? 'x' : 'live'}`} termKey={key} start={(size) => void api.terminals.global(key, dir, size)} />
          {key in termExits ? (
            <div className={s.restart}>
              <Button size="small" onClick={() => void api.terminals.global(key, dir)}>
                Start it again
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <NoShells open={shells.open} />
      )}
    </div>
  );
}

/** Your shells as tabs, each with a close button, and + for another one. */
export function ShellTabs({ shells }: { shells: GlobalShells }) {
  return (
    <>
      {shells.tabs.map((t) => (
        <span key={t.key} className={cx(s.tab, t.key === shells.key && s.tabOn)} role="tab" aria-selected={t.key === shells.key} tabIndex={0} onClick={() => shells.pick(t.key)} onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), shells.pick(t.key))}>
          <Dot tone={t.running ? 'ok' : 'muted'} />
          {t.label}
          <button type="button" className={s.closeTab} aria-label={`Close ${t.label}`} onClick={(e) => (e.stopPropagation(), shells.close(t.key))}>
            <Icon name="x" size={9} />
          </button>
        </span>
      ))}
      <IconButton icon="plus" label="New shell" onClick={shells.open} />
    </>
  );
}

/** Every shell is closed. */
export function NoShells({ open }: { open: () => void }) {
  return (
    <div className={s.none}>
      <Empty icon="terminal" title="No shells open" action={<Button size="small" icon="plus" onClick={open}>New shell</Button>} />
    </div>
  );
}
