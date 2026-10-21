import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import type { Suggestion } from '@klaud/ui/suggest.js';
import { cx } from '../components/ui.js';
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
      {shown.slice(0, MAX_LISTED).map((sug, i) => (
        <div
          key={`${sug.value}:${sug.label}:${i}`}
          role="option"
          aria-selected={i === pick}
          className={cx(s.suggestion, i === pick && s.suggestionOn)}
          onMouseEnter={() => {
            byKeys.current = false;
            setSelected(i);
          }}
          onMouseDown={(e) => (e.preventDefault(), accept(sug))}
        >
          <span className={s.sugLabel}>{sug.label}</span>
          <span className={s.sugHint}>{sug.hint}</span>
        </div>
      ))}
    </div>
  ) : null;
  return { shown, reset, onKeyDown, list };
}
