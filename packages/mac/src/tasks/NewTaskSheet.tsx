import { useMemo, useState } from 'react';
import { ISSUE_STATUSES, type IssueStatus, PRIORITIES, PRIORITY_INFO, type Priority, STATUS_INFO, issueById } from '@klaud/core/board/model.js';
import { Checkbox, Field, FormSheet, Popup, TextArea, TextInput } from '../components/FormSheet.js';
import { toast, useApp, useKlaud } from '../lib/klaud.js';
import { assigneeChoices } from './tasks-model.js';
import { useBoard, usePeople, useSelf, useSolo, useTaskActions, useTasksPrefs } from './use-tasks.js';

/**
 * A new task: its title, what it's for (the brief's goal), where it goes, and who it's for. Start
 * with Claude makes the worktree and puts Claude on it at once.
 */
export function NewTaskSheet({ projectId, status, parent, close }: { projectId?: string; status?: IssueStatus; parent?: string; close: () => void }) {
  const board = useBoard();
  const prefs = useTasksPrefs();
  const allProjects = useApp((s) => s.projects);
  const projects = useMemo(() => allProjects.filter((p) => p.root && !p.error), [allProjects]);
  const self = useSelf();
  const people = usePeople();
  const { client } = useKlaud();
  const { api, act, open } = useTaskActions();
  const parentIssue = parent ? issueById(board, parent) : undefined;
  // The project you're in (Tasks is always one project's).
  const firstProject = parentIssue?.projectId ?? projectId ?? (projects.some((p) => p.id === prefs.project) ? prefs.project : undefined) ?? projects[0]?.id ?? '';
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [project, setProject] = useState(firstProject);
  const [state, setState] = useState<IssueStatus>(status ?? (prefs.scope === 'backlog' ? 'backlog' : 'todo'));
  const [priority, setPriority] = useState<Priority>('none');
  const choices = assigneeChoices(self, people);
  const [assignee, setAssignee] = useState('');
  const [labels, setLabels] = useState('');
  const [start, setStart] = useState(false);
  const solo = useSolo(project);
  if (!projects.length) {
    return <FormSheet title="New Task" intro="Tasks belong to a project. Add a project first (File › Add Project…)." submitLabel="OK" hideSubmit onSubmit={close} onCancel={close} />;
  }
  return (
    <FormSheet
      title={parentIssue ? `New Sub-task of ${parentIssue.key}` : 'New Task'}
      icon="task"
      intro={parentIssue ? `Under “${parentIssue.title}”.` : 'What needs doing, and why. Claude reads the goal when it works on it.'}
      submitLabel={start ? 'Create and Start' : 'Create Task'}
      canSubmit={Boolean(title.trim() && project)}
      onCancel={close}
      footer={<Checkbox checked={start} onChange={setStart} label="Start with Claude" detail="A new worktree, with Claude working on it" />}
      onSubmit={async () => {
        const who = choices.find((c) => c.key === assignee)?.assignee;
        const created = await api.create({
          projectId: project,
          title: title.trim(),
          status: start ? 'todo' : state,
          priority,
          ...(who ? { assignee: who } : {}),
          labels: labels
            .split(',')
            .map((l) => l.trim())
            .filter(Boolean),
          ...(parentIssue ? { parent: parentIssue.id } : {}),
          ...(goal.trim() ? { goal: goal.trim() } : {}),
        });
        close();
        // (The sheet is gone: a problem starting shows as a toast, and the task is there to start again.)
        if (start) await act(() => api.start(created.id, { claude: true }));
        else {
          toast(client, `Created ${created.key}`, 'success');
          if (parentIssue) open(parentIssue);
        }
      }}
    >
      <Field label="Title" htmlFor="task-title">
        <TextInput id="task-title" value={title} onChange={setTitle} maxLength={200} placeholder="Rate-limit the login endpoint" data-autofocus />
      </Field>
      <Field label="Goal" htmlFor="task-goal" hint="What it’s for and what done looks like. Markdown; ⌘↩ creates it.">
        <TextArea id="task-goal" value={goal} onChange={setGoal} rows={4} placeholder="10 tries a minute per IP, then 429. Logins from the app keep working." />
      </Field>
      {parentIssue ? null : (
        <Field label="Project">
          <Popup label="Project" value={project} options={projects.map((p) => ({ value: p.id, label: p.name }))} onChange={setProject} />
        </Field>
      )}
      {start ? null : (
        <Field label="Status">
          <Popup label="Status" value={state} options={ISSUE_STATUSES.map((s) => ({ value: s, label: STATUS_INFO[s].label }))} onChange={setState} />
        </Field>
      )}
      <Field label="Priority">
        <Popup label="Priority" value={priority} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_INFO[p].label }))} onChange={setPriority} />
      </Field>
      {/* Alone on a project, every task is yours and your Claude's: nothing to choose. */}
      {solo ? null : (
        <Field label="Assignee">
          <Popup label="Assignee" value={assignee} options={[{ value: '', label: 'No one' }, ...choices.map((c) => ({ value: c.key, label: c.label }))]} onChange={setAssignee} />
        </Field>
      )}
      <Field label="Labels" htmlFor="task-labels" hint="Separated by commas">
        <TextInput id="task-labels" value={labels} onChange={setLabels} placeholder="security, api" />
      </Field>
    </FormSheet>
  );
}
