import type { ReactNode } from 'react';
import { labelTitle, labelsFor } from '@beluga/core/board/labels.js';
import { type Assignee, type Issue, type IssueStatus, ISSUE_STATUSES, PRIORITIES, PRIORITY_INFO, type Priority, STATUS_INFO } from '@beluga/core/board/model.js';
import { Avatar } from '../components/ui.js';
import { Icon } from '../components/Icon.js';
import { openSheet } from '../lib/sheets.js';
import { PickMenu } from './PickMenu.js';
import { LabelMark, PriorityIcon, StatusIcon } from './marks.js';
import { assigneeChoices, assigneeKey } from './tasks-model.js';
import { useBoard, usePeople, useSelf, useTaskActions } from './use-tasks.js';

/**
 * Pickers for a task's properties: the same menus from a row, a card and a task's page. The
 * trigger is yours (an icon in a row, a full property on a page).
 */

export function StatusPicker({ issue, children, align }: { issue: Issue; children: ReactNode; align?: 'start' | 'end' }) {
  const { api, act } = useTaskActions();
  return (
    <PickMenu<IssueStatus>
      label="Status"
      align={align}
      choices={ISSUE_STATUSES.map((s) => ({ value: s, label: STATUS_INFO[s].label, mark: <StatusIcon status={s} /> }))}
      chosen={[issue.status]}
      onPick={(status) => void act(() => api.update(issue.id, { status }))}
    >
      {children}
    </PickMenu>
  );
}

export function PriorityPicker({ issue, children, align }: { issue: Issue; children: ReactNode; align?: 'start' | 'end' }) {
  const { api, act } = useTaskActions();
  return (
    <PickMenu<Priority>
      label="Priority"
      align={align}
      choices={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_INFO[p].label, mark: <PriorityIcon priority={p} /> }))}
      chosen={[issue.priority]}
      onPick={(priority) => void act(() => api.update(issue.id, { priority }))}
    >
      {children}
    </PickMenu>
  );
}

/** Who a task is for: you, a teammate on its project (BLG-299), or no one. */
export function AssigneePicker({ projectId, value, onChange, children, align }: { projectId: string; value: Assignee | undefined; onChange: (a: Assignee | null) => void; children: ReactNode; align?: 'start' | 'end' }) {
  const self = useSelf();
  const people = usePeople(projectId);
  const choices = assigneeChoices(self, people, value);
  return (
    <PickMenu<string>
      label="Assignee"
      align={align}
      search={choices.length > 6}
      placeholder="Assign to…"
      choices={[
        { value: '', label: 'No one', mark: <Icon name="person" size={13} /> },
        ...choices.map((c) => ({
          value: c.key,
          label: c.label,
          section: c.assignee.id === self.id ? undefined : 'Team',
          mark: <Avatar name={c.assignee.name} id={c.assignee.id} size={16} />,
        })),
      ]}
      chosen={[assigneeKey(value)]}
      onPick={(key) => onChange(key ? (choices.find((c) => c.key === key)?.assignee ?? null) : null)}
    >
      {children}
    </PickMenu>
  );
}

/**
 * Labels: tick the ones a task has, from the project's set (each with its icon and color). Typing
 * only finds one; a new label is made on purpose, with New Label…. Labels a task has that aren't in
 * the set (from before, from Linear) show under their own heading so they can be taken off.
 */
export function LabelsPicker({ issue, children, align }: { issue: Issue; children: ReactNode; align?: 'start' | 'end' }) {
  const board = useBoard();
  const { api, act } = useTaskActions();
  const set = labelsFor(board, issue.projectId);
  const others = issue.labels.filter((l) => !set.some((d) => d.name === l));
  const save = (labels: readonly string[]): void => void act(() => api.update(issue.id, { labels: [...labels] }));
  return (
    <PickMenu<string>
      label="Labels"
      align={align}
      multiple
      search={set.length + others.length > 8}
      choices={[
        ...set.map((d) => ({ value: d.name, label: labelTitle(d.name), mark: <LabelMark def={d} label={d.name} />, ...(d.hint ? { hint: d.hint } : {}) })),
        ...others.map((l) => ({ value: l, label: labelTitle(l), section: 'Not in the set', mark: <LabelMark def={undefined} label={l} /> })),
      ]}
      chosen={issue.labels}
      onPick={(l) => save(issue.labels.includes(l) ? issue.labels.filter((x) => x !== l) : [...issue.labels, l])}
      actions={[{ label: 'New Label…', icon: 'plus', onSelect: () => openSheet({ kind: 'new_label', projectId: issue.projectId, issueId: issue.id }) }]}
    >
      {children}
    </PickMenu>
  );
}

/** Pick another task (a parent, a blocker, a related one), by key or words. */
export function TaskPicker({ label, candidates, onPick, children, align }: { label: string; candidates: readonly Issue[]; onPick: (issue: Issue) => void; children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <PickMenu<string>
      label={label}
      align={align}
      search
      placeholder="Find a task…"
      choices={candidates.map((i) => ({ value: i.id, label: `${i.key} ${i.title}`, mark: <StatusIcon status={i.status} /> }))}
      chosen={[]}
      onPick={(id) => {
        const issue = candidates.find((i) => i.id === id);
        if (issue) onPick(issue);
      }}
    >
      {children}
    </PickMenu>
  );
}
