import { runId, setupId, shellId, terminalLabel } from '@beluga/shared/terminal-keys.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Button, Dot, Empty, IconButton, Tip } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useBeluga, useUi } from '../lib/beluga.js';
import { type GlobalShells, useGlobalShells } from '../lib/shells.js';
import { extraShells, useShellOwners } from '../lib/ws-shells.js';
import s from './terminal.module.css';
import { TerminalTab } from './TerminalTab.js';
import { Xterm } from './Xterm.js';

/** A workspace's Terminal tab (its shell, setup and run), or the global Terminal (your own shells). */
export function TerminalView() {
  const api = useApi();
  const actions = useActions();
  const { ui } = useBeluga();
  const state = useApp((st) => st);
  const picked = useUi((u) => u.termKey);
  const shells = useGlobalShells();
  const owners = useShellOwners();
  const view = state.view;
  const { terminals, termExits, termNames } = state;
  const running = (k: string): boolean => k in terminals && !(k in termExits);

  if (view.kind === 'workspace') {
    const ws = findWorkspace(state.projects, view.id);
    if (!ws) return null;
    const project = state.projects.find((p) => p.id === ws.projectId);
    // Its shell, setup and run, and the shells added with + in the panel (lib/ws-shells.ts).
    const extra = extraShells(owners, ws.id, terminals, undefined);
    const keys = [shellId(ws.id), setupId(ws.id), runId(ws.id), ...extra];
    const key = picked && keys.includes(picked) && picked in terminals ? picked : shellId(ws.id);
    const tabs = keys.filter((k) => k in terminals || k === shellId(ws.id));
    return (
      <div className={s.wrap}>
        <div className={s.bar}>
          {tabs.map((k) => (
            <TerminalTab
              key={k}
              termKey={k}
              label={terminalLabel(k, termNames)}
              on={k === key}
              className={s.tab}
              onClassName={s.tabOn}
              renamable={k === shellId(ws.id) || extra.includes(k)}
              onPick={() => ui.patch({ termKey: k })}
              before={running(k) ? <Dot tone="ok" /> : k in termExits ? <Dot tone={termExits[k] === 0 ? 'muted' : 'error'} /> : <Dot tone="muted" />}
              after={k in termExits ? <span className={s.exit}>{termExits[k] === 0 ? 'done' : `exit ${termExits[k] ?? '?'}`}</span> : null}
            />
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
        <Xterm key={`${key}:${key in termExits ? 'x' : 'live'}`} termKey={key} start={(size) => (key === shellId(ws.id) ? void api.terminals.shell(ws.id, size) : extra.includes(key) ? void api.terminals.global(key, ws.path, size) : undefined)} />
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
        <TerminalTab key={t.key} termKey={t.key} label={t.label} on={t.key === shells.key} className={s.tab} onClassName={s.tabOn} onPick={() => shells.pick(t.key)} onClose={() => shells.close(t.key)} before={<Dot tone={t.running ? 'ok' : 'muted'} />} />
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
