import { memo, useEffect, useMemo, useState } from 'react';
import type { LogItem, SubAgent } from '@klaud/core/store.js';
import type { TaskView } from '@klaud/core/gateway/model.js';
import { isFinal } from '@klaud/core/gateway/model.js';
import type { StepSummary } from '@klaud/shared/steps.js';
import { humanizeLine } from '@klaud/shared/step-titles.js';
import { formatDuration } from '@klaud/shared/text.js';
import { DONE_STEPS, HIDDEN_STEPS } from '@klaud/ui/format.js';
import { Icon } from '../../components/Icon.js';
import { Avatar, Button, Dot, cx } from '../../components/ui.js';
import { toast, useApi, useApp, useKlaud } from '../../lib/klaud.js';
import { usePrefs } from '../../lib/prefs.js';
import { useDisclosure } from './step-memory.js';
import { StepRow, usePersonId } from './StepRow.js';
import { useAgentSteps } from './use-steps.js';
import { waitState, waitTone, waitedLabel, waitingFor } from './waiting.js';
import c from '../chat.module.css';
import s from './steps.module.css';

type AgentItem = Extract<LogItem, { type: 'agent' }>;

/** Tools that start a sub-agent: their step is the sub-agent's row. */
const LAUNCH = new Set(['Task', 'Agent']);
/** Finished steps shown below the "3 steps · 12s" line (the rest fold into it). */
const RECENT_LIVE = 2;

function useTick(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** A one-line step (someone else's Claude, or a card from before details were kept) as a row. */
function lineStep(line: string, i: number, at: number, live: boolean): StepSummary {
  const h = humanizeLine(line);
  return { id: `line-${i}`, kind: 'tool', title: line, label: h.done, doing: h.doing, status: live ? 'running' : 'done', startedAt: at, ...(h.person ? { person: h.person } : {}), ...(h.task ? { task: h.task } : {}), ...(h.wait ? { wait: true } : {}) };
}

/** A record kept before steps had words (or from an older klaud): its words from its line. */
function withWords(step: StepSummary): StepSummary {
  if (step.label || step.kind !== 'tool') return step;
  const h = humanizeLine(step.title);
  return { ...step, label: h.done, doing: h.doing, ...(h.person ? { person: h.person } : {}), ...(h.task ? { task: h.task } : {}), ...(h.wait ? { wait: true } : {}) };
}

/** "3 steps · 12s": how long a stretch of steps took, when their times are known. */
function spanOf(steps: readonly StepSummary[]): string | undefined {
  const first = steps[0];
  const last = steps.at(-1);
  if (!first || !last || first.id.startsWith('line-')) return undefined;
  const end = last.endedAt ?? (last.durationMs !== undefined ? last.startedAt + last.durationMs : undefined);
  return end !== undefined && end > first.startedAt ? formatDuration(end - first.startedAt) : undefined;
}

/**
 * What Claude did on a card, and what it's doing now. While it works: a quiet progress line
 * under the header, the step it's on as the prominent live line (or a waiting row with the
 * friend it waits on), the last finished steps above it, and older ones folded into
 * "5 steps · 12s". Every step is said in words ("Ran npm test", "Asked bob's Claude: …"), never
 * a tool's name or an id; your own Claude's steps open to show what ran and what came back.
 */
export const AgentSteps = memo(function AgentSteps({ item, running }: { item: AgentItem; running: boolean }) {
  const prefs = usePrefs();
  const selfId = useApp((st) => st.selfId);
  const detail = useApp((st) => st.prefs.subagents);
  const tasks = useApp((st) => st.gateway.tasks);
  const mine = item.owner === selfId;
  const change = `${item.status}:${item.steps.length}:${item.steps.at(-1) ?? ''}:${item.subagents.map((x) => `${x.steps.length}${x.status}`).join(',')}`;
  const { steps: rich } = useAgentSteps(item.channel, item.id, running, change, mine);
  const now = useTick(running);
  const open = useDisclosure(`${item.channel}/${item.id}`);
  const [earlier, setEarlier] = useState(false);
  const api = useApi();
  const subIds = useMemo(() => new Set(item.subagents.map((x) => x.id)), [item.subagents]);
  const richOnes = Boolean(rich?.length);
  // The main thread's steps: your own Claude's records, else its one-line steps in words.
  const rows = useMemo<StepSummary[]>(() => {
    if (rich?.length) return rich.filter((x) => !x.parent && !(x.tool && LAUNCH.has(x.tool) && subIds.has(x.id)) && !HIDDEN_STEPS.test(x.title)).map(withWords);
    const lines = item.steps.filter((x) => !HIDDEN_STEPS.test(x));
    return lines.map((line, i) => lineStep(line, i, item.ts, running && i === lines.length - 1));
  }, [rich, subIds, item.steps, item.ts, running]);
  const working = running && !item.text;
  const showSteps = prefs.steps === 'all' || running;
  if (!showSteps && !working) return null;

  // The step Claude is on: the last one, while it runs.
  const lastRow = rows.at(-1);
  const current = working && lastRow?.status === 'running' ? lastRow : undefined;
  const finished = current ? rows.slice(0, -1) : rows;
  const keep = running ? RECENT_LIVE : DONE_STEPS;
  const fold = !earlier && !open.all && finished.length > keep + 1;
  const older = fold ? finished.slice(0, finished.length - keep) : [];
  const recent = fold ? finished.slice(-keep) : finished;
  const taskOf = (step: StepSummary): TaskView | undefined => (step.task ? tasks.find((t) => t.id === step.task) : undefined);
  const load = (id: string) => () => api.agent.step(item.channel, item.id, id);
  const stepsOf = (sub: SubAgent): StepSummary[] => (rich ?? []).filter((x) => x.parent === sub.id);

  const row = (step: StepSummary, isCurrent: boolean) => {
    const task = step.wait ? taskOf(step) : undefined;
    if (isCurrent && step.wait) return <WaitingRow key={step.id} step={step} task={task} now={now} />;
    return (
      <StepRow
        key={step.id}
        step={task && !step.person ? { ...step, person: task.peerName } : step}
        open={open.isOpen(step.id)}
        onToggle={() => open.toggle(step.id)}
        load={load(step.id)}
        live={running}
        now={now}
        openable={richOnes}
        current={isCurrent}
        {...(step.wait && waitedLabel(task) ? { words: waitedLabel(task) } : {})}
      />
    );
  };

  return (
    <>
      {working ? <div className={s.progress} role="progressbar" aria-label="Claude is working" /> : null}
      <div className={s.list} role="list" aria-label="Claude's steps">
        {older.length ? (
          <div className={s.bar}>
            {older.length ? (
              <button type="button" className={s.fold} onClick={() => setEarlier(true)} aria-label={`Show ${older.length} earlier steps`}>
                <span className={s.chev}>
                  <Icon name="chevronRight" size={9} />
                </span>
                <span className={s.foldIcon}>
                  <Icon name="check" size={11} />
                </span>
                {older.length} steps{spanOf(older) ? ` · ${spanOf(older)}` : ''}
              </button>
            ) : null}
          </div>
        ) : null}
        {recent.map((step) => row(step, false))}
        {current ? row(current, true) : working ? <LiveIdle started={rows.length > 0} since={item.ts} /> : null}
        <SubAgents item={item} rich={richOnes} detail={detail} stepsOf={stepsOf} open={open} load={load} live={running} now={now} />
      </div>
    </>
  );
});

/**
 * Expand all / Collapse all for a card's steps (in the card's hover actions, next to Copy).
 * Only your own Claude's steps open, so only its finished cards with steps have it.
 */
export function StepsToggle({ item }: { item: AgentItem }) {
  const open = useDisclosure(`${item.channel}/${item.id}`);
  return (
    <Button size="small" variant="quiet" icon={open.any ? 'chevronUp' : 'chevronDown'} onClick={() => open.setAllOpen(!open.any)}>
      {open.any ? 'Collapse all' : 'Expand all'}
    </Button>
  );
}

/** Between steps (Claude thinking about what to do next), or before the first one. */
function LiveIdle({ started, since }: { started: boolean; since: number }) {
  return (
    <div className={cx(s.row, s.rowCurrent)} data-current="true" data-claude-starting={started ? undefined : 'true'}>
      <div className={cx(s.head, s.headStatic)}>
        <span className={cx(s.chev, s.chevNone)} />
        <span className={cx(s.icon, s.iconThink)}>{started ? <Icon name="bulb" size={12} /> : <Dot tone="claude" live />}</span>
        <span className={s.title}>
          <span className={s.shimmer}>{started ? 'Thinking' : 'Claude is starting'}</span>
        </span>
        <span className={s.end} data-since={since} />
      </div>
    </div>
  );
}

/** Claude waits on a friend's Claude (or Mac): who, where their side is, for how long; Cancel. */
function WaitingRow({ step, task, now }: { step: StepSummary; task: TaskView | undefined; now: number }) {
  const { client } = useKlaud();
  const api = useApi();
  const person = task?.peerName ?? step.person;
  const personId = usePersonId(person);
  const tone = waitTone(task);
  const since = task?.createdAt ?? step.startedAt;
  return (
    <div className={cx(s.waitRow, s[`wait_${tone}`])} data-current="true" data-waiting={task?.state ?? 'unknown'} role="status">
      <span className={s.waitAvatar}>{person ? <Avatar name={person} id={personId} size={22} /> : <Icon name="clock" size={14} />}</span>
      <span className={s.waitText}>
        <span className={s.waitTitle}>{waitingFor(task)}</span>
        <span className={s.waitState}>{task ? waitState(task) : 'Their answer comes back here'}</span>
      </span>
      <span className={s.waitEnd}>
        <span className={s.time}>{formatDuration(Math.max(0, now - since))}</span>
        {task && !isFinal(task.state) ? (
          <button type="button" className={s.waitCancel} onClick={() => void api.gateway.cancel(task.id).catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'))}>
            Cancel
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** Sub-agents and background work: a row each, opening (your own Claude's) to its steps. */
function SubAgents({ item, rich, detail, stepsOf, open, load, live, now }: { item: AgentItem; rich: boolean; detail: string; stepsOf: (sub: SubAgent) => StepSummary[]; open: ReturnType<typeof useDisclosure>; load: (id: string) => () => Promise<import('@klaud/shared/steps.js').StepRecord | undefined>; live: boolean; now: number }) {
  if (!item.subagents.length) return null;
  if (detail === 'hidden') {
    return (
      <div className={c.step}>
        <Icon name="claude" size={11} />
        {item.subagents.length} sub-agent{item.subagents.length === 1 ? '' : 's'}
      </div>
    );
  }
  return (
    <>
      {item.subagents.map((sub) => {
        const own = rich ? stepsOf(sub) : [];
        const key = `sub:${sub.id}`;
        const isOpen = open.isOpen(key);
        const running = sub.status === 'running';
        const canOpen = own.length > 0;
        const head = (
          <>
            {canOpen ? (
              <span className={cx(s.chev, isOpen && s.chevOpen)}>
                <Icon name="chevronRight" size={9} />
              </span>
            ) : null}
            {running ? <Dot tone="claude" live /> : <Icon name={sub.status === 'failed' ? 'x' : 'check'} size={11} className={sub.status === 'failed' ? c.subFailed : c.subDone} />}
            <span className={c.subTitle}>{sub.kind === 'background' ? `Background · ${sub.title}` : sub.title}</span>
            {sub.steps.length ? <span className={c.time}>{sub.steps.length} steps</span> : null}
          </>
        );
        return (
          <div key={sub.id} className={cx(c.sub, s.sub)} data-subagent={sub.id}>
            {canOpen ? (
              <button type="button" className={cx(c.subHead, s.subHead)} aria-expanded={isOpen} onClick={() => open.toggle(key)}>
                {head}
              </button>
            ) : (
              <div className={c.subHead}>{head}</div>
            )}
            {isOpen ? (
              <div className={s.subBody}>
                {own.map((step) => (
                  <StepRow key={step.id} step={step} open={open.isOpen(step.id)} onToggle={() => open.toggle(step.id)} load={load(step.id)} live={live} now={now} />
                ))}
              </div>
            ) : running && detail === 'full' && sub.steps.length ? (
              <div className={cx(c.step, c.subStep, s.subNow)}>
                <span className={s.shimmer}>{humanizeLine(sub.steps.at(-1)!).doing}</span>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
