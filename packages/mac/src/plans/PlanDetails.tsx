import type { Plan } from '@klaud/core/plans/model.js';
import type { MilestoneView, PlanView, TaskView } from '@klaud/core/plans/progress.js';
import { Markdown } from '../chat/Markdown.js';
import { Button, IconButton } from '../components/ui.js';
import { openSheet } from '../lib/sheets.js';
import { MILESTONE_STATE, taskWords } from './plans-model.js';
import { TaskStateIcon, TonePill } from './marks.js';
import { useClock, usePlanActions } from './use-plans.js';
import p from './plans.module.css';

/** What you picked on the plan: a task (its goal, criteria, what it waits on, where it runs) or a milestone's gate. */
export function PlanDetails({ view, picked, canStart, onClose }: { view: PlanView; picked: string; canStart: boolean; onClose: () => void }) {
  const gate = picked.startsWith('gate:') ? view.milestones.find((m) => `gate:${m.milestone.id}` === picked) : undefined;
  const task = gate ? undefined : view.milestones.flatMap((m) => m.tasks).find((t) => t.task.id === picked);
  if (!gate && !task) return null;
  return (
    <aside className={p.details} aria-label="Details">
      <IconButton icon="x" label="Close" className={p.detailsClose} onClick={onClose} />
      {gate ? <GateDetails plan={view.plan} m={gate} /> : <TaskDetails view={view} t={task!} canStart={canStart} />}
    </aside>
  );
}

function TaskDetails({ view, t, canStart }: { view: PlanView; t: TaskView; canStart: boolean }) {
  const { api, act, openTask, openWorktree } = usePlanActions();
  const all = view.milestones.flatMap((m) => m.tasks);
  const now = useClock(t.pulse?.kind === 'working' || t.pulse?.kind === 'command');
  const info = taskWords(t, now);
  // Its Claude stopped without finishing: one click wakes it with what it missed.
  const canResume = Boolean(t.worktree) && (t.state === 'idle' || t.state === 'stalled');
  const ticked = new Set((t.issue?.brief.acceptance ?? '').split('\n').flatMap((l) => (/^\s*[-*]\s+\[[xX]\]\s+(.*)$/.exec(l)?.[1] ? [/^\s*[-*]\s+\[[xX]\]\s+(.*)$/.exec(l)![1]!.trim()] : [])));
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
      {t.why && (t.state === 'blocked' || t.state === 'later') ? <p className={p.muted}>{t.why}</p> : null}
      <div className={p.detailsActions}>
        {canStart ? (
          <Button size="small" variant="primary" icon="play" onClick={() => void act(() => api.startTask(view.plan.id, t.task.id))}>
            Start
          </Button>
        ) : null}
        {canResume ? (
          <Button size="small" variant="primary" icon="play" onClick={() => void act(() => api.resumeTask(view.plan.id, t.task.id))}>
            Resume
          </Button>
        ) : null}
        {t.worktree ? (
          <Button size="small" icon="branch" onClick={() => openWorktree(t.worktree!)}>
            {canResume ? 'Open Chat' : 'Open Worktree'}
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

function GateDetails({ plan, m }: { plan: Plan; m: MilestoneView }) {
  const { api, act } = usePlanActions();
  const info = MILESTONE_STATE[m.state];
  const check = m.run.check;
  const yours = plan.body && !plan.draft && (m.state === 'gate' || m.state === 'checking' || m.state === 'failed');
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
      {yours ? (
        <div className={p.detailsActions}>
          <Button size="small" variant="primary" icon="check" onClick={() => void act(() => api.pass(plan.id, m.milestone.id))}>
            {m.state === 'failed' ? 'Pass Anyway' : 'Pass Milestone'}
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
