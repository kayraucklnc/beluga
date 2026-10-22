import { useMemo, useState } from 'react';
import { actorName } from '@klaud/core/board/model.js';
import type { Plan } from '@klaud/core/plans/model.js';
import { Icon, type IconName } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useApp } from '../lib/klaud.js';
import { ago } from '../tasks/tasks-model.js';
import { ActorMark } from './marks.js';
import { type FeedKind, feedOf } from './plans-model.js';
import p from './plans.module.css';

/**
 * What the plan did, newest first: tasks started and finished, milestones checked, merged and
 * passed, the run mode changed. Repeats fold into one line (“Klaud started 3 tasks: KLD-4, …”).
 */

const KIND_ICON: Record<FeedKind, IconName> = {
  started: 'play',
  finished: 'check',
  checking: 'claude',
  checked: 'check',
  failed: 'x',
  merged: 'merge',
  passed: 'flag',
  mode: 'gauge',
  approved: 'check',
  changed: 'pencil',
  paused: 'stop',
  resumed: 'play',
  done: 'flag',
  problem: 'alert',
};

const SHOWN = 40;

export function PlanFeed({ plan }: { plan: Plan }) {
  const selfId = useApp((s) => s.selfId);
  const items = useMemo(() => feedOf(plan.activity), [plan.activity]);
  const [all, setAll] = useState(false);
  if (!items.length) return <p className={p.muted}>Nothing has happened yet. What the plan does shows here.</p>;
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <>
      <ol className={p.feed} aria-label="What happened">
        {shown.map((e) => (
          <li key={e.id} className={cx(p.feedItem, p[`feed_${e.kind}`])} data-kind={e.kind} title={e.count > 1 ? e.texts.join('\n') : undefined}>
            <ActorMark by={e.by} />
            <span className={p.feedText}>
              <span className={p.feedWho}>{actorName(e.by, selfId)}</span> {e.text}
              {e.count > 1 && e.texts.every((x) => x === e.texts[0]) ? <span className={p.feedCount}> ×{e.count}</span> : null}
            </span>
            <span className={p.feedWhen}>
              <Icon name={KIND_ICON[e.kind]} size={10} />
              {ago(e.at)}
            </span>
          </li>
        ))}
      </ol>
      {!all && items.length > SHOWN ? (
        <button type="button" className={p.feedMore} onClick={() => setAll(true)}>
          Show {items.length - SHOWN} earlier
        </button>
      ) : null}
    </>
  );
}
