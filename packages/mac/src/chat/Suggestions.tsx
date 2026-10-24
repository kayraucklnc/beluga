import { Fragment, type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import type { Suggestion } from '@beluga/ui/suggest.js';
import { type IssueStatus, STATUS_INFO } from '@beluga/core/board/model.js';
import { cx } from '../components/ui.js';
import { StatusIcon } from '../tasks/marks.js';
import s from './composer.module.css';

/** Suggestions listed under / and @ at most. */
const MAX_LISTED = 50;

/**
 * The list above a message box as you type / or @ (the worktree chat's and a channel's): the
 * arrows move the highlight, Tab or Return picks, Escape hides it until the words change.
 * `reset` after the words change; `onKeyDown` says whether it took the key.
 */
export function useSuggestions<T extends Suggestion>(items: readonly T[], text: string, accept: (sug: T) => void): { shown: readonly T[]; reset: () => void; onKeyDown: (e: KeyboardEvent) => boolean; list: ReactNode } {
  const [selected, setSelected] = useState(0);
  const [hidden, setHidden] = useState(false);
  const shown = hidden ? [] : items;
  /** Only the first 50 are listed, so the arrows move within those. */
  const listed = Math.min(shown.length, MAX_LISTED);
  const pick = Math.min(selected, Math.max(0, listed - 1));
  const ref = useRef<HTMLDivElement>(null);
  /** The arrow keys moved the highlight (the pointer hovering an item doesn't scroll the list). */
  const byKeys = useRef(false);
  // The highlighted item stays in view as the arrows move it through a long list.
  useLayoutEffect(() => {
    if (!byKeys.current) return;
    ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [pick, listed]);
  const reset = (): void => {
    setHidden(false);
    setSelected(0);
  };
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!listed) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      byKeys.current = true;
      setSelected((n) => (Math.min(n, listed - 1) + (e.key === 'ArrowDown' ? 1 : -1) + listed) % listed);
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && shown[pick]?.value !== text)) accept(shown[pick]!);
    else if (e.key === 'Escape') setHidden(true);
    else return false;
    e.preventDefault();
    return true;
  };
  const list = listed ? (
    <div ref={ref} className={s.suggestions} role="listbox" aria-label="Suggestions">
      {shown.slice(0, MAX_LISTED).map((sug, i, all) => (
        <Fragment key={`${sug.value}:${sug.label}:${i}`}>
          {/* Tasks ("@BLG-24") come as their own section, under a heading. */}
          {sug.task && !all[i - 1]?.task ? (
            <div className={s.sugSection} role="presentation">
              Tasks
            </div>
          ) : null}
          <div
            role="option"
            aria-selected={i === pick}
            className={cx(s.suggestion, sug.task && s.sugTask, i === pick && s.suggestionOn)}
            onMouseEnter={() => {
              byKeys.current = false;
              setSelected(i);
            }}
            onMouseDown={(e) => (e.preventDefault(), accept(sug))}
          >
            {sug.task ? <TaskOption task={sug.task} /> : (
              <>
                <span className={s.sugLabel}>{sug.label}</span>
                <span className={s.sugHint}>{sug.hint}</span>
              </>
            )}
          </div>
        </Fragment>
      ))}
    </div>
  ) : null;
  return { shown, reset, onKeyDown, list };
}

/** A task in the list: its status ring, key and title, and its status in words at the end. */
function TaskOption({ task }: { task: NonNullable<Suggestion['task']> }) {
  const status = STATUS_INFO[task.status as IssueStatus];
  return (
    <>
      {status ? <StatusIcon status={task.status as IssueStatus} size={12} /> : null}
      <span className={s.sugKey}>{task.key}</span>
      <span className={s.sugTitle}>{task.title}</span>
      {status ? <span className={s.sugStatus}>{status.label}</span> : null}
    </>
  );
}
