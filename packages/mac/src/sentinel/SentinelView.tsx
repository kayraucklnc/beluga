import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { CLAUDE_CHANGED, MAX_RUN_AT_ONCE, type Sentinel, type SentinelState, lastRunOf, pausedWords } from '@beluga/core/sentinel/model.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { type ActionItem, ActionsContext, ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, EmptyActions, IconButton, Segmented, Tip, cx } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { currentSheet, openSheet } from '../lib/sheets.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { useClock } from '../lib/window-active.js';
import { RunPill, StepChips, TriggerDisc } from './marks.js';
import { MAC_SCOPE, type Show, countsOf, filterSentinels, footLine, groupSentinels, rowOf } from './sentinel-model.js';
import { sentinelMenu, useRunsFolder, useSentinelActions, useSentinelState, type SentinelActions } from './use-sentinel.js';
import t from '../tasks/tasks.module.css';
import s from './sentinel.module.css';

const ALL = 'all';

/**
 * Sentinel: every watcher, grouped by project (Your Mac last), each with when it runs, its steps,
 * how its last run went and when it runs next. The bar switches project, filters, and shows
 * watching or paused ones; ⋯ has Run at Once and the runs folder. ⌘N makes one, ⌘F filters.
 */
export function SentinelView() {
  const state = useSentinelState();
  const view = useApp((st) => st.view);
  const allProjects = useApp((st) => st.projects);
  const projects = useMemo(() => allProjects.filter((p) => p.root && !p.error), [allProjects]);
  const a = useSentinelActions();
  const folder = useRunsFolder();
  const scope = view.kind === 'sentinel' ? view.projectId : undefined;
  const [show, setShow] = useState<Show>('all');
  const [query, setQuery] = useState('');
  const find = useRef<HTMLInputElement>(null);
  const now = useClock(true, 30_000);

  // ⌘F filters, ⌘N makes a sentinel (in this project when one is picked).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || currentSheet()) return;
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"], [role="combobox"], [role="dialog"]');
      if (e.metaKey && e.key.toLowerCase() === 'f' && !typing) {
        e.preventDefault();
        find.current?.focus();
        find.current?.select();
      } else if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        e.stopPropagation();
        openSheet({ kind: 'new_sentinel', ...(scope ? { projectId: scope } : {}) });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [scope]);

  if (!state.enabled) return <Empty icon="sentinel" title="Sentinel needs the Beluga app" detail="Sentinels run on your Mac, as you: open Beluga for Mac to make one." />;

  const scoped = state.items.filter((x) => filterSentinels([x], { scope, show: 'all' }).length);
  const counts = countsOf(scoped);
  const shown = filterSentinels(state.items, { scope, show, query });
  const groups = groupSentinels(shown, projects);
  const here = scope === MAC_SCOPE ? undefined : projects.find((p) => p.id === scope);
  const scopeName = scope === MAC_SCOPE ? 'Your Mac' : (here?.name ?? 'All projects');
  const more: ActionItem[] = [
    {
      label: 'Run at Once',
      icon: 'claude',
      submenu: Array.from({ length: MAX_RUN_AT_ONCE }, (_, i) => i + 1).map((n) => ({ label: n === 1 ? '1 at a time' : `${n} at once`, checked: state.runAtOnce === n, onSelect: () => void a.act(() => a.api.setRunAtOnce(n)) })),
      onSelect: () => undefined,
    },
    ...(folder ? [{ label: 'Open the Runs Folder', icon: 'folder' as const, hint: 'Each run’s outputs and report', onSelect: () => a.openFolder(folder) }] : []),
  ];

  return (
    <div className={t.view}>
      <div className={t.bar}>
        <div className={t.barGroup}>
          <PickMenu<string>
            label="Project"
            choices={[
              { value: ALL, label: 'All projects', mark: <Icon name="grid" size={14} /> },
              { value: MAC_SCOPE, label: 'Your Mac', mark: <Icon name="laptop" size={14} /> },
              ...projects.map((p) => ({ value: p.id, label: p.name, mark: <ProjectIcon id={p.id} name={p.name} size={16} /> })),
            ]}
            chosen={[scope ?? ALL]}
            onPick={(v) => a.openList(v === ALL ? undefined : v)}
          >
            <button type="button" className={t.projectSwitch} aria-label={`Project: ${scopeName}`}>
              {here ? <ProjectIcon id={here.id} name={here.name} size={18} /> : <Icon name={scope === MAC_SCOPE ? 'laptop' : 'sentinel'} size={16} />}
              <span className={t.projectName}>{scopeName}</span>
              <Icon name="chevronDown" size={11} />
            </button>
          </PickMenu>
          <Segmented<Show>
            label="Show"
            value={show}
            onChange={setShow}
            options={[
              { value: 'watching', label: 'Watching', count: counts.watching, hint: 'Turned on: they run when they’re due' },
              { value: 'paused', label: 'Paused', count: counts.paused, hint: 'Nothing runs until you turn them on' },
              { value: 'all', label: 'All', count: counts.all },
            ]}
          />
        </div>
        <div className={cx(t.barGroup, t.barActions)}>
          <label className={t.find}>
            <Icon name="search" size={12} />
            <input
              ref={find}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter"
              aria-label="Filter sentinels"
              onKeyDown={(e) => {
                if (e.key === 'Escape') (setQuery(''), (e.target as HTMLInputElement).blur());
              }}
            />
            {query ? (
              <button type="button" className={t.findClear} aria-label="Clear the filter" onClick={() => setQuery('')}>
                <Icon name="x" size={10} />
              </button>
            ) : null}
          </label>
          <ActionsDropdown items={more}>
            <IconButton icon="more" label="More for Sentinel" />
          </ActionsDropdown>
          <Tip label="A sentinel runs Claude, a script or a notification on a schedule, and leaves a report" keys="⌘N">
            <Button variant="primary" size="small" icon="plus" onClick={() => openSheet({ kind: 'new_sentinel', ...(scope ? { projectId: scope } : {}) })}>
              New Sentinel
            </Button>
          </Tip>
        </div>
      </div>
      <div className={t.body}>
        {!state.items.length ? (
          <Empty
            icon="sentinel"
            title="Nothing watching yet"
            detail="A sentinel runs Claude, a script or a service on a schedule or when something happens, and leaves a report."
            action={
              <EmptyActions>
                <Button variant="primary" onClick={() => openSheet({ kind: 'new_sentinel', ...(scope ? { projectId: scope } : {}) })}>
                  New Sentinel
                </Button>
                <Button onClick={() => openSheet({ kind: 'new_sentinel', way: 'recipe', ...(scope ? { projectId: scope } : {}) })}>Try a Recipe</Button>
              </EmptyActions>
            }
          />
        ) : !shown.length ? (
          <Empty icon="sentinel" title={query ? 'Nothing matches' : show === 'paused' ? 'Nothing paused' : show === 'watching' ? 'Nothing watching here' : 'No sentinels here'} detail={query ? 'Try other words, or All.' : `In ${scopeName}.`} />
        ) : (
          <div role="table" aria-label="Sentinels">
            {groups.map((g) => (
              <div key={g.projectId ?? MAC_SCOPE} role="rowgroup" aria-label={g.name}>
                {groups.length > 1 || !scope ? (
                  <div className={s.groupHead}>
                    {g.projectId ? <ProjectIcon id={g.projectId} name={g.name} size={14} /> : <Icon name="laptop" size={13} />}
                    {g.name}
                  </div>
                ) : null}
                {g.items.map((x) => (
                  <SentinelRow key={x.id} item={x} state={state} now={now} a={a} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      {state.items.length ? <div className={t.foot}>{footLine(scoped, state.runs, now)}</div> : null}
    </div>
  );
}

const SentinelRow = memo(function SentinelRow({ item, state, now, a }: { item: Sentinel; state: SentinelState; now: number; a: SentinelActions }) {
  const row = rowOf(state, item, now);
  const menu = (): ActionItem[] => sentinelMenu(item, lastRunOf(state, item.id), a);
  return (
    <ActionsContext items={menu}>
      <div
        role="row"
        tabIndex={0}
        className={s.row}
        data-paused={item.paused || undefined}
        data-sentinel={item.id}
        onClick={() => a.open(item.id)}
        onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && a.open(item.id)}
        aria-label={`${item.name}, ${row.sentence}${item.paused ? ', paused' : ''}`}
      >
        <TriggerDisc kind={item.trigger.kind} paused={item.paused} />
        <span className={s.rowMain}>
          <span className={s.rowTop}>
            <span className={s.rowName}>{item.name}</span>
            {item.pausedWhy && item.pausedWhy !== CLAUDE_CHANGED ? (
              <span className={s.problemMark}>
                <Icon name="alert" size={11} />
                {pausedWords(item)}
              </span>
            ) : item.pausedWhy ? (
              <span className={s.pausedMark}>
                <Icon name="claude" size={10} />
                {pausedWords(item)}
              </span>
            ) : item.paused ? (
              <span className={s.pausedMark}>
                <Icon name="pause" size={10} />
                Paused
              </span>
            ) : null}
          </span>
          <span className={s.rowSub}>
            <span className={s.rowSentence}>{row.sentence}</span>
            <StepChips steps={row.steps} />
          </span>
        </span>
        <span className={s.rowEnd}>
          {row.last ? (
            <>
              <RunPill state={row.last.state} />
              <span className={s.headline} title={row.last.headline}>
                {row.last.when} · {row.last.headline}
              </span>
            </>
          ) : (
            <span className={s.headline}>No runs yet</span>
          )}
        </span>
        <span className={s.next}>{row.next ?? ''}</span>
        <span className={s.rowMore} onClick={(e) => e.stopPropagation()}>
          <ActionsDropdown items={menu()}>
            <IconButton icon="more" label={`What to do with ${item.name}`} />
          </ActionsDropdown>
        </span>
      </div>
    </ActionsContext>
  );
});
