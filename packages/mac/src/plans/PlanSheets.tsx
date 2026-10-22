import { useMemo, useState } from 'react';
import { AUTONOMIES, AUTONOMY_INFO, type Autonomy, TESTS_AT, TESTS_AT_INFO, type TestsAt } from '@klaud/core/plans/model.js';
import { Field, FormSheet, Popup, TextArea } from '../components/FormSheet.js';
import { useApp } from '../lib/klaud.js';
import { useTasksPrefs } from '../tasks/use-tasks.js';
import { usePlanActions, usePlans } from './use-plans.js';

/** A new plan: what it's for (Claude plans from it, reading the code), where, and how far it runs on its own. */
export function NewPlanSheet({ projectId, close }: { projectId?: string; close: () => void }) {
  const prefs = useTasksPrefs();
  const all = useApp((s) => s.projects);
  const projects = useMemo(() => all.filter((p) => p.root && !p.error), [all]);
  const { api, act } = usePlanActions();
  const [goal, setGoal] = useState('');
  const [project, setProject] = useState(projectId ?? (projects.some((p) => p.id === prefs.project) ? prefs.project : projects[0]?.id) ?? '');
  const [autonomy, setAutonomy] = useState<Autonomy>('gated');
  const [testsAt, setTestsAt] = useState<TestsAt>('milestone');
  if (!projects.length) return <FormSheet title="New Plan" intro="Plans belong to a project. Add a project first (File › Add Project…)." submitLabel="OK" hideSubmit onSubmit={close} onCancel={close} />;
  return (
    <FormSheet
      title="New Plan"
      icon="flag"
      intro="Say what you want built. Claude reads the code and cuts it into milestones and tasks that can run side by side; you talk it through, and nothing reaches the board until you approve."
      submitLabel="Plan with Claude"
      canSubmit={Boolean(goal.trim() && project)}
      onCancel={close}
      onSubmit={async () => {
        close();
        await act(() => api.create({ projectId: project, goal: goal.trim(), autonomy, testsAt }));
      }}
    >
      <Field label="Goal" htmlFor="plan-goal" hint="What it’s for and what done looks like. ⌘↩ starts planning.">
        <TextArea id="plan-goal" value={goal} onChange={setGoal} rows={5} placeholder="Let customers pay by card: checkout, webhooks that never double-charge, refunds from the admin." data-autofocus />
      </Field>
      <Field label="Project">
        <Popup label="Project" value={project} options={projects.map((p) => ({ value: p.id, label: p.name }))} onChange={setProject} />
      </Field>
      <Field label="Runs" hint={AUTONOMY_INFO[autonomy].hint}>
        <Popup label="Runs" value={autonomy} options={AUTONOMIES.map((a) => ({ value: a, label: AUTONOMY_INFO[a].label }))} onChange={setAutonomy} />
      </Field>
      <Field label="When to run tests" hint={TESTS_AT_INFO[testsAt].hint}>
        <Popup label="When to run tests" value={testsAt} options={TESTS_AT.map((t) => ({ value: t, label: TESTS_AT_INFO[t].label }))} onChange={setTestsAt} />
      </Field>
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
