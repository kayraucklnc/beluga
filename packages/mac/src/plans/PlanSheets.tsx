import { type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AUTONOMIES, AUTONOMY_INFO, type Autonomy, DEFAULT_AUTONOMY, TESTS_AT, TESTS_AT_INFO, type TestsAt } from '@klaud/core/plans/model.js';
import { Field, FormSheet, Popup, TextArea } from '../components/FormSheet.js';
import { Icon, type IconName } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useApp } from '../lib/klaud.js';
import { useTasksPrefs } from '../tasks/use-tasks.js';
import { modeChange } from './plans-model.js';
import { usePlanActions, usePlanView, usePlans } from './use-plans.js';
import p from './plans.module.css';

const AUTONOMY_ICON: Record<Autonomy, IconName> = { step: 'hand', gated: 'flag', autopilot: 'wand' };

/**
 * A new plan: what it's for (Claude plans from it, reading the code) and how far it runs on its
 * own. Opened from a project it's that project's (no picker).
 */
export function NewPlanSheet({ projectId, close }: { projectId?: string; close: () => void }) {
  const prefs = useTasksPrefs();
  const all = useApp((s) => s.projects);
  const projects = useMemo(() => all.filter((p) => p.root && !p.error), [all]);
  const { api, act } = usePlanActions();
  const [goal, setGoal] = useState('');
  const known = projectId !== undefined && projects.some((p) => p.id === projectId);
  const [project, setProject] = useState((known ? projectId : projects.some((p) => p.id === prefs.project) ? prefs.project : projects[0]?.id) ?? '');
  const [autonomy, setAutonomy] = useState<Autonomy>(DEFAULT_AUTONOMY);
  const [testsAt, setTestsAt] = useState<TestsAt>('milestone');
  if (!projects.length) return <FormSheet title="New Plan" intro="Plans belong to a project. Add a project first (File › Add Project…)." submitLabel="OK" hideSubmit onSubmit={close} onCancel={close} />;
  const name = projects.find((p) => p.id === project)?.name;
  return (
    <FormSheet
      title={name ? `Plan in ${name}` : 'New Plan'}
      icon="flag"
      intro="Say what you want built. Claude reads the code and cuts it into milestones and tasks; you talk it through, and nothing reaches the board until you approve."
      submitLabel="Plan with Claude"
      width={600}
      canSubmit={Boolean(goal.trim() && project)}
      onCancel={close}
      onSubmit={async () => {
        close();
        await act(() => api.create({ projectId: project, goal: goal.trim(), autonomy, testsAt }));
      }}
    >
      <div className={p.newPlan}>
        <label className={p.newPlanLabel} htmlFor="plan-goal">
          Goal
        </label>
        <GoalBox value={goal} onChange={setGoal} />
        <div className={p.newPlanHint}>What it’s for and what done looks like. ⌘↩ starts planning.</div>
        {known ? null : (
          <div className={p.newPlanRow}>
            <span className={p.newPlanLabel}>Project</span>
            <Popup label="Project" value={project} options={projects.map((p) => ({ value: p.id, label: p.name }))} onChange={setProject} />
          </div>
        )}
        <div className={p.newPlanLabel} id="plan-runs">
          How it runs
        </div>
        <AutonomyCards value={autonomy} onChange={setAutonomy} />
        <div className={p.newPlanRow}>
          <span className={p.newPlanLabel}>When to run tests</span>
          <Popup label="When to run tests" value={testsAt} options={TESTS_AT.map((t) => ({ value: t, label: TESTS_AT_INFO[t].label }))} onChange={setTestsAt} />
        </div>
        <div className={p.newPlanHint}>{TESTS_AT_INFO[testsAt].hint}.</div>
      </div>
    </FormSheet>
  );
}

/** The goal: six lines to start, growing with what you write (to about 60% of the sheet, then it scrolls). */
function GoalBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <TextArea
      ref={ref}
      id="plan-goal"
      className={p.goalBox}
      value={value}
      onChange={onChange}
      rows={6}
      placeholder={'Let customers pay by card: a checkout page, webhooks that never double-charge, and refunds from the admin.\nDone when a test card goes through end to end and a refund shows up in Stripe.'}
      data-autofocus
    />
  );
}

/** Step by Step, Check-ins, Autopilot: three cards you can read without hovering (a radio group; the arrows move). */
function AutonomyCards({ value, onChange, current }: { value: Autonomy; onChange: (a: Autonomy) => void; current?: Autonomy }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = AUTONOMIES[(AUTONOMIES.indexOf(value) + step + AUTONOMIES.length) % AUTONOMIES.length]!;
    onChange(next);
    refs.current[AUTONOMIES.indexOf(next)]?.focus();
  };
  return (
    <div className={p.modeCards} role="radiogroup" aria-labelledby="plan-runs" onKeyDown={onKeyDown}>
      {AUTONOMIES.map((a, i) => {
        const on = a === value;
        return (
          <button
            key={a}
            ref={(el) => void (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={cx(p.modeCard, on && p.modeCardOn)}
            onClick={() => onChange(a)}
          >
            <span className={p.modeIcon} aria-hidden="true">
              <Icon name={AUTONOMY_ICON[a]} size={16} />
            </span>
            <span className={p.modeName}>{AUTONOMY_INFO[a].label}</span>
            <span className={p.modeSummary}>{AUTONOMY_INFO[a].summary}</span>
            {a === current ? <span className={p.modeNow}>Now</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * How a running plan runs: the same three cards as a new plan. Picking another one says, in plain
 * words, what changes from now on (and what happens at once); Switch applies it and it's in the feed.
 */
export function PlanModeSheet({ planId, close }: { planId: string; close: () => void }) {
  const plan = usePlans().plans.find((x) => x.id === planId);
  const view = usePlanView(plan);
  const { api, act } = usePlanActions();
  const [mode, setMode] = useState<Autonomy>(plan?.autonomy ?? DEFAULT_AUTONOMY);
  if (!plan || !view) return <FormSheet title="How It Runs" intro="This plan is gone." submitLabel="OK" hideSubmit onSubmit={close} onCancel={close} />;
  const mixed = plan.body?.milestones.some((m) => m.autonomy && m.autonomy !== plan.autonomy);
  const change = mode !== plan.autonomy || mixed ? modeChange(view, mode) : undefined;
  return (
    <FormSheet
      title="How It Runs"
      icon="flag"
      intro={`“${plan.body?.title ?? plan.draft?.title ?? 'This plan'}” runs on ${AUTONOMY_INFO[plan.autonomy].label} now. Pick how it runs from here on.`}
      submitLabel={change?.title ?? 'Switch'}
      canSubmit={Boolean(change)}
      width={600}
      onCancel={close}
      onSubmit={async () => {
        close();
        await act(() => api.setAutonomy(plan.id, mode), `Runs on ${AUTONOMY_INFO[mode].label} now`);
      }}
    >
      <div className={p.newPlan}>
        <div className={p.newPlanLabel} id="plan-runs">
          How it runs
        </div>
        <AutonomyCards value={mode} onChange={setMode} current={plan.autonomy} />
        {change ? (
          <div className={p.modeConfirm} role="status" aria-label="What changes">
            <p>{change.from}</p>
            {change.now ? <p className={p.modeConfirmNow}>{change.now}</p> : null}
          </div>
        ) : (
          <p className={p.newPlanHint}>{AUTONOMY_INFO[plan.autonomy].hint}.</p>
        )}
      </div>
    </FormSheet>
  );
}

/** How you like plans cut: added to Claude's planning instructions every time. */
export function PlanStyleSheet({ close }: { close: () => void }) {
  const style = usePlans().style;
  const { api, act } = usePlanActions();
  const [text, setText] = useState(style);
  return (
    <FormSheet
      title="Planning Style"
      icon="flag"
      intro="How you like plans cut: task size, when to add a review, what every milestone must prove. Claude follows it whenever it plans."
      submitLabel="Save"
      onCancel={close}
      onSubmit={async () => {
        close();
        await act(() => api.setStyle(text), 'Planning style saved');
      }}
    >
      <Field label="Style" htmlFor="plan-style" hint="Markdown. Kept in ~/.klaud/planning.md.">
        <TextArea id="plan-style" value={text} onChange={setText} rows={9} placeholder={'- Tasks are at most a day of work\n- Every milestone ends with screenshots of what changed\n- Tests before code; no task without them'} data-autofocus />
      </Field>
    </FormSheet>
  );
}

/** Not yet: what a milestone still needs. The plan's head Claude adds the work for it. */
export function SendBackSheet({ planId, milestone, close }: { planId: string; milestone: string; close: () => void }) {
  const title = usePlans().plans.find((p) => p.id === planId)?.body?.milestones.find((m) => m.id === milestone)?.title ?? 'this milestone';
  const { api, act } = usePlanActions();
  const [note, setNote] = useState('');
  return (
    <FormSheet
      title={`Not Yet: ${title}`}
      icon="flag"
      intro="Say what’s missing. Claude adds the tasks that fix it to this milestone, for you to approve."
      submitLabel="Send to Claude"
      canSubmit={Boolean(note.trim())}
      onCancel={close}
      onSubmit={async () => {
        close();
        await act(() => api.sendBack(planId, milestone, note.trim()));
      }}
    >
      <Field label="What’s missing" htmlFor="plan-note">
        <TextArea id="plan-note" value={note} onChange={setNote} rows={4} placeholder="Refunds work, but the admin doesn’t show partial refunds yet." data-autofocus />
      </Field>
    </FormSheet>
  );
}
