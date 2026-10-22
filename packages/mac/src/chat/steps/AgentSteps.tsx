import { type ReactNode, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogItem, SubAgent } from '@klaud/core/store.js';
import type { TaskView } from '@klaud/core/gateway/model.js';
import { isFinal } from '@klaud/core/gateway/model.js';
import type { StepRecord, StepSummary } from '@klaud/shared/steps.js';
import { humanizeLine } from '@klaud/shared/step-titles.js';
import { formatDuration } from '@klaud/shared/text.js';
import { DONE_STEPS, HIDDEN_STEPS } from '@klaud/ui/format.js';
import { Icon } from '../../components/Icon.js';
import { Avatar, Button, Dot, cx } from '../../components/ui.js';
import { toast, useApi, useApp, useKlaud } from '../../lib/klaud.js';
import { usePrefs } from '../../lib/prefs.js';
import { useDisclosure } from './step-memory.js';
import { usePresence } from '../../layout/panel/ResizeHandle.js';
import { Shimmer, StepRow, usePersonId } from './StepRow.js';
import { useAgentSteps } from './use-steps.js';
import { useActions } from '../../lib/actions.js';
import { useClock } from '../../lib/window-active.js';
import { keepSameById, sameItems } from '../../lib/stable.js';
import { useLive } from '../../lib/live-motion.js';
import { agentOfToolUse, allSubAgents } from '../../claude-code/subagents-model.js';
import { openSubAgent } from '../../layout/SubAgents.js';
import { waitState, waitTone, waitedLabel, waitingFor } from './waiting.js';
import c from '../chat.module.css';
import s from './steps.module.css';

type AgentItem = Extract<LogItem, { type: 'agent' }>;

/** Tools that start a sub-agent: their step is the sub-agent's row. */
const LAUNCH = new Set(['Task', 'Agent']);
/** Finished steps shown below the "3 steps · 12s" line (the rest fold into it). */
const RECENT_LIVE = 2;
/** How long folding a finished card's steps takes (twice --dur, see .fold). */
const FOLD_MS = 380;

/** The hairline under a working card's header, a soft light travelling along it (moved by the live clock, lib/live-motion.ts). */
function Progress() {
  const line = useRef<HTMLDivElement>(null);
  useLive(line, (t) => {
    // Eased in and out, from just off the left to just off the right, every 1.8s.
    const f = t === null ? 0.5 : (t % 1800) / 1800;
    line.current?.style.setProperty('--travel', `${-100 + 400 * (0.5 - 0.5 * Math.cos(Math.PI * f))}%`);
  });
  return <div ref={line} className={s.progress} role="progressbar" aria-label="Claude is working" />;
}

const NO_TASKS: readonly TaskView[] = [];

/** The clock for a step's row: only a running step's time moves, so only its row is drawn again as the clock ticks. */
const clockFor = (step: StepSummary, live: boolean, now: number): number => (live && step.status === 'running' ? now : 0);

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
  const selfId = useApp((st) => st.selfId);
  const detail = useApp((st) => st.prefs.subagents);
  const mine = item.owner === selfId;
  const change = `${item.status}:${item.steps.length}:${item.steps.at(-1) ?? ''}:${item.subagents.map((x) => `${x.steps.length}${x.status}`).join(',')}`;
  const { steps: rich } = useAgentSteps(item.channel, item.id, running, change, mine);
  const now = useClock(running);
  const open = useDisclosure(`${item.channel}/${item.id}`);
  const [earlier, setEarlier] = useState(false);
  const api = useApi();
  const subIds = useMemo(() => new Set(item.subagents.map((x) => x.id)), [item.subagents]);
  const richOnes = Boolean(rich?.length);
  // The main thread's steps: your own Claude's records, else its one-line steps in words.
  // A step that reads as it did stays the same object, so its row isn't drawn again (KLD-48).
  const before = useRef<readonly StepSummary[]>([]);
  const rows = useMemo<StepSummary[]>(() => {
    const lines = item.steps.filter((x) => !HIDDEN_STEPS.test(x));
    const next = rich?.length
      ? rich.filter((x) => !x.parent && !(x.tool && LAUNCH.has(x.tool) && subIds.has(x.id)) && !HIDDEN_STEPS.test(x.title)).map(withWords)
      : lines.map((line, i) => lineStep(line, i, item.ts, running && i === lines.length - 1));
    return (before.current = keepSameById(before.current, next));
  }, [rich, subIds, item.steps, item.ts, running]);
  const working = running && !item.text;
  // Only the tasks this card's steps wait on: another task changing doesn't draw this card again.
  const asked = rows.flatMap((x) => (x.task ? [x.task] : [])).join(' ');
  const tasks = useApp((st) => (asked ? st.gateway.tasks.filter((t) => asked.split(' ').includes(t.id)) : NO_TASKS), sameItems);
  // The same functions every render and every second, so a step's row (memo) only draws again when it changes.
  const disclosure = useRef(open);
  disclosure.current = open;
  const toggle = useCallback((id: string) => disclosure.current.toggle(id), []);
  const load = useCallback((id: string) => api.agent.step(item.channel, item.id, id), [api, item.channel, item.id]);

  // The step Claude is on: the last one, while it runs.
  const lastRow = rows.at(-1);
  const current = working && lastRow?.status === 'running' ? lastRow : undefined;
  const finished = current ? rows.slice(0, -1) : rows;
  const keep = running ? RECENT_LIVE : DONE_STEPS;
  const fold = !earlier && !open.all && finished.length > keep + 1;
  const older = fold ? finished.slice(0, finished.length - keep) : [];
  const recent = fold ? finished.slice(-keep) : finished;
  const taskOf = (step: StepSummary): TaskView | undefined => (step.task ? tasks.find((t) => t.id === step.task) : undefined);
  const stepsOf = (sub: SubAgent): StepSummary[] => (rich ?? []).filter((x) => x.parent === sub.id);

  const row = (step: StepSummary, isCurrent: boolean) => {
    const task = step.wait ? taskOf(step) : undefined;
    if (isCurrent && step.wait) return <WaitingRow key={step.id} step={step} task={task} now={now} />;
    return (
      <StepRow
        key={step.id}
        step={step}
        person={task?.peerName}
        open={open.isOpen(step.id)}
        onToggle={toggle}
        load={load}
        live={running}
        now={clockFor(step, running, now)}
        openable={richOnes}
        current={isCurrent}
        {...(step.wait && waitedLabel(task) ? { words: waitedLabel(task) } : {})}
      />
    );
  };

  return (
    <>
      {working ? <Progress /> : null}
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
        {/* One keyed list with the step Claude is on: when it finishes it stays the same row
            (no remount, so nothing blinks or restarts) and only changes how it reads. */}
        {[...recent.map((step) => row(step, false)), current ? row(current, true) : working ? <LiveIdle key="idle" started={rows.length > 0} since={item.ts} /> : null]}
        <SubAgents item={item} rich={richOnes} detail={detail} stepsOf={stepsOf} open={open} toggle={toggle} load={load} live={running} now={now} />
      </div>
    </>
  );
});

/**
 * A finished answer's steps, in the card's hover actions (next to Copy). Folded away once Claude
 * answers (Settings › Chat), it shows them again; kept showing, it opens or closes every step.
 */
export function StepsToggle({ item }: { item: AgentItem }) {
  const prefs = usePrefs();
  const open = useDisclosure(`${item.channel}/${item.id}`);
  if (prefs.doneSteps === 'fold') {
    return (
      <Button size="small" variant="quiet" icon={open.shown ? 'chevronUp' : 'chevronDown'} onClick={() => open.setShown(!open.shown)}>
        {open.shown ? 'Hide Steps' : 'Show Steps'}
      </Button>
    );
  }
  return (
    <Button size="small" variant="quiet" icon={open.any ? 'chevronUp' : 'chevronDown'} onClick={() => open.setAllOpen(!open.any)}>
      {open.any ? 'Collapse all' : 'Expand all'}
    </Button>
  );
}

/**
 * Steps that fold away: once Claude has answered, they close (the height and then nothing, so the
 * answer moves up under the name) and leave the chat; Show Steps opens them the same way back.
 */
export function StepsFold({ folded, children }: { folded: boolean; children: ReactNode }) {
  const presence = usePresence(!folded, FOLD_MS);
  const was = useRef(folded);
  const [opening, setOpening] = useState(false);
  useLayoutEffect(() => {
    if (was.current && !folded) setOpening(true);
    if (folded) setOpening(false);
    was.current = folded;
  }, [folded]);
  if (!presence.mounted) return null;
  return (
    <div
      className={s.folding}
      data-folded={folded ? 'true' : undefined}
      data-opening={opening ? 'true' : undefined}
      // Folding away, it's on its way out: not something to tab into.
      inert={folded}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setOpening(false);
      }}
    >
      <div className={s.foldingInner}>{children}</div>
    </div>
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
          <Shimmer>{started ? 'Thinking' : 'Claude is starting'}</Shimmer>
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
/** Follow one of this conversation's sub-agents on its own page (live: thinking, tools, its worktree). */
function WatchAgent({ id }: { id: string }) {
  const { client } = useKlaud();
  const actions = useActions();
  const sessions = useApp((st) => st.claudeCode.sessions);
  // The chat knows a sub-agent by the call that started it (or, in the background, by its agent id).
  const sub = useMemo(() => agentOfToolUse(sessions, id) ?? allSubAgents(sessions).find((x) => x.agent.id === id), [sessions, id]);
  if (!sub) return null;
  return (
    // A span (it sits inside the sub-agent's own toggle button).
    <span
      role="button"
      tabIndex={0}
      className={s.watch}
      aria-label={`Watch ${sub.agent.description} live`}
      onClick={(e) => (e.stopPropagation(), openSubAgent(client, actions, sub))}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        openSubAgent(client, actions, sub);
      }}
    >
      <Icon name="eye" size={11} />
      Watch
    </span>
  );
}

function SubAgents({ item, rich, detail, stepsOf, open, toggle, load, live, now }: { item: AgentItem; rich: boolean; detail: string; stepsOf: (sub: SubAgent) => StepSummary[]; open: ReturnType<typeof useDisclosure>; toggle: (id: string) => void; load: (id: string) => Promise<StepRecord | undefined>; live: boolean; now: number }) {
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
            <WatchAgent id={sub.id} />
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
                  <StepRow key={step.id} step={step} open={open.isOpen(step.id)} onToggle={toggle} load={load} live={live} now={clockFor(step, live, now)} />
                ))}
              </div>
            ) : running && detail === 'full' && sub.steps.length ? (
              <div className={cx(c.step, c.subStep, s.subNow)}>
                <Shimmer>{humanizeLine(sub.steps.at(-1)!).doing}</Shimmer>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
