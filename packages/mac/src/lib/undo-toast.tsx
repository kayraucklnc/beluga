import { useEffect, useSyncExternalStore } from 'react';
import { Icon } from '../components/Icon.js';
import s from './undo-toast.module.css';

/**
 * "Hidden api — Undo": something you did that's easy to take back says so for a few
 * seconds, with Undo (and ⌘Z) instead of an alert asking first.
 */
interface Undoable {
  readonly id: number;
  readonly text: string;
  readonly undo: () => void;
}

const SHOW_MS = 6000;
let current: Undoable | undefined;
let nextId = 1;
const listeners = new Set<() => void>();
const set = (next: Undoable | undefined): void => {
  current = next;
  for (const l of [...listeners]) l();
};

export function showUndo(text: string, undo: () => void): void {
  set({ id: nextId++, text, undo });
}

const editing = (el: Element | null): boolean => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);

export function UndoToast() {
  const toast = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => current,
  );
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => (current?.id === toast.id ? set(undefined) : undefined), SHOW_MS);
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z' || editing(document.activeElement)) return;
      e.preventDefault();
      set(undefined);
      toast.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [toast]);
  if (!toast) return null;
  return (
    <div className={s.wrap} role="status" aria-live="polite">
      <div key={toast.id} className={s.toast}>
        <Icon name="check" size={13} className={s.icon} />
        <span className={s.text}>{toast.text}</span>
        <button
          type="button"
          className={s.undo}
          onClick={() => {
            set(undefined);
            toast.undo();
          }}
        >
          Undo
        </button>
      </div>
    </div>
  );
}
