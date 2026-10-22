import { useEffect, useState } from 'react';
import type { Plan } from '@klaud/core/plans/model.js';
import type { MilestoneView, PlanView, TaskView } from '@klaud/core/plans/progress.js';
import { Markdown } from '../chat/Markdown.js';
import { Button, IconButton } from '../components/ui.js';
import { openSheet } from '../lib/sheets.js';
import { MILESTONE_STATE, TASK_STATE } from './plans-model.js';
import { TaskChatMark, TaskStateIcon, TonePill } from './marks.js';
import { PlanFeed } from './PlanFeed.js';
import { usePlanActions } from './use-plans.js';
import p from './plans.module.css';

/** The details pane shows what the plan did when this is picked. */
export const FEED = 'feed';

/**
 * What you picked on the plan: a task (its goal, criteria, what it waits on, where it runs), a
 * milestone's gate, or the plan's feed (what it did). Its head (what it is, its state, Close) stays put while the rest scrolls under it.
 */
export function PlanDetails({ view, picked, canStart, onClose }: { view: PlanView; picked: string; canStart: boolean; onClose: () => void }) {
  const feed = picked === FEED;
  const gate = picked.startsWith('gate:') ? view.milestones.find((m) => `gate:${m.milestone.id}` === picked) : undefined;
  const task = gate || feed ? undefined : view.milestones.flatMap((m) => m.tasks).find((t) => t.task.id === picked);
  const [scrolled, setScrolled] = useState(false);
  const shown = Boolean(feed || gate || task);
  // Another pick starts at its top (the body is keyed by it).
  useEffect(() => setScrolled(false), [picked]);
  // Esc closes it, unless you're typing or a sheet is open (those take Esc first).
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = e.target instanceof HTMLElement ? e.target : undefined;
      if (el?.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('[role="dialog"], [role="menu"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, onClose]);
  if (!shown) return null;
  return (
    <aside className={p.details} aria-label={feed ? 'What happened' : 'Details'}>
      <header className={p.detailsHead} data-scrolled={scrolled ? 'true' : 'false'}>
        <div className={p.detailsHeadText}>{feed ? <FeedHead /> : gate ? <GateHead m={gate} /> : <TaskHead t={task!} />}</div>
        <IconButton icon="x" label="Close" className={p.detailsClose} onClick={onClose} />
      </header>
      <div key={picked} className={p.detailsBody} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
        {feed ? <PlanFeed plan={view.plan} /> : gate ? <GateDetails plan={view.plan} m={gate} /> : <TaskDetails view={view} t={task!} canStart={canStart} />}
      </div>
    </aside>
  );
}

function FeedHead() {
  return (
    <>
      <div className={p.detailsKind}>Plan</div>
      <h3 className={p.detailsTitle}>What happened</h3>
    </>
  );
}

function TaskHead({ t }: { t: TaskView }) {
  const info = TASK_STATE[t.state];
  return (
    <>
      <div className={p.detailsKind}>
        <TaskStateIcon state={t.state} size={13} />
        {t.issue?.key ?? 'Task'}
        {t.task.estimate ? <span className={p.points}>{t.task.estimate}</span> : null}
      </div>
      <h3 className={p.detailsTitle}>{t.task.title}</h3>
      <div className={p.detailsRow}>
        <TonePill tone={info.tone} live={t.state === 'running'}>
          {info.label}
        </TonePill>
        {t.forYou ? <span className={p.muted}>For you</span> : null}
      </div>
    </>
  );
}

function TaskDetails({ view, t, canStart }: { view: PlanView; t: TaskView; canStart: boolean }) {
  const { api, act, openTask, openWorktree } = usePlanActions();
  const all = view.milestones.flatMap((m) => m.tasks);
  const ticked = new Set((t.issue?.brief.acceptance ?? '').split('\n').flatMap((l) => (/^\s*[-*]\s+\[[xX]\]\s+(.*)$/.exec(l)?.[1] ? [/^\s*[-*]\s+\[[xX]\]\s+(.*)$/.exec(l)![1]!.trim()] : [])));
  return (
    <>
      {t.step && t.state === 'running' ? <p className={p.detailsStep}>Now: {t.step}</p> : null}
      {t.why && (t.state === 'blocked' || t.state === 'later') ? <p className={p.muted}>{t.why}</p> : null}
      <div className={p.detailsActions}>
        {canStart ? (
          <Button size="small" variant="primary" icon="play" onClick={() => void act(() => api.startTask(view.plan.id, t.task.id))}>
            Start
          </Button>
        ) : null}
        {t.worktree ? (
          // Its chat, one click away (with its news); its Claude asking you: answering is this click.
          <Button size="small" icon={t.state === 'asking' ? 'chat' : 'branch'} variant={t.state === 'asking' ? 'primary' : 'plain'} onClick={() => openWorktree(t.worktree!)}>
            {t.state === 'asking' ? 'Answer' : 'Open Worktree'}
            <TaskChatMark worktree={t.worktree} />
          </Button>
        ) : null}
        {t.issue ? (
          <Button size="small" variant="quiet" onClick={() => openTask(t.issue!.id)}>
            Open Task
          </Button>
        ) : null}
      </div>
      {t.task.goal ? (
        <section className={p.detailsSection}>
          <h4>Goal</h4>
          <Markdown text={t.task.goal} />
        </section>
      ) : null}
      {t.task.acceptance.length ? (
        <section className={p.detailsSection}>
          <h4>Done when</h4>
          <ul className={p.checks}>
            {t.task.acceptance.map((a) => (
              <li key={a} className={ticked.has(a) ? p.checkDone : undefined}>
                <span className={p.checkBox} aria-hidden="true" />
                {a}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {t.task.blockedBy.length ? (
        <section className={p.detailsSection}>
          <h4>Waits on</h4>
          <ul className={p.plainList}>
            {t.task.blockedBy.map((b) => {
              const other = all.find((x) => x.task.id === b);
              return (
                <li key={b}>
                  {other ? <TaskStateIcon state={other.state} size={12} /> : null}
                  {other?.task.title ?? b}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {t.task.touches?.length ? (
        <section className={p.detailsSection}>
          <h4>Changes</h4>
          <div className={p.touches}>
            {t.task.touches.map((f) => (
              <code key={f}>{f}</code>
            ))}
          </div>
        </section>
      ) : null}
      {t.task.context ? (
        <section className={p.detailsSection}>
          <h4>Context</h4>
          <Markdown text={t.task.context} />
        </section>
      ) : null}
    </>
  );
}

function GateHead({ m }: { m: MilestoneView }) {
  const info = MILESTONE_STATE[m.state];
  return (
    <>
      <div className={p.detailsKind}>Milestone {m.index + 1}</div>
      <h3 className={p.detailsTitle}>{m.milestone.title}</h3>
      <div className={p.detailsRow}>
        <TonePill tone={info.tone} live={m.state === 'checking' || m.state === 'running'}>
          {info.label}
        </TonePill>
        <span className={p.muted}>
          {m.finished}/{m.total} tasks finished
        </span>
      </div>
    </>
  );
}

function GateDetails({ plan, m }: { plan: Plan; m: MilestoneView }) {
  const { api, act } = usePlanActions();
  const check = m.run.check;
  const yours = plan.body && !plan.draft && (m.state === 'gate' || m.state === 'checking' || m.state === 'failed');
  return (
    <>
      {yours ? (
        <div className={p.detailsActions}>
          <Button size="small" variant="primary" icon="check" onClick={() => void act(() => api.pass(plan.id, m.milestone.id))}>
            {m.state === 'failed' || m.state === 'checking' ? 'Pass Anyway' : 'Pass Milestone'}
          </Button>
          <Button size="small" onClick={() => openSheet({ kind: 'plan_send_back', planId: plan.id, milestone: m.milestone.id })}>
            Not Yet…
          </Button>
          {m.state === 'checking' || m.state === 'failed' ? (
            <Button size="small" variant="quiet" onClick={() => void act(() => api.recheck(plan.id, m.milestone.id))}>
              Check Again
            </Button>
          ) : null}
        </div>
      ) : null}
      {m.milestone.goal ? (
        <section className={p.detailsSection}>
          <h4>Goal</h4>
          <Markdown text={m.milestone.goal} />
        </section>
      ) : null}
      <section className={p.detailsSection}>
        <h4>Passes when</h4>
        {m.milestone.criteria.length ? (
          <ul className={p.checks}>
            {m.milestone.criteria.map((c) => (
              <li key={c} className={m.state === 'passed' ? p.checkDone : undefined}>
                <span className={p.checkBox} aria-hidden="true" />
                {c}
              </li>
            ))}
          </ul>
        ) : (
          <p className={p.muted}>No criteria: you pass it when its tasks are done.</p>
        )}
      </section>
      {check ? (
        <section className={p.detailsSection}>
          <h4>{check.verdict === 'pass' ? 'Claude’s check: passes' : 'Claude’s check: not yet'}</h4>
          <Markdown text={check.notes} />
        </section>
      ) : null}
    </>
  );
}
