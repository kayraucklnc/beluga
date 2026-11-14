import { useEffect, useState } from 'react';
import { type Plan, planForHome, plansOfHome } from '@beluga/core/plans/model.js';
import { Button, Empty } from '../components/ui.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { useBeluga } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { PlanStage } from './PlanStage.js';
import { titleOf } from './plans-model.js';
import { usePlanActions, usePlans } from './use-plans.js';
import c from './chat-plan.module.css';

/** What a chat's agent is asked when you click New Plan: the same words you'd type (its plan_open does the rest). */
export const NEW_PLAN_ASK = 'Turn this conversation into a new plan.';

/**
 * A chat's Plan tab (chatPlans): its current plan, on the Plan page's stage, with Close; once it's
 * closed, New Plan. Its earlier plans (closed or done) open from the list above, read-only.
 */
export function ChatPlanPanel({ channel }: { channel: string }) {
  const state = usePlans();
  const current = planForHome(state, channel);
  const earlier = plansOfHome(state, channel).filter((p) => p.id !== current?.id && (p.closedAt || p.status === 'done'));
  const [reading, setReading] = useState<string>();
  // A new current plan (or another chat): back to it.
  useEffect(() => setReading(undefined), [current?.id, channel]);
  const shown = reading ? earlier.find((p) => p.id === reading) : undefined;
  return (
    <div className={c.panel}>
      <div className={c.bar}>
        {shown ? (
          <>
            <Button size="small" variant="quiet" icon="back" onClick={() => setReading(undefined)}>
              {current ? 'Current Plan' : 'Back'}
            </Button>
            <span className={c.note}>Earlier plan · read-only</span>
          </>
        ) : (
          <span className={c.note}>{current ? 'This chat’s plan' : 'No current plan'}</span>
        )}
        <span className={c.grow} />
        {earlier.length ? (
          <ActionsDropdown items={earlier.map((p) => ({ label: titleOf(p), hint: whenWords(p), checked: p.id === reading, onSelect: () => setReading(p.id) }))}>
            <Button size="small" variant="quiet" icon="clock">
              Earlier Plans ({earlier.length})
            </Button>
          </ActionsDropdown>
        ) : null}
        {current && !shown ? <CloseButton plan={current} /> : null}
      </div>
      <div className={c.stage}>{shown ? <PlanStage key={shown.id} planId={shown.id} readOnly back={false} /> : current ? <PlanStage key={current.id} planId={current.id} back={false} /> : <NoPlan channel={channel} />}</div>
    </div>
  );
}

/** Close the current plan, after a confirm: kept, read-only, among the earlier plans. */
function CloseButton({ plan }: { plan: Plan }) {
  const { api, act } = usePlanActions();
  return (
    <Button
      size="small"
      icon="x"
      onClick={() =>
        openSheet({
          kind: 'confirm',
          title: `Close “${titleOf(plan)}”?`,
          message: 'It stays in this chat as a record you can read but not change. Running tasks finish their turn; no new task starts. Then this chat can open a new plan.',
          confirm: 'Close Plan',
          run: () => void act(() => api.close(plan.id), 'Plan closed'),
        })
      }
    >
      Close Plan
    </Button>
  );
}

/** The chat has no current plan: New Plan asks its agent to turn the conversation into one. */
function NoPlan({ channel }: { channel: string }) {
  const { client } = useBeluga();
  const { act } = usePlanActions();
  return <Empty icon="flag" title="No current plan" detail="Its earlier plans stay above, read-only. A new plan starts from this conversation." action={<Button variant="primary" icon="plus" onClick={() => void act(() => client.api.session.submit(NEW_PLAN_ASK, { channel }))}>New Plan</Button>} />;
}

const whenWords = (p: Plan): string => `${p.closedAt ? 'Closed' : 'Done'} ${new Date(p.closedAt ?? p.updatedAt ?? p.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
