import type { ReactNode } from 'react';
import { Icon } from './Icon.js';
import { type ActionItem, ActionsDropdown } from './SpecMenu.js';
import { cx } from './ui.js';
import ui from './ui.module.css';
import s from './split-button.module.css';

/**
 * One main action, and who does it (BLG-506): the main part (`children`, a button) does the usual
 * thing with the usual agent; the small ▾ joined to its right opens the same action by another
 * agent ("Start with Codex"), from `items` (useStartWith). The ▾ takes the main button's look
 * (`variant`, `size`), or `caretClassName`'s instead when the main one has a look of its own.
 */
export function SplitButton({ children, items, label, variant = 'primary', size = 'small', disabled, caretClassName }: { children: ReactNode; items: readonly ActionItem[]; label: string; variant?: 'plain' | 'primary'; size?: 'small' | 'regular'; disabled?: boolean; caretClassName?: string }) {
  return (
    <span className={s.split}>
      {children}
      <ActionsDropdown items={items} align="start">
        <button type="button" className={cx(caretClassName ?? cx(ui.button, ui[variant], size === 'small' && ui.small), s.caret)} aria-label={label} title={label} disabled={disabled} data-split-caret>
          <Icon name="chevronDown" size={10} />
        </button>
      </ActionsDropdown>
    </span>
  );
}
