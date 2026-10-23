import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CcStep } from '@beluga/core/claude-code/model.js';
import type { StepSummary } from '@beluga/shared/steps.js';
import { Markdown } from '../chat/Markdown.js';
import { StepRow } from '../chat/steps/StepRow.js';
import { type Disclosure, useDisclosure } from '../chat/steps/step-memory.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, Working, cx } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import { useClock } from '../lib/window-active.js';
import { useSteps } from './use-steps.js';
import s from './claude-code.module.css';

/**
 * A Claude Code transcript, live and read-only: messages, Claude's words (Markdown) and its tool
 * calls summarised in runs. It follows new steps while you're at the bottom and stays put once
 * you scroll up (with a way back down).
 */

const time = (ts: number): string => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

type Block = { kind: 'tools'; steps: CcStep[] } | { kind: 'one'; step: CcStep };

/** Tool calls and thinking in a row go in one quiet box; everything else stands alone. */
function blocks(steps: readonly CcStep[]): Block[] {
  const out: Block[] = [];
  const quiet = (st: CcStep): boolean => st.kind === 'tool' || st.kind === 'thinking';
  for (const step of steps) {
    const last = out.at(-1);
    if (quiet(step) && last?.kind === 'tools') last.steps.push(step);
    else out.push(quiet(step) ? { kind: 'tools', steps: [step] } : { kind: 'one', step });
  }
  return out;
}

/** A transcript step as the step rows draw it (the same rows as Claude's cards in a chat). */
const summaryOf = (step: CcStep): StepSummary => ({
  id: String(step.seq),
  kind: step.kind === 'thinking' ? 'thinking' : 'tool',
  title: step.text,
  status: step.status ?? 'done',
  startedAt: step.ts,
  ...(step.tool ? { tool: step.tool } : {}),
  ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
  ...(step.hidden ? { hidden: true } : {}),
});

/** A tool call or thinking: opens to show what ran and what came back (`claudeCode.step`). */
const ToolRow = memo(function ToolRow({ step, live, sessionId, agentId, open, now }: { step: CcStep; live: boolean; sessionId: string; agentId?: string; open: Disclosure; now: number }) {
  const api = useApi();
  const id = String(step.seq);
  return (
    <div className={cx(s.tool, s.toolRich, step.status === 'error' && s.toolError)} title={`${step.tool ?? ''} · ${time(step.ts)}`}>
      <StepRow step={summaryOf(step)} open={open.isOpen(id)} onToggle={() => open.toggle(id)} load={() => api.claudeCode.step(sessionId, agentId, step.seq)} live={live} now={now} openable={step.detail === true} />
    </div>
  );
});

/**
 * A message another session sent this one (SendMessage): from the lead session, another agent,
 * or an agent's report handed back. A row of its own; opens to the whole message.
 */
const MessageStep = memo(function MessageStep({ step, open }: { step: CcStep; open: Disclosure }) {
  const id = `msg:${step.seq}`;
  const isOpen = open.isOpen(id);
  const title = `${step.report ? 'Report' : 'Message'} from ${step.who ?? step.from ?? 'another session'}`;
  const preview = step.text.split('\n').find((l) => l.trim()) ?? '';
  return (
    <div className={cx(s.message, isOpen && s.messageOpen)} data-received-message={step.report ? 'report' : 'message'}>
      <button type="button" className={s.messageHead} aria-expanded={isOpen} onClick={() => open.toggle(id)}>
        <span className={cx(s.messageChev, isOpen && s.messageChevOpen)}>
          <Icon name="chevronRight" size={9} />
        </span>
        <Icon name={step.report ? 'inbox' : 'chat'} size={12} />
        <span className={s.messageWho}>{title}</span>
        {isOpen ? null : <span className={s.messagePreview}>{preview}</span>}
        <span className={s.when}>{time(step.ts)}</span>
      </button>
      {isOpen ? (
        <div className={s.messageBody}>
          <Markdown text={step.text} localImages />
        </div>
      ) : null}
    </div>
  );
});

const StepView = memo(function StepView({ step, who }: { step: CcStep; who: 'session' | 'agent' }) {
  if (step.kind === 'note') {
    return (
      <div className={s.note}>
        <Icon name="spark" size={11} />
        <span className="selectable">{step.text}</span>
      </div>
    );
  }
  const user = step.kind === 'user';
  return (
    <div className={cx(s.turn, user && s.turnUser)}>
      <div className={s.turnHead}>
        {user ? <span className={s.who}>{who === 'agent' ? 'Task' : 'You'}</span> : <span className={cx(s.who, s.whoClaude)}>Claude</span>}
        <span className={s.when}>{time(step.ts)}</span>
      </div>
      <div className={s.turnBody}>
        <Markdown text={step.text} localImages />
      </div>
    </div>
  );
});

export function LiveTranscript({ sessionId, agentId, version, live, label }: { sessionId: string; agentId?: string; version: string; live: boolean; label: string }) {
  const { steps, more, missing, loading, error, loadEarlier } = useSteps(sessionId, agentId, version);
  const open = useDisclosure(`cc:${sessionId}/${agentId ?? ''}`);
  const now = useClock(live);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const lastSeq = steps.at(-1)?.seq ?? 0;
  const [unseen, setUnseen] = useState(0);
  const seenSeq = useRef(0);
  /** Earlier steps coming in above: keep what you're reading where it is. */
  const fromBottom = useRef<number | undefined>(undefined);
  const firstSeq = steps[0]?.seq ?? 0;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || fromBottom.current === undefined) return;
    el.scrollTop = el.scrollHeight - fromBottom.current;
    fromBottom.current = undefined;
  }, [firstSeq]);

  // New steps: follow them if you're at the bottom; else count them for the "new steps" button.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) {
      el.scrollTop = el.scrollHeight;
      seenSeq.current = lastSeq;
      setUnseen(0);
    } else setUnseen(steps.filter((x) => x.seq > seenSeq.current).length);
  }, [lastSeq, steps]);

  // Another transcript: start at its bottom.
  useEffect(() => {
    stick.current = true;
    setAway(false);
  }, [sessionId, agentId]);

  const onScroll = (): void => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = atBottom;
    setAway(!atBottom);
    if (atBottom) {
      seenSeq.current = lastSeq;
      setUnseen(0);
    }
  };
  const toBottom = (): void => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const who = agentId ? 'agent' : 'session';
  return (
    <div className={s.transcriptWrap}>
      <div ref={scroller} className={s.transcript} onScroll={onScroll} role="log" aria-label={label} aria-live="off">
        <div className={s.transcriptInner}>
          {more ? (
            <button
              type="button"
              className={s.earlier}
              onClick={() => {
                const el = scroller.current;
                if (el) fromBottom.current = el.scrollHeight - el.scrollTop;
                loadEarlier();
              }}
            >
              Show earlier steps
            </button>
          ) : steps.length ? (
            <div className={s.earliest}>Beluga shows the newest part of this transcript</div>
          ) : null}
          {blocks(steps).map((b) =>
            b.kind === 'tools' ? (
              <div key={b.steps[0]!.seq} className={s.tools}>
                {b.steps.map((step) => (
                  <ToolRow key={step.seq} step={step} live={live} sessionId={sessionId} {...(agentId ? { agentId } : {})} open={open} now={now} />
                ))}
              </div>
            ) : b.step.kind === 'message' ? (
              <MessageStep key={b.step.seq} step={b.step} open={open} />
            ) : (
              <StepView key={b.step.seq} step={b.step} who={who} />
            ),
          )}
          {live ? (
            <div className={s.workingRow}>
              <Avatar name="Claude" id="claude-code" claude size={18} />
              <Working />
            </div>
          ) : null}
          {!steps.length && !loading ? <div className={s.quiet}>{missing ? 'Beluga isn’t watching this one any more (it went quiet).' : error ? `Couldn’t read it: ${error}` : 'Nothing written yet.'}</div> : null}
        </div>
      </div>
      {away ? (
        <div className={s.jump}>
          <Button size="small" icon="chevronDown" onClick={toBottom}>
            {unseen ? `${unseen} new step${unseen === 1 ? '' : 's'}` : 'Latest'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
