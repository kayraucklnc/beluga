import type { CSSProperties } from 'react';
import { LABEL_COLOR_INFO, type LabelDef, labelDef, labelTitle } from '@beluga/core/board/labels.js';
import { type Assignee, type IssueStatus, PRIORITY_INFO, type Priority, STATUS_INFO, labelHue } from '@beluga/core/board/model.js';
import type { IssuePr } from '@beluga/core/board/model.js';
import { Icon, type IconName } from '../components/Icon.js';
import { useApp } from '../lib/beluga.js';
import { Avatar, Tip, cx } from '../components/ui.js';
import t from './tasks.module.css';

/**
 * The small marks tasks are read by, the same everywhere (lists, cards, pages, menus): a status
 * ring that fills as work goes on, priority bars, label chips (an icon in a color), who it's for, a pull request.
 */

/** A ring that fills: dashed for the backlog, empty to do, half in progress, most in review, a tick when done. */
/** `labelled`: it stands alone (no words beside it say the status), so VoiceOver reads it. */
export function StatusIcon({ status, size = 14, labelled }: { status: IssueStatus; size?: number; labelled?: boolean }) {
  const r = 5.25;
  const pie = (fraction: number): string => {
    const a = fraction * Math.PI * 2;
    const x = 7 + 3 * Math.sin(a);
    const y = 7 - 3 * Math.cos(a);
    return `M7 7 L7 4 A3 3 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
  };
  return (
    <svg className={cx(t.status, t[`status_${status}`])} width={size} height={size} viewBox="0 0 14 14" {...(labelled ? { role: 'img', 'aria-label': STATUS_INFO[status].label } : { 'aria-hidden': true })}>
      {status === 'done' || status === 'canceled' ? (
        <>
          <circle cx="7" cy="7" r="6" className={t.statusFill} />
          <path d={status === 'done' ? 'M4.4 7.2l1.8 1.8 3.5-3.7' : 'M5 5l4 4M9 5l-4 4'} className={t.statusMark} />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r={r} className={t.statusRing} strokeDasharray={status === 'backlog' ? '1.6 1.7' : undefined} />
          {status === 'in_progress' ? <path d={pie(0.5)} className={t.statusPie} /> : null}
          {status === 'in_review' ? <path d={pie(0.75)} className={t.statusPie} /> : null}
          {status === 'in_plan' ? <path d={pie(0.9)} className={t.statusPie} /> : null}
        </>
      )}
    </svg>
  );
}

/** Bars like signal strength (urgent: a filled square with "!"); no priority: three faint dots. */
export function PriorityIcon({ priority, size = 14, labelled }: { priority: Priority; size?: number; labelled?: boolean }) {
  const a11y = labelled ? { role: 'img', 'aria-label': PRIORITY_INFO[priority].label } : { 'aria-hidden': true as const };
  if (priority === 'urgent') {
    return (
      <svg className={cx(t.priority, t.priority_urgent)} width={size} height={size} viewBox="0 0 14 14" {...a11y}>
        <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" className={t.urgentBox} />
        <path d="M7 4.2v3.6M7 9.9v.01" className={t.urgentMark} />
      </svg>
    );
  }
  if (priority === 'none') {
    return (
      <svg className={cx(t.priority, t.priority_none)} width={size} height={size} viewBox="0 0 14 14" {...a11y}>
        <path d="M3.5 7h.01M7 7h.01M10.5 7h.01" className={t.noneDots} />
      </svg>
    );
  }
  const on = priority === 'high' ? 3 : priority === 'medium' ? 2 : 1;
  return (
    <svg className={cx(t.priority, t[`priority_${priority}`])} width={size} height={size} viewBox="0 0 14 14" {...a11y}>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2.25 + i * 3.6} y={9.5 - i * 2.6} width="2.4" height={2.5 + i * 2.6} rx="0.8" className={i < on ? t.barOn : t.barOff} />
      ))}
    </svg>
  );
}

/** How a label looks: its icon and color from the project's set, or a plain tag for one that isn't in it. */
function labelLook(def: LabelDef | undefined, label: string): { readonly icon: IconName; readonly style: CSSProperties } {
  if (!def) return { icon: 'tag', style: { ['--hue' as string]: String(labelHue(label)), ['--sat' as string]: '30%' } };
  const c = LABEL_COLOR_INFO[def.color];
  return { icon: def.icon, style: { ['--hue' as string]: String(c.hue), ['--sat' as string]: `${c.sat}%` } };
}

/** A label: its icon in its color, and its name ("Bug"); one outside the set is a plain outlined tag. */
export function LabelChip({ label, projectId, onRemove, iconOnly }: { label: string; projectId: string; onRemove?: () => void; iconOnly?: boolean }) {
  const def = useApp((s) => labelDef(s.board, projectId, label));
  const look = labelLook(def, label);
  const chip = (
    <span className={cx(t.label, def ? t.labelKnown : t.labelOther, iconOnly && t.labelIconOnly)} style={look.style} aria-label={iconOnly ? labelTitle(label) : undefined}>
      <Icon name={look.icon} size={11} className={t.labelIcon} />
      {iconOnly ? null : labelTitle(label)}
      {onRemove ? (
        <button type="button" className={t.labelRemove} aria-label={`Remove ${labelTitle(label)}`} onClick={onRemove}>
          <Icon name="x" size={9} />
        </button>
      ) : null}
    </span>
  );
  return iconOnly ? <Tip label={def?.hint ? `${labelTitle(label)}: ${def.hint}` : labelTitle(label)}>{chip}</Tip> : chip;
}

/** A label's icon in its color alone (menus). */
export function LabelMark({ def, label }: { def: LabelDef | undefined; label: string }) {
  const look = labelLook(def, label);
  return (
    <span className={t.labelMark} style={look.style} aria-hidden="true">
      <Icon name={look.icon} size={13} />
    </span>
  );
}

/** Who a task is for: a person's initial, or their Claude's mark, in their color. */
export function AssigneeMark({ assignee, selfId, size = 18 }: { assignee: Assignee | undefined; selfId: string; size?: number }) {
  if (!assignee) {
    return (
      <Tip label="No one">
        <span className={t.nobody} style={{ width: size, height: size }} aria-label="No one">
          <Icon name="person" size={size * 0.62} />
        </span>
      </Tip>
    );
  }
  const name = assignee.kind === 'person' ? (assignee.id === selfId ? 'You' : assignee.name) : assignee.owner === selfId ? 'Your Claude' : `${assignee.ownerName}’s Claude`;
  return (
    <Tip label={name}>
      <span className={t.assignee} aria-label={name}>
        {assignee.kind === 'person' ? <Avatar name={assignee.name} id={assignee.id} size={size} /> : <Avatar name={assignee.ownerName} id={assignee.owner} claude size={size} />}
      </span>
    </Tip>
  );
}

/** A pull request: its number, colored by where it is (merged, failing checks, changes asked…). */
export function PrChip({ pr }: { pr: IssuePr }) {
  const tone = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.checks === 'failing' || pr.review === 'CHANGES_REQUESTED' ? 'attention' : pr.review === 'APPROVED' ? 'approved' : 'open';
  const words = pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.draft ? 'Draft' : pr.review === 'CHANGES_REQUESTED' ? 'Changes requested' : pr.review === 'APPROVED' ? 'Approved' : pr.checks === 'failing' ? 'Checks failing' : pr.checks === 'pending' ? 'Checks running' : 'Open';
  return (
    <Tip label={`Pull request #${pr.number}: ${words}`}>
      <span className={cx(t.pr, t[`pr_${tone}`])}>
        <Icon name={pr.state === 'MERGED' ? 'merge' : 'pr'} size={11} />#{pr.number}
      </span>
    </Tip>
  );
}
