import { useEffect, useState } from 'react';
import { type Criterion, criteria } from '@beluga/core/board/criteria.js';
import type { Plan } from '@beluga/core/plans/model.js';
import { taskProof } from '@beluga/core/board/model.js';
import type { MilestoneView, PlanView, TaskView } from '@beluga/core/plans/progress.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon } from '../components/Icon.js';
import { Button, IconButton, cx } from '../components/ui.js';
import { openSheet } from '../lib/sheets.js';
import { ProofItems } from '../tasks/TaskSections.js';
import { MILESTONE_STATE, taskWords } from './plans-model.js';
import { TaskChatMark, TaskStateIcon, TonePill } from './marks.js';
import { openDecision } from './plan-ask-model.js';
import { PlanFeed } from './PlanFeed.js';
import { useClock, usePlanActions } from './use-plans.js';
import { useStartWith } from '../components/agent-options.js';
import { SplitButton } from '../components/SplitButton.js';
import { useMyAgent } from '../lib/agent-words.js';
import type { AgentRef } from '@beluga/protocol.js';
import { WaitingLine } from './WaitingLine.js';
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
  // Its state in words, with what it's doing now (the step and its time, a stall, a usage limit).
  const now = useClock(t.pulse?.kind === 'working' || t.pulse?.kind === 'command');
  const info = taskWords(t, now);
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
      {info.sub && t.pulse ? <p className={p.detailsStep}>{t.pulse.kind === 'working' || t.pulse.kind === 'command' ? `Now: ${info.sub}` : info.sub}</p> : t.step && t.state === 'running' ? <p className={p.detailsStep}>Now: {t.step}</p> : null}
      {t.waiting?.length ? (
        <p className={p.detailsWaiting}>
          <WaitingLine waiting={t.waiting} each />
        </p>
      ) : null}
    </>
  );
}

function TaskDetails({ view, t, canStart }: { view: PlanView; t: TaskView; canStart: boolean }) {
  const { api, act, openTask, openWorktree } = usePlanActions();
  const all = view.milestones.flatMap((m) => m.tasks);
  // Its Claude stopped without finishing: one click wakes it with what it missed.
  const canResume = Boolean(t.worktree) && (t.state === 'idle' || t.state === 'stalled');
  // The board's checklist when it has one (ticked, or explained with its reason: deferred, not done), else the plan's.
  const onBoard = criteria(t.issue?.brief.acceptance);
  const checks: readonly Criterion[] = onBoard.length ? onBoard : t.task.acceptance.map((text) => ({ text, state: 'open' as const }));
  const startWith = useStartWith();
  const mine = useMyAgent();
  // Its own agent, else the plan's: who Start uses. The ▾ (BLG-506): another, this start only.
  const own = t.issue?.agent ?? view.plan.agent;
  const startIt = (agent?: AgentRef): void => void act(() => api.startTask(view.plan.id, t.task.id, agent));
  return (
    <>
      {t.why && (t.state === 'blocked' || t.state === 'later') ? <p className={p.muted}>{t.why}</p> : null}
      <div className={p.detailsActions}>
        {canStart && t.forYou ? (
          <Button size="small" variant="primary" icon="hand" onClick={() => openDecision()}>
            Decide…
          </Button>
        ) : canStart ? (
          <SplitButton label="Start with another agent" items={startWith(own, (a) => startIt(a ?? (own ? mine : undefined)))}>
            <Button size="small" variant="primary" icon="play" onClick={() => startIt()}>
              Start
            </Button>
          </SplitButton>
        ) : null}
        {canResume ? (
          <Button size="small" variant="primary" icon="play" onClick={() => void act(() => api.resumeTask(view.plan.id, t.task.id))}>
            Resume
          </Button>
        ) : null}
        {t.worktree ? (
          // Its chat, one click away (with its news); its Claude asking you: answering is this click.
          <Button size="small" icon={t.state === 'asking' ? 'chat' : 'branch'} variant={t.state === 'asking' ? 'primary' : 'plain'} onClick={() => openWorktree(t.worktree!)}>
            {t.state === 'asking' ? 'Answer' : canResume ? 'Open Chat' : 'Open Worktree'}
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
      {checks.length ? (
        <section className={p.detailsSection} aria-label="Done when">
          <h4>Done when</h4>
          <ul className={p.checks}>
            {checks.map((c, i) => {
              const explained = c.state === 'deferred' || c.state === 'not_done';
              return (
                <li key={i} className={cx(c.state === 'done' && p.checkDone, explained && p.checkExplained)} data-state={c.state}>
                  <span className={p.checkBox} aria-hidden="true">
                    {explained ? <Icon name={c.state === 'deferred' ? 'clock' : 'minus'} size={9} /> : null}
                  </span>
                  <span>
                    {c.text}
                    {explained ? (
                      <span className={p.checkReason}>
                        {c.state === 'deferred' ? 'Deferred' : 'Not done'} · {c.reason}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
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
      {t.issue && taskProof(t.issue).length ? (
        <section className={p.detailsSection} aria-label="Proof">
          <h4>Proof</h4>
          <ProofItems issue={t.issue} readOnly />
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
          <h4>{check.verdict === 'pass' ? 'The agent’s check: passes' : 'The agent’s check: not yet'}</h4>
          <Markdown text={check.notes} />
        </section>
      ) : null}
    </>
  );
}
