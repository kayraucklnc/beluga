import * as Dialog from '@radix-ui/react-dialog';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { AppState } from '@klaud/core/store.js';
import { type MenuKind, menuSpec } from '@klaud/ui/menus.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Button, cx } from '../../components/ui.js';
import { tildePath } from '../../lib/brand.js';
import s from './sharing.module.css';

/**
 * The pieces the sharing sheets and popovers are built from: a sheet with a header and a
 * footer, a checkbox, a segmented choice, an alert, and "Copied" feedback.
 */

export interface SheetProps {
  readonly title: string;
  readonly subtitle?: ReactNode;
  /** A glyph in a tinted tile beside the title (the sheet's identity). */
  readonly icon?: IconName;
  /** Replaces the icon tile (an avatar…). */
  readonly badge?: ReactNode;
  readonly close: () => void;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly wide?: boolean;
  /** Return presses this (unless you're in a text box or on a button). */
  readonly onReturn?: () => void;
}

export function Sheet({ title, subtitle, icon, badge, close, footer, children, wide, onReturn }: SheetProps) {
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          className={cx(s.sheet, wide && s.wide)}
          aria-describedby={undefined}
          onKeyDown={(e) => {
            const t = e.target as HTMLElement;
            if (e.key !== 'Enter' || !onReturn || e.metaKey || e.shiftKey || t.closest('button, textarea, select, input[type="text"], [role="radio"], [role="checkbox"]')) return;
            e.preventDefault();
            onReturn();
          }}
        >
          <header className={s.head}>
            {badge ?? (icon ? <span className={s.tile}><Icon name={icon} size={18} /></span> : null)}
            <div className={s.headText}>
              <Dialog.Title className={s.title}>{title}</Dialog.Title>
              {subtitle ? <div className={s.subtitle}>{subtitle}</div> : null}
            </div>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={11} />
            </Dialog.Close>
          </header>
          <div className={s.body}>{children}</div>
          {footer ? <footer className={s.footer}>{footer}</footer> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A labelled part of a sheet: "Invite to", "They can"… */
export function Field({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className={s.field}>
      <label className={s.fieldLabel} htmlFor={htmlFor}>
        {label}
      </label>
      <div className={s.fieldBody}>{children}</div>
    </div>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={s.section}>
      <div className={s.sectionHead}>
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A Mac checkbox with what it means underneath. */
export function Check({ checked, onChange, label, detail }: { checked: boolean; onChange: (v: boolean) => void; label: string; detail?: string }) {
  return (
    <label className={s.check}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={s.checkText}>
        <span>{label}</span>
        {detail ? <span className={s.checkDetail}>{detail}</span> : null}
      </span>
    </label>
  );
}

export interface ChoiceOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: IconName;
}

/** One of a few (a segmented control), as radio buttons: ←→ move between them. */
export function Choice<T extends string>({ value, options, onChange, label, tone, wide }: { value: T; options: ReadonlyArray<ChoiceOption<T>>; onChange: (v: T) => void; label: string; tone?: (v: T) => string | undefined; wide?: boolean }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const at = options.findIndex((o) => o.value === value);
  const move = (d: number): void => {
    const next = options[(at + d + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    refs.current[(at + d + options.length) % options.length]?.focus();
  };
  return (
    <div className={cx(s.choice, wide && s.choiceWide)} role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => void (refs.current[i] = el)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={cx(s.segment, o.value === value && s.segmentOn, o.value === value && tone?.(o.value))}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              move(e.key === 'ArrowRight' ? 1 : -1);
            }
          }}
        >
          {o.icon ? <Icon name={o.icon} size={13} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** "Are you sure?" the Mac way: what happens, Cancel, and the button that does it. */
export function Alert({ title, message, confirm, onConfirm, onCancel }: { title: string; message: string; confirm: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : onCancel())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.alert} role="alertdialog" aria-describedby="native-alert-message">
          <span className={s.alertIcon}>
            <Icon name="alert" size={22} />
          </span>
          <Dialog.Title className={s.alertTitle}>{title}</Dialog.Title>
          <p id="native-alert-message" className={s.alertMessage}>
            {message}
          </p>
          <div className={s.alertButtons}>
            <Button onClick={onCancel} autoFocus>
              Cancel
            </Button>
            <Button variant="danger" className={s.alertDanger} onClick={onConfirm}>
              {confirm}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const COPIED_MS = 1800;

/** Which button just copied (it says "Copied" for a moment). */
export function useFlash(): [string | undefined, (key: string) => void] {
  const [key, setKey] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = (k: string): void => {
    clearTimeout(timer.current);
    setKey(k);
    timer.current = setTimeout(() => setKey(undefined), COPIED_MS);
  };
  return [key, flash];
}

/** The index of an option in a menu's spec (to run it exactly as the terminal UI does), or -1. */
export function optionIndex(state: AppState, menu: MenuKind, id: string): number {
  return menuSpec(state, menu)?.options.findIndex((o) => o.id === id) ?? -1;
}

/** `/Users/kay/x` → `~/x`. */
export const tilde = tildePath;

/** A small pill: "can prompt", "Host", "Guest". */
export function Tag({ children, tone }: { children: ReactNode; tone?: 'accent' | 'claude' | 'warn' | 'muted' }) {
  return <span className={cx(s.tag, tone && s[`tag_${tone}`])}>{children}</span>;
}
