import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { menuSpec } from '@klaud/ui/menus.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useKlaud, useUi } from '../lib/klaud.js';
import s from './sheet.module.css';

/**
 * Every choice the terminal UI asks with a menu (settings sections, a person, a pull request,
 * invites, confirming an archive…), as a sheet: the same title, words and options, and picking
 * one does exactly what it does there. ↑↓ and Return work, and so do the numbers.
 */
export function MenuSheet() {
  const { ui } = useKlaud();
  const actions = useActions();
  const open = useUi((u) => u.menu);
  const state = useApp((st) => st);
  const spec = open ? menuSpec(state, open.menu) : undefined;
  const options = (spec?.options ?? []).map((o, index) => ({ ...o, index })).filter((o) => o.id !== 'close');
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setSelected(Math.min(open?.selected ?? 0, Math.max(0, options.length - 1))), [open]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  if (!open || !spec) return null;
  const close = (): void => ui.patch({ menu: undefined });
  const pick = (i: number): void => {
    const o = options[i];
    if (o) actions.pick(open.menu, o.index);
  };
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          className={s.sheet}
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((n) => (n + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(selected);
            } else if (/^[1-9]$/.test(e.key) && !e.metaKey) {
              const i = Number(e.key) - 1;
              if (i < options.length) pick(i);
            }
          }}
        >
          <div className={s.head}>
            <Dialog.Title className={s.title}>{spec.title}</Dialog.Title>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={12} />
            </Dialog.Close>
          </div>
          {spec.intro.filter(Boolean).length ? (
            <div className={`${s.intro} selectable`}>
              {spec.intro.map((line, i) => (line ? <p key={i}>{line}</p> : <br key={i} />))}
            </div>
          ) : null}
          <div className={s.options} ref={list} role="listbox" aria-label={spec.title}>
            {options.map((o, i) => (
              <button
                key={o.id}
                data-i={i}
                type="button"
                role="option"
                aria-selected={i === selected}
                className={cx(s.option, i === selected && s.optionOn, /delete|remove|leave|revoke|^confirm-delete/.test(o.id) && s.danger)}
                onMouseEnter={() => setSelected(i)}
                onClick={() => pick(i)}
              >
                <span className={s.optionLabel}>{o.label}</span>
                {o.hint && o.hint !== 'Esc' ? <span className={s.optionHint}>{o.hint}</span> : null}
                {i < 9 ? <span className={s.num}>{i + 1}</span> : null}
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
