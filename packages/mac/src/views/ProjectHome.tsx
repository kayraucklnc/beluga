import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { activityOf, stateOf } from '@klaud/ui/workspace-models.js';
import type { Project, Workspace } from '@klaud/workspaces/types.js';
import { EarningsPill } from '../components/EarningsPill.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Button, Dot, Empty, Segmented, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useKlaud } from '../lib/klaud.js';
import { usePrefs } from '../lib/prefs.js';
import { mod } from '../lib/system.js';
import { type OverviewFilter, readOverviewPrefs } from './overview/overview-model.js';
import { type HomeModel, agoText, homeModel, lastActive } from './project/home-model.js';
import d from '../chat/draft.module.css';
import s from './project-home.module.css';

/**
 * A project's home: what you see when you click a project. Its main folder is never worked in,
 * so the big box starts work in a new worktree (or just asks a question about the project),
 * and below are its worktrees, the questions asked in main, and what was put away.
 */
export function ProjectHome({ id }: { id: string }) {
  const project = useApp((st) => st.projects.find((p) => p.id === id && p.root));
  const log = useApp((st) => st.log);
  const conflicts = useApp((st) => st.conflicts);
  if (!project) return <Empty icon="folder" title="This project isn’t here anymore" detail="It may have been hidden or moved. Pick another one in the sidebar." />;
  const model = homeModel({ log, conflicts }, project);
  return (
    <div className={s.page} aria-label={`${project.name} home`}>
      <div className={s.column}>
        <Header model={model} />
        <HomeComposer project={project} />
        <Lists model={model} />
      </div>
    </div>
  );
}

const OVERVIEW_KEY = 'klaud.overview.v1';

/** Open the Overview narrowed to one project and segment (Archived, Ready to Merge…). */
function useOpenOverview(): (projectId: string, filter: OverviewFilter) => void {
  const actions = useActions();
  return (projectId, filter) => {
    try {
      const current = readOverviewPrefs(localStorage.getItem(OVERVIEW_KEY));
      localStorage.setItem(OVERVIEW_KEY, JSON.stringify({ ...current, filter, project: projectId }));
    } catch {
      // No storage: the Overview opens as you left it.
    }
    actions.run({ type: 'view', view: { kind: 'overview' } });
  };
}

function Header({ model }: { model: HomeModel }) {
  const { project, main, mainLine, stats } = model;
  const overview = useOpenOverview();
  const branch = main?.status?.branch ?? main?.branch;
  return (
    <header className={s.header}>
      <ProjectIcon id={project.id} name={project.name} size={44} />
      <div className={s.heading}>
        <h1 className={s.name}>{project.name}</h1>
        <div className={s.meta}>
          {branch ? (
            <span className={s.branch}>
              <Icon name="branch" size={11} />
              {branch}
            </span>
          ) : null}
          <Tip label="Compared with what was last fetched from the remote">
            <span className={cx(s.sync, s[`tone_${mainLine.tone}`])}>
              <Dot tone={mainLine.tone === 'muted' ? 'muted' : mainLine.tone} />
              {mainLine.label}
            </span>
          </Tip>
          {mainLine.dirty ? <span className={cx(s.sync, s.tone_warn)}>{mainLine.dirty}</span> : null}
        </div>
      <div className={s.stats} role="group" aria-label="At a glance">
        <span className={s.stat}>
          <strong>{stats.active}</strong> active
        </span>
        <button type="button" className={s.stat} disabled={!stats.ready} onClick={() => overview(project.id, 'ready')}>
          <strong>{stats.ready}</strong> ready to merge
        </button>
        <button type="button" className={s.stat} disabled={!stats.archived} onClick={() => overview(project.id, 'archived')}>
          <strong>{stats.archived}</strong> archived
        </button>
        <EarningsPill root={project.root} projectId={project.id} />
      </div>
      </div>
    </header>
  );
}

type Mode = 'worktree' | 'ask';

/** The branches a new worktree can start from (the default first). */
function useBranches(projectId: string): { base: string; branches: readonly string[] } | undefined {
  const api = useApi();
  const [branches, setBranches] = useState<{ base: string; branches: readonly string[] }>();
  useEffect(() => {
    let alive = true;
    setBranches(undefined);
    api.workspaces.branches(projectId).then(
      (b) => alive && b && setBranches(b),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [projectId]);
  return branches;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * "What do you want to do in <project>?": New Worktree (the default: Return makes a worktree
 * from the latest origin, named after the task, and Claude starts there) or Just Ask (a
 * questions-only chat in the main folder).
 */
function HomeComposer({ project }: { project: Project }) {
  const api = useApi();
  const { client } = useKlaud();
  const prefs = usePrefs();
  const [mode, setMode] = useState<Mode>('worktree');
  const [text, setText] = useState('');
  const [base, setBase] = useState<string>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const branches = useBranches(project.id);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setText('');
    setName('');
    setBase(undefined);
    setMode('worktree');
    ref.current?.focus();
  }, [project.id]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 60), 10 * 20 + 20)}px`;
  }, [text]);
  const worktree = mode === 'worktree';
  const task = text.trim();
  const ready = worktree ? Boolean(task || name.trim()) : Boolean(task);
  const chosen = base ?? branches?.base ?? project.base;
  const options = branches?.branches.length ? branches.branches : chosen ? [chosen] : [];
  const sendKeys = prefs.sendWith === 'enter' ? '↩' : `${mod()}↩`;

  const send = async (): Promise<void> => {
    if (!ready || busy) {
      if (!ready) toast(client, worktree ? 'Describe the task, or give the worktree a name' : 'Type your question first', 'info');
      return;
    }
    setBusy(true);
    try {
      if (worktree) await api.workspaces.startWorktree(project.id, task, { ...(base ? { base } : {}), ...(name.trim() ? { name: name.trim() } : {}) });
      else await api.workspaces.startChat(project.id, task);
      setText('');
      setName('');
    } catch (err) {
      toast(client, `${worktree ? 'Couldn’t create the worktree' : 'Couldn’t start the chat'}: ${errorText(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key !== 'Enter') return;
    const modKey = e.metaKey || e.ctrlKey;
    const sends = prefs.sendWith === 'enter' ? !e.shiftKey && !modKey : modKey;
    if (!sends) return;
    e.preventDefault();
    void send();
  };

  return (
    <section className={s.composer} aria-label="Start something">
      <div className={s.composerHead}>
        <h2 className={s.prompt}>What do you want to do in {project.name}?</h2>
        <Segmented<Mode>
          label="How to start"
          value={mode}
          onChange={(m) => {
            setMode(m);
            ref.current?.focus();
          }}
          options={[
            { value: 'worktree', label: 'New Worktree', icon: 'branch', hint: 'Claude works on its own branch and folder, made from the latest origin' },
            { value: 'ask', label: 'Just Ask', icon: 'chat', hint: 'A question about the project: Claude reads the main folder and changes nothing' },
          ]}
        />
      </div>
      <div className={cx(s.box, busy && s.busy)}>
        <textarea
          ref={ref}
          className={`${s.input} selectable`}
          aria-label={worktree ? 'Task for the new worktree' : `Question about ${project.name}`}
          placeholder={worktree ? 'Describe a task: “Add a health check endpoint with a test”' : `Ask about ${project.name}…`}
          value={text}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          spellCheck
        />
        <div className={s.bar}>
          {worktree ? (
            <>
              <label className={d.field}>
                <span className={d.fieldLabel}>Based on</span>
                <Tip label="The branch the new one starts from (origin branches are fetched first, so it's the latest)">
                  <select className={d.select} aria-label="Based on" value={chosen} onChange={(e) => setBase(e.target.value)}>
                    {options.map((b) => (
                      <option key={b} value={b}>
                        {b}
                        {b === branches?.base ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </Tip>
              </label>
              <label className={d.field}>
                <span className={d.fieldLabel}>Name</span>
                <input className={`${d.name} ${s.nameInput} selectable`} aria-label="Worktree name" placeholder="from the task" value={name} maxLength={60} spellCheck={false} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void send())} />
              </label>
            </>
          ) : (
            <span className={s.note}>
              <Icon name="eye" size={12} />
              Questions only: Claude reads the main folder and won’t change anything.
            </span>
          )}
          <span className={s.flex} />
          <Tip label={worktree ? 'Make the branch and folder, then Claude starts on the task' : 'Start a questions-only chat in the main folder'} keys={sendKeys}>
            <button type="button" className={cx(d.create, ready && d.createReady)} aria-disabled={!ready || busy} onClick={() => void send()}>
              <Icon name={worktree ? 'branch' : 'chat'} size={12} />
              {worktree ? 'Create Worktree' : 'Ask'}
              <span className={d.createKey}>{sendKeys}</span>
            </button>
          </Tip>
        </div>
      </div>
    </section>
  );
}

function Lists({ model }: { model: HomeModel }) {
  const overview = useOpenOverview();
  const { project, worktrees, asks, archived } = model;
  return (
    <div className={s.lists}>
      <Section title="Worktrees" count={worktrees.length}>
        {worktrees.length ? worktrees.map((w) => <Row key={w.id} ws={w} />) : <p className={s.none}>No worktrees yet. Describe a task above and Claude starts one from the latest origin.</p>}
      </Section>
      {asks.length ? (
        <Section title="Questions" count={asks.length} hint="Asked in the main folder: Claude only reads there">
          {asks.map((w) => (
            <Row key={w.id} ws={w} ask />
          ))}
        </Section>
      ) : null}
      {archived.length ? (
        <Section
          title="Recently Archived"
          count={archived.length}
          action={
            <Button size="small" variant="quiet" onClick={() => overview(project.id, 'archived')}>
              Show All in Overview
            </Button>
          }
        >
          {archived.slice(0, 3).map((w) => (
            <Row key={w.id} ws={w} />
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function Section({ title, count, hint, action, children }: { title: string; count: number; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={s.section} aria-label={title}>
      <div className={s.sectionHead}>
        <h3 className={s.sectionTitle}>
          {title} <span className={s.count}>{count}</span>
        </h3>
        {hint ? <span className={s.sectionHint}>{hint}</span> : null}
        <span className={s.flex} />
        {action}
      </div>
      <div className={s.rows} role="list">
        {children}
      </div>
    </section>
  );
}

/** One worktree or question: its state, name, last line and when; a click opens it. */
function Row({ ws, ask }: { ws: Workspace; ask?: boolean }) {
  const actions = useActions();
  const state = useApp((st) => st);
  const st = stateOf(state, ws, 0);
  const act = activityOf(state.log, `ws:${ws.id}`);
  const title = ws.kind === 'main' ? 'Main folder conversation' : ws.name;
  return (
    <div role="listitem">
      <button type="button" className={cx(s.row, ws.archived && s.rowArchived)} onClick={() => actions.run(ws.archived ? { type: 'archived_menu', id: ws.id } : { type: 'open_ws', id: ws.id })} aria-label={`${title}: ${st.label}`}>
        <span className={s.rowIcon}>{ask ? <Icon name="chat" size={13} /> : <Dot tone={st.tone === 'claude' ? 'claude' : st.tone} live={st.tone === 'claude'} />}</span>
        <span className={s.rowMain}>
          <span className={s.rowTitle}>
            <span className={s.rowName}>{title}</span>
            {ws.branch && !ask ? <span className={s.rowBranch}>{ws.branch}</span> : null}
          </span>
          {act.last ? <span className={s.rowLast}>{act.last}</span> : null}
        </span>
        <span className={cx(s.rowState, s[`tone_${st.tone}`])}>{ask ? '' : st.label}</span>
        <span className={s.rowWhen}>{agoText(lastActive(state, ws))}</span>
        <Icon name="chevronRight" size={11} className={s.rowChevron} />
      </button>
    </div>
  );
}
