import * as Tooltip from '@radix-ui/react-tooltip';
import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from 'react';
import { Icon, type IconName } from './Icon.js';
import s from './ui.module.css';

const cx = (...c: Array<string | false | undefined | null>): string => c.filter(Boolean).join(' ');
export { cx };

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'plain' | 'primary' | 'quiet' | 'danger' | 'merge';
  readonly size?: 'small' | 'regular';
  readonly icon?: IconName;
  readonly tone?: 'error' | 'ok' | 'info';
};

/** A push button. `quiet`: toolbar style, no fill until hovered. */
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = 'plain', size = 'regular', icon, tone, className, children, ...rest }, ref) {
  return (
    <button ref={ref} type="button" className={cx(s.button, s[variant], size === 'small' && s.small, tone && s[`tone_${tone}`], className)} {...rest}>
      {icon ? <Icon name={icon} size={size === 'small' ? 13 : 14} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
});

/** A hint shown on hover (and on keyboard focus), with an optional shortcut. */
export function Tip({ label, keys, side = 'bottom', children }: { label: ReactNode; keys?: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactNode }) {
  return (
    <Tooltip.Root delayDuration={450}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side={side} sideOffset={6} className={s.tip}>
          {label}
          {keys ? <kbd className={s.tipKeys}>{keys}</kbd> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** A square icon button for toolbars, with its tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { readonly icon: IconName; readonly label: string; readonly keys?: string; readonly active?: boolean; readonly badge?: number }>(
  function IconButton({ icon, label, keys, active, badge, className, ...rest }, ref) {
    return (
      <Tip label={label} keys={keys}>
        <button ref={ref} type="button" aria-label={label} aria-pressed={active} className={cx(s.iconButton, active && s.iconActive, className)} {...rest}>
          <Icon name={icon} />
          {badge ? <span className={s.iconBadge}>{badge > 99 ? '99+' : badge}</span> : null}
        </button>
      </Tip>
    );
  },
);

/**
 * A row of mutually exclusive choices (like NSSegmentedControl). `iconOnly` (a narrow window):
 * just the icons, each named in its tooltip.
 */
export function Segmented<T extends string>({ value, options, onChange, label, iconOnly }: { value: T; options: ReadonlyArray<{ value: T; label: string; hint?: string; icon?: IconName; keys?: string }>; onChange: (v: T) => void; label: string; iconOnly?: boolean }) {
  return (
    <div className={s.segmented} role="tablist" aria-label={label}>
      {options.map((o) => {
        const bare = iconOnly && o.icon;
        return (
          <Tip key={o.value} label={bare ? `${o.label}${o.hint ? ` · ${o.hint}` : ''}` : (o.hint ?? o.label)} {...(o.keys ? { keys: o.keys } : {})}>
            <button type="button" role="tab" aria-label={bare ? o.label : undefined} aria-selected={o.value === value} className={cx(s.segment, o.value === value && s.segmentOn, bare && s.segmentIcon)} onClick={() => onChange(o.value)}>
              {o.icon ? <Icon name={o.icon} size={13} /> : null}
              {bare ? null : o.label}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** A small count (unread, waiting). `urgent` uses the accent. */
export function Badge({ count, urgent }: { count: number; urgent?: boolean }) {
  if (!count) return null;
  return <span className={cx(s.badge, urgent && s.badgeUrgent)}>{count > 99 ? '99+' : count}</span>;
}

/** A status dot. `live` pulses softly (Claude is working). */
export function Dot({ tone, live }: { tone: 'ok' | 'warn' | 'error' | 'info' | 'claude' | 'muted'; live?: boolean }) {
  return <span className={cx(s.dot, s[`dot_${tone}`], live && s.live)} aria-hidden="true" />;
}

const PEOPLE = ['#5b8def', '#3fa776', '#a46ed0', '#d39a2c', '#2fa4a0', '#7f72e6', '#b98a5e', '#5f9ad6'];
/** A steady color per person (FNV-1a over their id). */
export const personColor = (id: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return PEOPLE[h % PEOPLE.length]!;
};

/** A person's initial in their color; Claude gets its mark (the klaud prompt). */
export function Avatar({ name, id, claude, size = 22 }: { name: string; id: string; claude?: boolean; size?: number }) {
  return (
    <span className={cx(s.avatar, claude && s.avatarClaude)} style={{ width: size, height: size, fontSize: size * 0.46, ...(claude ? {} : { background: personColor(id) }) }} aria-hidden="true">
      {claude ? <Icon name="claude" size={size * 0.6} /> : (name[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}

/** What to do when there's nothing here yet: one line saying what this is, and the action that fills it. */
export function Empty({ icon, title, detail, action }: { icon: IconName; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className={s.empty}>
      <Icon name={icon} size={22} />
      <div className={s.emptyTitle}>{title}</div>
      {detail ? <div className={s.emptyDetail}>{detail}</div> : null}
      {action}
    </div>
  );
}

/** The one to three buttons under an empty state (the first is the default). */
export function EmptyActions({ children }: { children: ReactNode }) {
  return <div className={s.emptyActions}>{children}</div>;
}

/** Claude is thinking: three soft dots. */
export function Working() {
  return (
    <span className={s.working} aria-label="working">
      <i />
      <i />
      <i />
    </span>
  );
}
