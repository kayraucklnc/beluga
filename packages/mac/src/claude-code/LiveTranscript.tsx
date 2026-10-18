import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CcStep } from '@klaud/core/claude-code/model.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, Dot, Working, cx } from '../components/ui.js';
import { useSteps } from './use-steps.js';
import s from './claude-code.module.css';

/**
 * A Claude Code transcript, live and read-only: messages, Claude's words (Markdown) and its tool
 * calls summarised in runs. It follows new steps while you're at the bottom and stays put once
 * you scroll up (with a way back down).
 */

const time = (ts: number): string => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

type Block = { kind: 'tools'; steps: CcStep[] } | { kind: 'one'; step: CcStep };

/** Tool calls in a row go in one quiet box; everything else stands alone. */
function blocks(steps: readonly CcStep[]): Block[] {
  const out: Block[] = [];
  for (const step of steps) {
    const last = out.at(-1);
    if (step.kind === 'tool' && last?.kind === 'tools') last.steps.push(step);
    else out.push(step.kind === 'tool' ? { kind: 'tools', steps: [step] } : { kind: 'one', step });
  }
  return out;
}

const ToolRow = memo(function ToolRow({ step, live }: { step: CcStep; live: boolean }) {
  const running = step.status === 'running' && live;
  return (
    <div className={cx(s.tool, step.status === 'error' && s.toolError)} title={`${step.tool ?? ''} · ${time(step.ts)}`}>
      <span className={s.toolIcon}>{running ? <Dot tone="claude" live /> : step.status === 'error' ? <Icon name="x" size={10} /> : <Icon name="chevronRight" size={10} />}</span>
      <span className={cx(s.toolText, 'selectable')}>{step.text}</span>
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
        <Markdown text={step.text} />
      </div>
    </div>
  );
});

export function LiveTranscript({ sessionId, agentId, version, live, label }: { sessionId: string; agentId?: string; version: string; live: boolean; label: string }) {
  const { steps, more, missing, loading, error, loadEarlier } = useSteps(sessionId, agentId, version);
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
            <div className={s.earliest}>Klaud shows the newest part of this transcript</div>
          ) : null}
          {blocks(steps).map((b) =>
            b.kind === 'tools' ? (
              <div key={b.steps[0]!.seq} className={s.tools}>
                {b.steps.map((step) => (
                  <ToolRow key={step.seq} step={step} live={live} />
                ))}
              </div>
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
          {!steps.length && !loading ? <div className={s.quiet}>{missing ? 'Klaud isn’t watching this one any more (it went quiet).' : error ? `Couldn’t read it: ${error}` : 'Nothing written yet.'}</div> : null}
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
