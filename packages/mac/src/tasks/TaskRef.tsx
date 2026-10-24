import { useMemo } from 'react';
import { type Issue, PRIORITY_INFO, STATUS_INFO, findIssue } from '@beluga/core/board/model.js';
import { readTaskKeys } from '@beluga/shared/task-refs.js';
import { Icon } from '../components/Icon.js';
import { Tip } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { TonePill } from '../plans/marks.js';
import { PriorityIcon, StatusIcon } from './marks.js';
import { useTaskActions } from './use-tasks.js';
import r from './task-ref.module.css';

/**
 * Tasks Claude shows in an answer (src/shared/task-refs.ts): `task:BLG-12` as a chip in the
 * sentence, a `beluga-tasks` block as a list of cards. Each reads its task from the live board,
 * so a status that changes changes here too; a click opens the task. A key the board doesn't
 * have (deleted, or someone else's board) is a quiet "not found", never a broken card.
 */

const useIssue = (key: string): Issue | undefined => useApp((s) => findIssue(s.board, key));

const tipOf = (issue: Issue): string => `${issue.key} · ${STATUS_INFO[issue.status].label} · ${PRIORITY_INFO[issue.priority].label}. Click to open`;

function Missing({ taskKey, block }: { taskKey: string; block?: boolean }) {
  return (
    <Tip label={`No task ${taskKey} on this board: deleted, or on someone else's`}>
      <span className={block ? r.missingRow : r.missing}>
        <span className={r.key}>{taskKey}</span>
        <span>not found</span>
      </span>
    </Tip>
  );
}

/** One task inside a sentence: a pill with its status ring, key and title (cut short), and an arrow to open it. */
export function TaskChip({ taskKey }: { taskKey: string }) {
  const issue = useIssue(taskKey);
  const { open } = useTaskActions();
  if (!issue) return <Missing taskKey={taskKey} />;
  return (
    <Tip label={tipOf(issue)}>
      <button type="button" className={r.chip} onClick={() => open(issue)} aria-label={`${issue.key}: ${issue.title}, ${STATUS_INFO[issue.status].label}`}>
        <StatusIcon status={issue.status} size={12} />
        <span className={r.key}>{issue.key}</span>
        <span className={r.chipTitle}>{issue.title}</span>
        <Icon name="arrowRight" size={10} className={r.chipGo} />
      </button>
    </Tip>
  );
}

/** A `beluga-tasks` block: one card per key, stacked. */
export function TaskCards({ code }: { code: string }) {
  const keys = useMemo(() => readTaskKeys(code), [code]);
  if (!keys.length) return null;
  return (
    <div className={r.cards} role="list" aria-label={keys.length === 1 ? 'Task' : `${keys.length} tasks`}>
      {keys.map((k) => (
        <TaskCardRow key={k} taskKey={k} />
      ))}
    </div>
  );
}

function TaskCardRow({ taskKey }: { taskKey: string }) {
  const issue = useIssue(taskKey);
  const { open } = useTaskActions();
  if (!issue) {
    return (
      <div role="listitem">
        <Missing taskKey={taskKey} block />
      </div>
    );
  }
  const status = STATUS_INFO[issue.status];
  return (
    <div role="listitem">
      <button type="button" className={r.card} onClick={() => open(issue)}>
        <StatusIcon status={issue.status} size={14} />
        <span className={r.key}>{issue.key}</span>
        <span className={r.cardTitle}>{issue.title}</span>
        <span className={r.cardEnd}>
          <TonePill tone={status.tone} live={issue.status === 'in_progress'}>
            {status.label}
          </TonePill>
          <PriorityIcon priority={issue.priority} size={14} labelled />
        </span>
      </button>
    </div>
  );
}
