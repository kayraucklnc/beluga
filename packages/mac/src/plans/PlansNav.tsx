import type { Plan } from '@klaud/core/plans/model.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/klaud.js';
import { Row } from '../layout/sidebar-parts.js';
import { DotMark } from '../layout/signal-marks.js';
import { projectOfView } from '../tasks/use-tasks.js';
import { nextWords, planStatus, titleOf } from './plans-model.js';
import { usePlanActions, usePlanView } from './use-plans.js';
import n from './PlansNav.module.css';

/**
 * The sidebar's Plans row, and under it each plan that's running: how far it got, a pulse while
 * Claude works on its tasks, a dot when it waits for you. Plans opens on the project you're in.
 */
export function PlansNav() {
  const actions = useActions();
  const enabled = useApp((s) => s.plans.enabled);
  const view = useApp((s) => s.view);
  const here = useApp(projectOfView);
  const plans = useApp((s) => s.plans.plans);
  const running = plans.filter((x) => x.status === 'active').sort((a, b) => (b.approvedAt ?? b.createdAt) - (a.approvedAt ?? a.createdAt));
  if (!enabled) return null;
  const shown = view.kind === 'plan' && running.some((x) => x.id === view.id);
  return (
    <>
      <Row
        icon={<Icon name="flag" size={14} />}
        label="Plans"
        detail={running.length ? `${running.length} running` : 'Big work, planned with Claude'}
        selected={view.kind === 'plans' || (view.kind === 'plan' && !shown)}
        onClick={() => actions.run({ type: 'view', view: { kind: 'plans', ...(here ? { projectId: here } : {}) } })}
      />
      {running.map((plan) => (
        <PlanSideRow key={plan.id} plan={plan} indent={1} />
      ))}
    </>
  );
}

/** How far a plan got, as a small ring (finished tasks of all). */
export function ProgressRing({ share, live }: { share: number; live?: boolean }) {
  const r = 5;
  const around = 2 * Math.PI * r;
  return (
    <svg className={cx(n.ring, live && n.ringLive)} width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
      <circle className={n.ringTrack} cx={7} cy={7} r={r} />
      <circle className={n.ringFill} cx={7} cy={7} r={r} strokeDasharray={around} strokeDashoffset={around * (1 - Math.min(1, Math.max(0, share)))} transform="rotate(-90 7 7)" />
    </svg>
  );
}

/**
 * One plan as a sidebar row: its name, a progress ring (in Claude’s color while tasks run), and a dot when it
 * needs you (why, in the tooltip). Clicking opens the plan. Used under Plans, and under a project.
 */
function PlanSideRow({ plan, indent = 0 }: { plan: Plan; indent?: number }) {
  const view = usePlanView(plan)!;
  const { open } = usePlanActions();
  const selected = useApp((s) => s.view.kind === 'plan' && s.view.id === plan.id);
  const title = titleOf(plan);
  const status = planStatus(view);
  const needs = status.tone === 'accent' || status.tone === 'error';
  const working = view.active.some((t) => t.state === 'running');
  const next = nextWords(view.next);
  const why = next.detail ? `${next.title}: ${next.detail}` : next.title;
  const tip = `${title}: ${needs ? why : status.label} · ${view.done} of ${view.total} tasks done`;
  return (
    <Row
      indent={indent}
      selected={selected}
      aria-label={title}
      data-plan-row={plan.id}
      data-needs={needs || undefined}
      data-working={working || undefined}
      icon={<ProgressRing share={view.total ? view.done / view.total : 0} live={working} />}
      label={title}
      detail={tip}
      onClick={() => open(plan.id)}
      trailing={needs ? <DotMark tone={status.tone === 'error' ? 'error' : 'warn'} signal="needs" /> : working ? <DotMark tone="claude" live signal="working" /> : null}
    />
  );
}
