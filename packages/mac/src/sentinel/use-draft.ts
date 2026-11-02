import { useEffect, useRef, useState } from 'react';

/**
 * A text field that saves as you type (the page has no Save button): what you typed shows at
 * once and is saved when typing pauses (400 ms), when the field loses the focus, and on the way out.
 * A change from elsewhere shows when nothing of yours is waiting.
 */
export function useDraft(value: string, save: (v: string) => void, ms = 400): { readonly text: string; readonly change: (v: string) => void; readonly flush: () => void } {
  const [draft, setDraft] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const saveRef = useRef(save);
  saveRef.current = save;
  const flush = (): void => {
    clearTimeout(timer.current);
    const v = pending.current;
    pending.current = undefined;
    if (v !== undefined) saveRef.current(v);
  };
  useEffect(() => flush, []);
  // Saved (or changed elsewhere): the field shows the value again.
  useEffect(() => {
    if (pending.current === undefined) setDraft(undefined);
  }, [value]);
  return {
    text: draft ?? value,
    change: (v) => {
      setDraft(v);
      pending.current = v;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, ms);
    },
    flush,
  };
}
