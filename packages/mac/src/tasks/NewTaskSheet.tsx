import { type KeyboardEvent, useMemo, useState } from 'react';
import { type IssueStatus, PRIORITY_INFO, type Priority, STATUS_INFO, issueById } from '@beluga/core/board/model.js';
import { Checkbox, Field, FormSheet, Popup, TextArea, TextInput } from '../components/FormSheet.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { toast, useApp, useBeluga } from '../lib/beluga.js';
import { PriorityIcon } from './marks.js';
import { assigneeChoices } from './tasks-model.js';
import { useBoard, usePeople, useSelf, useSolo, useTaskActions, useTasksPrefs } from './use-tasks.js';
import n from './NewTaskSheet.module.css';

/** The priority scale, left to right: its keys are 0 to 4. */
const SCALE: readonly Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];

/**
 * A new task: say what you want in one box and Claude writes its title and goal and picks its
 * labels (or write them yourself), and how much it matters on a scale if you like. It goes in the
 * project and column you opened it from. Start with Claude makes the worktree and puts Claude on it.
 */
export function NewTaskSheet({ projectId, status, parent, close }: { projectId?: string; status?: IssueStatus; parent?: string; close: () => void }) {
  const board = useBoard();
  const prefs = useTasksPrefs();
  const allProjects = useApp((s) => s.projects);
  const projects = useMemo(() => allProjects.filter((p) => p.root && !p.error), [allProjects]);
  const self = useSelf();
  const people = usePeople();
  const { client } = useBeluga();
  const { api, act, open } = useTaskActions();
  const parentIssue = parent ? issueById(board, parent) : undefined;
  // The project you're in (Tasks is always one project's).
  const firstProject = parentIssue?.projectId ?? projectId ?? (projects.some((p) => p.id === prefs.project) ? prefs.project : undefined) ?? projects[0]?.id ?? '';
  const [describe, setDescribe] = useState('');
  const [mine, setMine] = useState(false);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [project, setProject] = useState(firstProject);
  const column: IssueStatus = status ?? parentIssue?.status ?? (prefs.scope === 'backlog' ? 'backlog' : 'todo');
  const [priority, setPriority] = useState<Priority>('none');
  const choices = assigneeChoices(self, people);
  const [assignee, setAssignee] = useState('');
  const [start, setStart] = useState(false);
  const solo = useSolo(project);
  if (!projects.length) {
    return <FormSheet title="New Task" intro="Tasks belong to a project. Add a project first (File › Add Project…)." submitLabel="OK" hideSubmit onSubmit={close} onCancel={close} />;
  }
  // Where it goes, quietly: the project (unless you pick it below) and the column.
  const pickProject = !projectId && !parentIssue;
  const where = [pickProject ? '' : projects.find((p) => p.id === project)?.name, STATUS_INFO[start ? 'todo' : column].label].filter(Boolean).join(' · ');
  return (
    <FormSheet
      title={parentIssue ? `New Sub-task of ${parentIssue.key}` : 'New Task'}
      icon="task"
      intro={parentIssue ? `Under “${parentIssue.title}” · ${where}` : where}
      submitLabel={start ? 'Create and Start' : 'Create Task'}
      canSubmit={Boolean((mine ? title.trim() : describe.trim()) && project)}
      width={560}
      onCancel={close}
      footer={<Checkbox checked={start} onChange={setStart} label="Start with Claude" detail="A new worktree, with Claude working on it" />}
      onSubmit={async () => {
        const who = choices.find((c) => c.key === assignee)?.assignee;
        const created = await api.create({
          projectId: project,
          ...(mine ? { title: title.trim(), ...(goal.trim() ? { goal: goal.trim() } : {}) } : { describe: describe.trim() }),
          status: start ? 'todo' : column,
          priority,
          ...(who ? { assignee: who } : {}),
          ...(parentIssue ? { parent: parentIssue.id } : {}),
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
      {mine ? (
        <>
          <Field label="Title" htmlFor="task-title">
            <TextInput id="task-title" value={title} onChange={setTitle} maxLength={200} placeholder="Rate-limit the login endpoint" data-autofocus />
          </Field>
          <Field label="Goal" htmlFor="task-goal" hint="What it’s for and what done looks like. Markdown; ⌘↩ creates it.">
            <TextArea id="task-goal" value={goal} onChange={setGoal} rows={4} placeholder="10 tries a minute per IP, then 429. Logins from the app keep working." />
          </Field>
        </>
      ) : (
        <div className={n.describe}>
          <TextArea
            aria-label="Describe the task"
            className={n.box}
            value={describe}
            onChange={setDescribe}
            rows={4}
            maxLength={8000}
            placeholder="Describe the task: what you want, and why. Claude writes the title and goal."
            onInput={(e) => grow(e.currentTarget)}
            data-autofocus
          />
          <div className={n.hint}>Claude writes the title, goal and what done looks like, and picks its labels. ⌘↩ creates it.</div>
        </div>
      )}
      <button type="button" className={n.disclosure} aria-expanded={mine} onClick={() => setMine(!mine)}>
        <Icon name={mine ? 'chevronDown' : 'chevronRight'} size={10} />
        {mine ? 'Let Claude write the title and goal' : 'Write title and goal myself'}
      </button>
      {pickProject ? (
        <Field label="Project">
          <Popup label="Project" value={project} options={projects.map((p) => ({ value: p.id, label: p.name }))} onChange={setProject} />
        </Field>
      ) : null}
      <Field label="Priority">
        <PriorityScale value={priority} onChange={setPriority} />
      </Field>
      {/* Alone on a project, every task is yours and your Claude's: nothing to choose. */}
      {solo ? null : (
        <Field label="Assignee">
          <Popup label="Assignee" value={assignee} options={[{ value: '', label: 'No one' }, ...choices.map((c) => ({ value: c.key, label: c.label }))]} onChange={setAssignee} />
        </Field>
      )}
    </FormSheet>
  );
}

/** The describe box grows with what you write (up to a point; then it scrolls). */
function grow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
}

/** None · Low · Medium · High · Urgent in one click; on the scale, 0 to 4 and the arrows pick. */
function PriorityScale({ value, onChange }: { value: Priority; onChange: (p: Priority) => void }) {
  const at = SCALE.indexOf(value);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const digit = /^[0-4]$/.test(e.key) ? Number(e.key) : undefined;
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const next = digit ?? (step ? Math.max(0, Math.min(SCALE.length - 1, at + step)) : undefined);
    if (next === undefined) return;
    e.preventDefault();
    onChange(SCALE[next]!);
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className={n.scale} role="radiogroup" aria-label="Priority" onKeyDown={onKeyDown}>
      {SCALE.map((p, i) => (
        <button key={p} type="button" role="radio" aria-checked={p === value} tabIndex={p === value ? 0 : -1} className={cx(n.step, p === value && n.stepOn)} title={`${PRIORITY_INFO[p].label} (${i})`} onClick={() => onChange(p)}>
          <PriorityIcon priority={p} size={12} />
          {p === 'none' ? 'None' : PRIORITY_INFO[p].label}
        </button>
      ))}
    </div>
  );
}
