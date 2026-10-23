import * as Dialog from '@radix-ui/react-dialog';
import type { ComponentType } from 'react';
import { NATIVE_MENUS, type NativeMenuProps } from './native/index.js';
import { useEffect, useRef, useState } from 'react';
import { menuSpec } from '@beluga/ui/menus.js';
import { Icon } from '../components/Icon.js';
import { Button, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga, useUi } from '../lib/beluga.js';
import { guiHint, paragraphs } from '../lib/gui-copy.js';
import s from './sheet.module.css';

/**
 * Every choice the terminal UI asks with a menu (settings sections, a person, a pull request,
 * invites, confirming an archive…), as a sheet: the same title, words and options, and picking
 * one does exactly what it does there. ↑↓ and Return work. Most menus have their own Mac way
 * instead (dialogs/native); this is for the rest.
 */
export function MenuSheet() {
  const { ui } = useBeluga();
  const actions = useActions();
  const open = useUi((u) => u.menu);
  const state = useApp((st) => st);
  const spec = open ? menuSpec(state, open.menu) : undefined;
  const options = (spec?.options ?? []).map((o, index) => ({ ...o, index })).filter((o) => o.id !== 'close');
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSelected(Math.min(open?.selected ?? 0, Math.max(0, options.length - 1)));
  }, [open, options.length]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  if (!open) return null;
  const close = (): void => ui.patch({ menu: undefined });
  // Drawn the Mac way when there is one (an alert, a form, a popover).
  const Native = NATIVE_MENUS[open.menu.kind] as ComponentType<NativeMenuProps> | undefined;
  if (Native) return <Native menu={open.menu} close={close} />;
  if (!spec) return null;
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
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && options.length) {
              e.preventDefault();
              setSelected((n) => (n + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(selected);
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
              {paragraphs(spec.intro).map((b, i) =>
                b.kind === 'p' ? (
                  <p key={i}>{b.text}</p>
                ) : (
                  <ol key={i}>
                    {b.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ol>
                ),
              )}
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
                {guiHint(o.hint) ? <span className={s.optionHint}>{guiHint(o.hint)}</span> : null}
              </button>
            ))}
          </div>
          <div className={s.footer}>
            <Button onClick={close}>Cancel</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
