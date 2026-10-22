import type { Plan } from '@klaud/core/plans/model.js';
import { planOfPlace, planWorktrees } from '@klaud/core/plans/owner.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { Badge } from '../components/ui.js';
import { useApp } from '../lib/klaud.js';
import { ProgressRing } from '../plans/PlansNav.js';
import { nextWords, planStatus, titleOf } from '../plans/plans-model.js';
import { usePlanActions, usePlanView } from '../plans/use-plans.js';
import { signalOf } from './attention-model.js';
import { DotMark, nameClass, signalClass } from './signal-marks.js';
import { Row } from './sidebar-parts.js';
import m from './signal.module.css';

/**
 * A plan under its project: one row for the plan, its conversation and all its task worktrees
 * (they stay off the sidebar). Its name, a small ring of how far it got (breathing while Claude
 * works its tasks), a dot when it waits for you, and a count of what's new, as a chat row has.
 * It stays marked while you're in its conversation or in one of its tasks.
 */
export function PlanRow({ plan, indent }: { plan: Plan; indent: number }) {
  const view = usePlanView(plan)!;
  const { open, openList } = usePlanActions();
  const state = useApp((st) => st);
  const selected = planOfPlace(state.plans, state.board, state.view) === plan.id;
  const title = titleOf(plan);
  const status = planStatus(view);
  // What's new: in its conversation and in its tasks' worktrees (they have no row of their own).
  const home = signalOf(state, plan.home, plan.home.startsWith('ws:') ? plan.home.slice(3) : undefined);
  const tasks = [...planWorktrees(state.plans, state.board)].filter(([, id]) => id === plan.id).map(([ws]) => signalOf(state, `ws:${ws}`, ws));
  const unread = home.unread + tasks.reduce((n, t) => n + t.unread, 0);
  const planNeeds = status.tone === 'accent' || status.tone === 'error';
  const needs = planNeeds || home.level === 'needs';
  const working = view.active.some((t) => t.state === 'running') || home.working;
  const next = nextWords(view.next);
  const why = planNeeds ? (next.detail ? `${next.title}: ${next.detail}` : next.title) : home.level === 'needs' ? home.tip : status.label;
  const tip = [`${title}: ${why}`, view.total ? `${view.done} of ${view.total} tasks done` : '', unread ? `${unread} new message${unread === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  const signal = { level: needs ? 'needs' : unread ? 'unread' : working ? 'working' : 'idle', unread, working, tip } as const;
  const items: ActionItem[] = [
    { label: 'Open Plan', icon: 'chevronRight', onSelect: () => open(plan.id) },
    { label: 'All Plans', separate: true, onSelect: () => openList(plan.projectId) },
  ];
  return (
    <ActionsContext items={items}>
      <Row
        indent={indent}
        selected={selected}
        className={signalClass(signal, selected)}
        aria-label={title}
        data-plan-row={plan.id}
        data-signal-row={signal.level}
        icon={<Icon name="flag" size={14} />}
        label={<span className={nameClass(signal)}>{title}</span>}
        detail={tip}
        onClick={() => open(plan.id)}
        trailing={
          <>
            {unread ? (
              <span className={m.count} data-signal="unread">
                <Badge count={unread} urgent />
              </span>
            ) : null}
            {needs ? <DotMark tone={status.tone === 'error' ? 'error' : 'warn'} signal="needs" /> : null}
            <span className={m.mark} data-signal={working ? 'working' : undefined}>
              <ProgressRing share={view.total ? view.done / view.total : 0} live={working} />
            </span>
          </>
        }
      />
    </ActionsContext>
  );
}
