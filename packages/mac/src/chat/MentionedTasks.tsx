import { useMemo } from 'react';
import { findIssue } from '@beluga/core/board/model.js';
import { Tip } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { StatusIcon } from '../tasks/marks.js';
import { useTaskActions } from '../tasks/use-tasks.js';
import { type MentionWorld, tasksIn } from './mentions.js';
import m from './mention.module.css';

/**
 * Above the message box: a soft chip for each task the words name ("@BLG-24"), with its status
 * and title, so you see which task you mean before you send it. A click opens the task.
 */
export function MentionedTasks({ text, world }: { text: string; world: MentionWorld }) {
  const keys = useMemo(() => tasksIn(text, world), [text, world]);
  if (!keys.length) return null;
  return (
    <div className={m.taskRow} aria-label={keys.length === 1 ? 'Task mentioned' : `${keys.length} tasks mentioned`}>
      {keys.map((k) => (
        <MentionedTask key={k} taskKey={k} />
      ))}
    </div>
  );
}

function MentionedTask({ taskKey }: { taskKey: string }) {
  const issue = useApp((st) => findIssue(st.board, taskKey));
  const { open } = useTaskActions();
  if (!issue) return null;
  return (
    <Tip label={`${issue.key}: ${issue.title}. Click to open`}>
      <button type="button" className={m.taskChip} data-testid="mentioned-task" onClick={() => open(issue)}>
        <StatusIcon status={issue.status} size={11} />
        <span className={m.taskKey}>{issue.key}</span>
        <span className={m.taskTitle}>{issue.title}</span>
      </button>
    </Tip>
  );
}
