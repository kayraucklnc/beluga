import * as Popover from '@radix-ui/react-popover';
import { type ButtonHTMLAttributes, type KeyboardEvent, type PointerEvent, type Ref, type RefCallback, useCallback, useId, useMemo, useRef, useState } from 'react';
import { SelectMenu } from './SelectMenu.js';
import { SEARCH_THRESHOLD, flatOptions, typeahead, wantsSearch } from './select-model.js';
import { OptionIcon, type SelectEntry, useTypeahead } from './select-parts.js';
import { cx } from './ui.js';
import s from './select.module.css';

export { SEARCH_THRESHOLD } from './select-model.js';

export type { SelectEntry, SelectOption, SelectSection } from './select-parts.js';

type TriggerProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'children' | 'type' | 'role'>;

export interface SelectProps<T extends string> extends TriggerProps {
  readonly value: T;
  /** Options, and sections of options (`{ section: 'Remote', options: [...] }`). */
  readonly options: readonly SelectEntry<T>[];
  readonly onChange: (value: T) => void;
  /** Names the pop-up button for VoiceOver (and the tests' getByLabel / getByRole('combobox')). */
  readonly label: string;
  /** Shown when the value isn't one of the options. */
  readonly placeholder?: string;
  readonly size?: 'regular' | 'small';
  /** 'fit': as wide as its longest option (like a Mac pop-up button); 'full': the row's width. */
  readonly width?: 'fit' | 'full';
  /** Monospaced (branches, paths). */
  readonly mono?: boolean;
  /** A search field at the top of the menu. Default: on for lists of more than SEARCH_THRESHOLD options. */
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
  readonly ref?: Ref<HTMLButtonElement>;
}

/** Joins refs (yours, a Tip's) onto the button. */
function useMergedRef<E>(...refs: Array<Ref<E> | undefined>): RefCallback<E> {
  return useCallback((node: E | null) => {
    for (const r of refs) {
      if (typeof r === 'function') r(node);
      else if (r) (r as { current: E | null }).current = node;
    }
  }, refs);
}

const isTypeKey = (e: KeyboardEvent): boolean => e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;

/** The up-and-down chevrons of a Mac pop-up button. */
function Chevrons() {
  return (
    <svg className={s.chevrons} width="8" height="11" viewBox="0 0 8 11" aria-hidden="true">
      <path d="M1.2 4 4 1.4 6.8 4M1.2 7 4 9.6 6.8 7" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Beluga's pop-up button: shows the chosen value; opens a menu with a checkmark on it, like a Mac
 * pop-up (the chosen row over the button when it fits). Long lists get a search field. Keys:
 * ↑↓ / Return / Space open it; in it ↑↓ Home End PageUp PageDown move, Return picks, Esc closes,
 * typing jumps to an option (or filters, with the search field). Typing on the closed button
 * picks the matching option, as the native one does.
 */
export function Select<T extends string>(props: SelectProps<T>) {
  const { value, options, onChange, label, placeholder, size = 'regular', width = 'fit', mono, searchable, searchPlaceholder, disabled, className, ref, onKeyDown, onPointerDown, onClick, ...rest } = props;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const merged = useMergedRef(trigger, ref);
  const listId = useId();
  /** Where a press on the button opened the menu: letting go over another row picks it (press-drag-release). */
  const pressed = useRef<{ x: number; y: number } | null>(null);
  const pointerType = useRef('');
  const type = useTypeahead();
  const all = useMemo(() => flatOptions(options), [options]);
  const current = all.find((o) => o.value === value);
  const search = wantsSearch(all.length, searchable);
  const text = current ? (current.short ?? current.label) : (placeholder ?? '');

  // The focus goes back right away (not after the menu's exit), so the next key goes to the button.
  const close = (): void => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const choose = (next: T): void => {
    close();
    if (next !== value) onChange(next);
  };
  const show = (on: boolean): void => {
    if (disabled) return;
    setOpen(on);
  };

  const keyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    onKeyDown?.(e);
    if (e.defaultPrevented || disabled || open) return;
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      pressed.current = null;
      show(true);
    } else if (isTypeKey(e)) {
      // Like the native pop-up: typing on it (closed) picks the option starting with what's typed.
      e.preventDefault();
      const at = typeahead(all, type(e.key), current ? all.indexOf(current) : -1);
      if (at >= 0) choose(all[at]!.value);
    }
  };
  const pointerDown = (e: PointerEvent<HTMLButtonElement>): void => {
    onPointerDown?.(e);
    pointerType.current = e.pointerType;
    // A Mac menu opens on mouse down (and a touch on click, below).
    if (e.defaultPrevented || disabled || e.button !== 0 || e.ctrlKey || e.pointerType !== 'mouse') return;
    e.preventDefault();
    trigger.current?.focus({ preventScroll: true });
    pressed.current = open ? null : { x: e.clientX, y: e.clientY };
    show(!open);
  };

  // Lists of a few options size the button to the longest, so it doesn't jump when the value changes.
  const ghosts = search || all.length > SEARCH_THRESHOLD ? [] : all.map((o) => o.short ?? o.label);
  return (
    <Popover.Root open={open} onOpenChange={show}>
      <Popover.Anchor asChild>
        <button
          {...rest}
          ref={merged}
          type="button"
          role="combobox"
          aria-label={label || undefined}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          data-value={value}
          data-select-trigger=""
          disabled={disabled}
          className={cx(s.trigger, size === 'small' && s.small, width === 'full' && s.full, mono && s.mono, !current && s.placeholder, className)}
          onKeyDown={keyDown}
          onPointerDown={pointerDown}
          onClick={(e) => {
            onClick?.(e);
            // Keyboard clicks (detail 0) are handled on key down; mouse ones on pointer down.
            const byMouse = pointerType.current === 'mouse';
            pointerType.current = '';
            if (e.defaultPrevented || e.detail === 0 || byMouse) return;
            pressed.current = null;
            show(!open);
          }}
        >
          {current?.icon ? (
            <span className={s.triggerIcon}>
              <OptionIcon icon={current.icon} size={size === 'small' ? 12 : 13} />
            </span>
          ) : null}
          <span className={s.value}>
            {ghosts.map((g, i) => (
              <span key={i} className={s.ghost} data-ghost={g} aria-hidden="true" />
            ))}
            <span className={s.valueText} data-select-text="">
              {text}
            </span>
          </span>
          <Chevrons />
        </button>
      </Popover.Anchor>
      <Popover.Portal>
        {open ? <SelectMenu listId={listId} label={label} value={value} options={options} search={search} searchPlaceholder={searchPlaceholder} mono={mono} size={size} trigger={trigger} pressed={pressed} onChoose={choose} onClose={close} /> : null}
      </Popover.Portal>
    </Popover.Root>
  );
}
