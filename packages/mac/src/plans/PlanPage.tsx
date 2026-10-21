import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AUTONOMY_INFO, MAX_PARALLEL, type Plan, shownBody } from '@klaud/core/plans/model.js';
import type { PlanView } from '@klaud/core/plans/progress.js';
import { formatDuration } from '@klaud/shared/text.js';
import { activityOf } from '@klaud/ui/workspace-models.js';
import { useNow } from '../chat/Items.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Button, Empty, IconButton, Segmented, cx } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useApp } from '../lib/klaud.js';
import { openSheet } from '../lib/sheets.js';
import { PlanProgress, Said } from './marks.js';
import { PlanChat } from './PlanChat.js';
import { FEED, PlanDetails } from './PlanDetails.js';
import { PlanOutline } from './PlanOutline.js';
import { barColumns, changeWords, headline, nextWords, titleOf } from './plans-model.js';
import { usePlanActions, usePlanView, usePlans } from './use-plans.js';
import p from './plans.module.css';

const PlanCanvas = lazy(() => import('./PlanCanvas.js'));

type Display = 'graph' | 'outline';
const PREFS = 'klaud.plan.v1';

function readPrefs(): { display: Display; chat: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS) ?? '{}') as { display?: string; chat?: boolean };
    return { display: raw.display === 'outline' ? 'outline' : 'graph', chat: raw.chat !== false };
  } catch {
    return { display: 'graph', chat: true };
  }
}

/**
 * A plan's page: what it is and the one thing it waits for, at the top; the plan as a living graph
 * (or an outline) in the middle; and the conversation with Claude beside it, where the plan is
 * talked through and changed. Everything else is a click away (⋯, a task, a gate).
 */
export function PlanPage({ id, task }: { id: string; task?: string }) {
  const plan = usePlans().plans.find((x) => x.id === id);
  const view = usePlanView(plan);
  const [prefs, setPrefsState] = useState(readPrefs);
  const setPrefs = (patch: Partial<typeof prefs>): void => {
    const next = { ...prefs, ...patch };
    setPrefsState(next);
    try {
      localStorage.setItem(PREFS, JSON.stringify(next));
    } catch {
      // Kept for now.
    }
  };
  const [picked, setPicked] = useState<string | undefined>(task);
  // Opened at a task (a notification about it): that task is picked.
  useEffect(() => {
    if (task) setPicked(task);
  }, [task]);
  const { openList } = usePlanActions();
  // A task taken out of the plan isn't picked any more.
  useEffect(() => {
    if (picked && view && picked !== FEED && !picked.startsWith('gate:') && !view.milestones.some((m) => m.tasks.some((t) => t.task.id === picked))) setPicked(undefined);
  }, [view, picked]);
  if (!plan || !view) return <Empty icon="flag" title="This plan is gone" detail="It was deleted. Its tasks stay on the board." action={<Button onClick={() => openList()}>Back to Plans</Button>} />;
  return <Page view={view} prefs={prefs} setPrefs={setPrefs} picked={picked} setPicked={setPicked} />;
}

function Page({ view, prefs, setPrefs, picked, setPicked }: { view: PlanView; prefs: { display: Display; chat: boolean }; setPrefs: (p: Partial<{ display: Display; chat: boolean }>) => void; picked?: string; setPicked: (id: string | undefined) => void }) {
  const { plan } = view;
  const { api, act, openList, openWorktree } = usePlanActions();
  const body = shownBody(plan);
  const keys = useMemo(() => new Map(view.milestones.flatMap((m) => m.tasks.flatMap((t) => (t.issue ? [[t.task.id, t.issue.key] as const] : [])))), [view]);
  const startable = useMemo(() => {
    if (!plan.body || plan.draft || view.active.length >= plan.maxParallel || !view.open.length) return new Set<string>();
    const step = new Set(view.open.filter((m) => m.autonomy === 'step').map((m) => m.milestone.id));
    return new Set(view.ready.filter((t) => t.forYou || plan.paused || step.has(t.milestoneId)).map((t) => t.task.id));
  }, [view, plan]);
  const start = useCallback((taskId: string) => void act(() => api.startTask(plan.id, taskId)), [plan.id, act, api]);
  const next = view.next;
  const words = nextWords(next);
  const line = headline(view);
  // Claude is writing the first plan: one placeholder and one line say so, nothing else.
  const drafting = !plan.body && !body?.milestones.length;

  const primary = ((): { label: string; run: () => void; icon?: 'check' | 'play' } | undefined => {
    switch (next.kind) {
      case 'approve':
        return body?.milestones.length ? { label: 'Approve Plan', icon: 'check', run: () => void act(() => api.approve(plan.id), 'Plan approved: its tasks are on the board') } : undefined;
      case 'review_changes':
        return { label: 'Apply Changes', icon: 'check', run: () => void act(() => api.approve(plan.id), 'Changes applied') };
      case 'resume':
        return { label: 'Resume', icon: 'play', run: () => void act(() => api.setPaused(plan.id, false)) };
      case 'start':
        return { label: words.title, icon: 'play', run: () => next.tasks.forEach((t) => void act(() => api.startTask(plan.id, t.task.id))) };
      case 'pass':
        return { label: 'Pass Milestone', icon: 'check', run: () => void act(() => api.pass(plan.id, next.milestone.milestone.id)) };
      case 'failed':
        return { label: 'Not Yet…', run: () => openSheet({ kind: 'plan_send_back', planId: plan.id, milestone: next.milestone.milestone.id }) };
      case 'answer':
        return next.tasks[0]?.worktree ? { label: `Answer in ${next.tasks[0].issue?.key ?? 'Its Worktree'}`, run: () => openWorktree(next.tasks[0]!.worktree!) } : undefined;
      default:
        return undefined;
    }
  })();

  const more: ActionItem[] = [
    { label: prefs.chat ? 'Hide the Conversation' : 'Show the Conversation', onSelect: () => setPrefs({ chat: !prefs.chat }) },
    ...(plan.body && plan.status === 'active' ? [{ label: plan.paused ? 'Resume' : 'Pause', onSelect: () => void act(() => api.setPaused(plan.id, !plan.paused)) }] : []),
    { label: 'Run at Once', submenu: [1, 2, 3, 4, 6, MAX_PARALLEL].map((n) => ({ label: `${n} ${n === 1 ? 'task' : 'tasks'}`, checked: plan.maxParallel === n, onSelect: () => void act(() => api.setParallel(plan.id, n)) })), onSelect: () => undefined },
    ...(next.kind === 'pass' ? [{ label: 'Not Yet…', onSelect: () => openSheet({ kind: 'plan_send_back', planId: plan.id, milestone: next.milestone.milestone.id }) }] : []),
    ...(next.kind === 'failed' || next.kind === 'checking'
      ? [
          { label: 'Check Again', onSelect: () => void act(() => api.recheck(plan.id, next.milestone.milestone.id)) },
          { label: 'Pass Anyway', onSelect: () => void act(() => api.pass(plan.id, next.milestone.milestone.id)) },
        ]
      : []),
    { label: 'Copy as Markdown', separate: true, onSelect: () => void copyText(markdownOf(view)) },
    { label: 'Planning Style…', onSelect: () => openSheet({ kind: 'plan_style' }) },
    ...(plan.draft ? [{ label: plan.body ? 'Discard Changes' : 'Discard Draft', danger: true, separate: true, onSelect: () => openSheet({ kind: 'confirm', title: plan.body ? 'Discard the proposed changes?' : 'Discard this draft?', message: plan.body ? 'The plan stays as you approved it.' : 'Nothing was put on the board, so nothing else changes.', confirm: 'Discard', destructive: true, run: () => void act(() => api.discard(plan.id)) }) }] : []),
    ...(plan.body ? [{ label: 'Delete Plan…', danger: true, separate: !plan.draft, onSelect: () => openSheet({ kind: 'confirm', title: `Delete “${titleOf(plan)}”?`, message: 'Its tasks stay on the board; only the plan goes.', confirm: 'Delete', destructive: true, run: () => void act(() => api.remove(plan.id)).then(() => openList(plan.projectId)) }) }] : []),
  ];

  return (
    <div className={p.page}>
      <header className={p.pageHead}>
        <div className={p.headMain}>
          <div className={p.titleRow}>
            <IconButton icon="back" label="All Plans" className={p.back} onClick={() => openList(plan.projectId)} />
            <TitleField value={titleOf(plan)} onSave={(title) => void act(() => api.edit(plan.id, [{ op: 'retitle', title }]))} />
          </div>
          {drafting ? null : (
            <>
              {view.milestones.length && plan.body ? <PlanProgress columns={barColumns(view)} /> : null}
              <button type="button" className={p.saidButton} onClick={() => setPicked(picked === FEED ? undefined : FEED)} aria-label={`${line.who === 'you' ? 'You: ' : ''}${line.text}. Show what happened`}>
                <Said line={line} />
              </button>
            </>
          )}
        </div>
        <div className={p.headActions}>
          {/* How it runs: nothing to run while Claude writes it. A real decision: its sheet says what changes. */}
          {drafting ? null : (
            <Button size="small" variant="quiet" icon="gauge" title={AUTONOMY_INFO[plan.autonomy].hint} onClick={() => openSheet({ kind: 'plan_mode', planId: plan.id })}>
              Runs on {AUTONOMY_INFO[plan.autonomy].label}
              {view.milestones.some((m) => m.milestone.autonomy && m.milestone.autonomy !== plan.autonomy) ? ' (mixed)' : ''}
            </Button>
          )}
          <ActionsDropdown items={more}>
            <IconButton icon="more" label="Plan Options" />
          </ActionsDropdown>
          {primary ? (
            <Button variant="primary" size="small" {...(primary.icon ? { icon: primary.icon } : {})} onClick={primary.run}>
              {primary.label}
            </Button>
          ) : null}
        </div>
      </header>
      {plan.body && plan.draft ? (
        <div className={p.changes} role="status">
          <Icon name="wand" size={13} />
          <strong>Claude proposes changes</strong>
          <span>{changeWords(plan)}</span>
          <span className={p.grow} />
          <Button size="small" variant="quiet" onClick={() => void act(() => api.discard(plan.id))}>
            Discard
          </Button>
          <Button size="small" variant="primary" onClick={() => void act(() => api.approve(plan.id), 'Changes applied')}>
            Apply Changes
          </Button>
        </div>
      ) : null}
      <div className={cx(p.split, prefs.chat && p.splitChat)}>
        <div className={p.stage}>
          <div className={p.stageTools}>
            {drafting ? null : (
              <Segmented<Display>
                label="Show"
                value={prefs.display}
                onChange={(display) => setPrefs({ display })}
                options={[
                  { value: 'graph', label: 'Canvas', hint: 'The plan as a graph' },
                  { value: 'outline', label: 'List', hint: 'Milestone by milestone' },
                ]}
              />
            )}
            {drafting ? null : (
              <Button size="small" variant="quiet" icon="clock" onClick={() => setPicked(picked === FEED ? undefined : FEED)} aria-pressed={picked === FEED}>
                What Happened
              </Button>
            )}
            {!prefs.chat ? (
              <Button size="small" variant="quiet" icon="claude" onClick={() => setPrefs({ chat: true })}>
                Talk to Claude
              </Button>
            ) : null}
          </div>
          {!body?.milestones.length ? (
            <Drafting plan={plan} />
          ) : prefs.display === 'graph' ? (
            <Suspense fallback={<div className={p.canvasNote}>Laying out…</div>}>
              <PlanCanvas view={view} keys={keys} selected={picked} onSelect={setPicked} onStart={start} startable={startable} />
            </Suspense>
          ) : (
            <PlanOutline view={view} keys={keys} selected={picked} onSelect={setPicked} startable={startable} />
          )}
          {picked ? <PlanDetails view={view} picked={picked} canStart={startable.has(picked)} onClose={() => setPicked(undefined)} /> : null}
        </div>
        {prefs.chat ? <PlanChat channel={plan.home} draft={!plan.body || Boolean(plan.draft)} drafting={drafting} onClose={() => setPrefs({ chat: false })} /> : null}
      </div>
    </div>
  );
}

/** The plan's name, changed in place: wraps instead of clipping (descenders and long names show whole); Enter saves. */
function TitleField({ value, onSave }: { value: string; onSave: (title: string) => void }) {
  const [text, setText] = useState(value);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(value), [value]);
  // As tall as its lines: on every change and whenever a new width changes the wrapping.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = (): void => {
      el.style.height = '0px';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      // Next frame: resizing the box inside its own observer's callback is a ResizeObserver loop.
      if (el.clientWidth !== width) (width = el.clientWidth), cancelAnimationFrame(frame), (frame = requestAnimationFrame(fit));
    });
    let frame = 0;
    watch.observe(el);
    return () => (watch.disconnect(), cancelAnimationFrame(frame));
  }, [text]);
  const save = (): void => {
    if (text.trim() && text.trim() !== value) onSave(text.trim());
    else setText(value);
  };
  return (
    <textarea
      ref={box}
      className={cx(p.title, 'selectable')}
      aria-label="Plan name"
      rows={1}
      spellCheck={false}
      value={text}
      onChange={(e) => setText(e.target.value.replace(/\s*\n\s*/g, ' '))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          setText(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * While Claude writes the first plan: the outline of three milestone columns, drawn softly inside
 * the canvas, and the one line that says what's going on (how long it's been at it).
 */
function Drafting({ plan }: { plan: Plan }) {
  const project = useApp((s) => s.projects.find((x) => x.id === plan.projectId)?.name);
  const activity = useApp((s) => activityOf(s.log, plan.home));
  const now = useNow(true);
  const since = activity.startedAt ?? plan.createdAt;
  const fresh = now - plan.createdAt < 20_000;
  const line = activity.running
    ? `Claude is reading ${project ?? 'the code'} and writing the plan · ${formatDuration(Math.max(0, now - since))}`
    : fresh
      ? 'Claude is starting on the plan…'
      : 'Claude isn’t writing the plan right now. Tell it what to plan in the conversation.';
  return (
    <div className={p.writing}>
      <div className={p.skeleton} data-live={activity.running || fresh ? 'true' : undefined} aria-hidden="true">
        {[3, 2, 2].map((n, i) => (
          <div key={i} className={p.skMilestone} style={{ animationDelay: `${i * 220}ms` }}>
            <div className={p.skHead} />
            {Array.from({ length: n }, (_, j) => (
              <div key={j} className={p.skTask} />
            ))}
          </div>
        ))}
      </div>
      <p className={p.writingLine} role="status">
        {line}
      </p>
    </div>
  );
}

/** The plan as Markdown (to paste somewhere). */
function markdownOf(view: PlanView): string {
  const body = shownBody(view.plan);
  if (!body) return '';
  const lines = [`# ${body.title}`, '', body.goal, ''];
  for (const m of view.milestones) {
    lines.push(`## ${m.index + 1}. ${m.milestone.title}`, '');
    if (m.milestone.goal) lines.push(m.milestone.goal, '');
    for (const t of m.tasks) lines.push(`- [${t.state === 'done' ? 'x' : ' '}] ${t.issue ? `${t.issue.key} ` : ''}${t.task.title}${t.task.blockedBy.length ? ` (after ${t.task.blockedBy.join(', ')})` : ''}`);
    if (m.milestone.criteria.length) lines.push('', '**Passes when:**', ...m.milestone.criteria.map((c) => `- ${c}`));
    lines.push('');
  }
  return lines.join('\n');
}
