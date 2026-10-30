import { useState } from 'react';
import type { PendingQuestion } from '@beluga/core/collab-store.js';
import { isDecisionQid } from '@beluga/core/plans/decisions.js';
import { answerTyped, currentQuestion } from '@beluga/ui/collab-actions.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon } from '../components/Icon.js';
import { Button, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useBeluga } from '../lib/beluga.js';
import { chosenOf } from './plan-ask-model.js';
import a from '../chat/attention.module.css';
import s from './plan-ask.module.css';

/**
 * In the plan's conversation, above its box: what's asked of you here, answered right here. A
 * task of yours in the plan (a decision: no worktree for it) or the plan's Claude asking: the
 * question, its options (pick one, or several and Done), and your own words instead.
 */
export function PlanAsk({ q }: { q: PendingQuestion }) {
  const actions = useActions();
  const { client } = useBeluga();
  const [own, setOwn] = useState('');
  const current = currentQuestion(q);
  if (!current) return null;
  const decision = isDecisionQid(q.qid);
  const chosen = chosenOf(q, current.question);
  const total = q.question.kind === 'question' ? q.question.questions.length : 1;
  const index = q.question.kind === 'question' ? q.question.questions.indexOf(current) : 0;
  const write = (): void => {
    const text = own.trim();
    if (!text) return;
    setOwn('');
    answerTyped(client, q, text);
  };
  return (
    <div className={cx(a.card, s.card)} role="group" aria-label={decision ? 'Your call' : 'Your agent asks'} data-testid="plan-ask">
      <div className={a.head}>
        <Icon name={decision ? 'hand' : 'claude'} size={13} className={a.claude} />
        <span className={a.title}>{current.header || (decision ? 'Your call' : 'Your agent asks')}</span>
        {total > 1 ? (
          <span className={a.more}>
            {index + 1} of {total}
          </span>
        ) : null}
        {/* A decision of yours waits until you answer it; Claude's question can be skipped. */}
        {decision ? null : (
          <Button size="small" variant="quiet" onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'skip' })}>
            Skip
          </Button>
        )}
      </div>
      <div className={cx(a.question, s.question, 'selectable')}>
        <Markdown text={current.question} />
      </div>
      {current.options.length ? (
        <div className={a.options} role={current.multiSelect ? 'group' : 'radiogroup'} aria-label={current.multiSelect ? 'Pick any' : 'Pick one'}>
          {current.options.map((o, i) => {
            const on = chosen.has(o.label);
            return (
              <button
                key={o.label}
                type="button"
                role={current.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={on}
                className={cx(a.option, on && a.optionOn)}
                onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'option', label: o.label, question: current.question })}
              >
                <span className={a.optionKey}>{current.multiSelect ? <Icon name={on ? 'check' : 'plus'} size={10} /> : i + 1}</span>
                <span className={a.optionText}>
                  <span className={a.optionLabel}>{o.label}</span>
                  {o.description ? <span className={a.optionDesc}>{o.description}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <form
        className={s.own}
        onSubmit={(e) => {
          e.preventDefault();
          write();
        }}
      >
        <input
          className={cx(s.ownInput, 'selectable')}
          value={own}
          placeholder={current.options.length ? 'Or write your own…' : 'Your answer…'}
          aria-label="Write your own answer"
          onChange={(e) => setOwn(e.target.value)}
        />
        {own.trim() ? (
          <Button size="small" variant="primary" type="submit">
            Answer
          </Button>
        ) : current.multiSelect ? (
          <Button size="small" variant="primary" disabled={!chosen.size} onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'done', question: current.question })}>
            Done{chosen.size ? ` (${chosen.size})` : ''}
          </Button>
        ) : null}
      </form>
      {decision ? <div className={a.hint}>Your answer goes on the task, and the plan carries on with what waited on it.</div> : null}
    </div>
  );
}
